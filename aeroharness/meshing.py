# -*- coding: utf-8 -*-
"""meshing —— M3 网格自动化执行器（watertight 工作流，datamodel 路线）。

v222 真机校准（2026-09-20 骨架 + 2026-09-24 真实飞机 STEP 补全）：
  ✅ workflow.InitializeWorkflow(WorkflowType='Watertight Geometry') 可用；
  ✅ 任务链 workflow.TaskObject['...'].Arguments/.Execute() 可用；
  ✅ 任务链共 11 个任务：Import Geometry / Add Local Sizing / Generate the
     Surface Mesh / Describe Geometry / Apply Share Topology / Enclose Fluid
     Regions (Capping) / Update Boundaries / Create Regions / Update Regions /
     Add Boundary Layers / Generate the Volume Mesh
     —— 注意：**任务链里没有"创建外部计算域"任务**，watertight 假设导入几何
     已含计算域（官方 ahmed 示例导入的是"车+隧道"组合体）。建域须在 CAD 侧完成
     （本项目走 aeroharness/geom_cadquery.py，绕开 SpaceClaim /RunScript 门控）。
  ✅ Import Geometry 参数名是 **'FileName'（无空格）**，不接独立的
     'Length Unit'；传 'File Name' 报 "Failed to update task ... File Name"。
     单位由 CAD 自身声明决定（v222 能识别 STEP 的 MILLI+METRE）。
  ⚠️ CAD 文件带**只读属性**时（微信/邮件下载常见），Fluent 报成
     "File ... not found"——极具误导性，实为权限问题。导入前需 chmod u+w。
  ✅ Size Functions 合法值只有 Curvature / Proximity / Curvature & Proximity
     （**没有 Basic**）；性能旋钮是 MinSize/MaxSize/GrowthRate，不是换尺寸函数。
  ❌ Import Geometry 不支持 STL（官方报错），需 .scdoc/.x_t/.step/.pmdb。
  ⚠️ 2026-09-24 实测：TGrid 的 CADReaders.py 子进程对 2m 盒子常驻约 8GB 内存
     （ConformalFacetingCurvatureMinSize 默认 10mm，曲率细分很吃内存）。
     单次串行运行可行；**连续多次实验会残留孤儿进程累积占满物理内存**，
     表现为 "Out of Memory"。批量跑前务必清理（见 kill_stale_meshing）。
"""
from __future__ import annotations

import os
import re
import stat
import subprocess
import time
from pathlib import Path

from .adapters.journal_adapter import _kill_tree
from .config import ROOT


def _make_writable(path: Path) -> None:
    """去掉只读属性——Fluent 的 CAD 内核以读写方式打开几何文件。"""
    try:
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
    except OSError:
        pass


def kill_stale_meshing(verbose: bool = True, include_tgrid: bool = True) -> int:
    """清理残留的 Fluent/TGrid 进程（批量跑网格前必做）。

    TGrid 的 CADReaders.py 吃内存且异常退出时常留孤儿，累积到物理内存耗尽
    会让后续每次都报 "Out of Memory"（真机 2026-09-24 踩过：单个曾达 10GB）。
    注意 CADReaders 是独立的 python.exe，不叫 fluent.exe，必须按命令行特征匹配。
    """
    killed = 0
    for name in ("fluent.exe", "fl_mpi2220.exe", "mpiexec.exe"):
        try:
            proc = subprocess.run(["taskkill", "/F", "/IM", name, "/T"],
                                  capture_output=True, timeout=60)
            # Windows 中文环境 taskkill 输出是 GBK，用 errors 忽略而非解码失败
            out = (proc.stdout or b"").decode("utf-8", errors="ignore")
            killed += out.count("成功") + out.count("SUCCESS")
        except Exception:  # noqa: BLE001 - 清理是尽力而为，不应中断主流程
            pass

    if include_tgrid:
        # CADReaders.py 以 ANSYS 内置 python.exe 独立运行，按"解释器路径 + 脚本名"
        # 双重特征匹配——只匹配脚本名会误伤命令行里含该字符串的 shell 进程。
        try:
            import psutil
            me = os.getpid()
            for p in psutil.process_iter(["pid", "name", "cmdline"]):
                try:
                    name = (p.info["name"] or "").lower()
                    cl = p.info["cmdline"] or []
                    if (name.startswith("python") and p.info["pid"] != me
                            and any("CADReaders.py" in a for a in cl)):
                        os.kill(p.info["pid"], 9)
                        killed += 1
                except Exception:  # noqa: BLE001 - 进程可能已退出/无权限
                    continue
        except ImportError:
            pass  # 无 psutil 时退化为只清 fluent 系

    if verbose and killed:
        print(f"  已清理 {killed} 个残留网格进程")
    return killed


def _guard(task_name: str) -> str:
    """硬哨兵：任务失败时让 journal 立刻中断（scheme assert 抛错）。

    背景（探针 C 实测）：只靠 "(display '; STEP-OK x')" 软哨兵时，表面网格
    失败后 describe/volume/write 的哨兵照打，missing_steps 为空 → 假通过。

    判据用 **getState()['State']**（成功为 'Up-to-date'），不要用 .Errors：
    实测 .Errors 返回的是 ModelState 对象，无论成功失败都非空，assert 必挂。
    """
    name = task_name.replace("'", "\\'")
    return ('(%py-exec "assert workflow.TaskObject[\'' + name +
            '\'].getState().get(\'State\') != \'Out-of-date\', \'TASK-FAILED: ' +
            name + '\'")\n')


def _mesh_outputs(out_mesh: str) -> list[Path]:
    """网格产物候选路径——v222 的 /file/write-mesh x.msh 实际写出 x.msh.h5。"""
    p = Path(out_mesh)
    return [p, p.with_suffix(p.suffix + ".h5"), Path(str(p) + ".h5")]


def render_meshing_journal(cad_file: str, out_mesh: str,
                           min_size: float = 0.0005, max_size: float = 0.02,
                           growth_rate: float = 1.2,
                           size_function: str = "Curvature",
                           vol_max: float | None = None,
                           local_sizing: list | None = None,
                           boundary_layers: dict | None = None,
                           setup_type: str = "The geometry consists of only fluid regions with no voids",
                           capping_required: str = "No",
                           size_unit: str = "m") -> str:
    """生成 watertight 网格 journal。

    ⚠️ 单位（2026-09-24 根因修复，必读）：
    v222 watertight 工作流的**会话长度单位跟随导入 CAD 声明的单位**。
    我们的域几何由 cadquery 导出、声明 MILLI+METRE，因此**工作流里的一切尺寸
    都按毫米解释**。而本项目的 config 全部用米（物理可读）。
    若把米直接写进 journal，0.02 m 会被当成 0.02 mm——曲率细分小三个数量级，
    一个 200mm 的盒子能吃到 10^8 节点，表现为"20 分钟不完成 / 8GB 内存 /
    Out of Memory"（真机踩过，三种表现同一根因）。
    因此：**config 一律用米，渲染时统一乘 1000 转成 mm**，转换只发生在 _s() 一处。

    v222 真机校准：Import Geometry 用 'FileName' 单参（无空格、无独立单位参数）。
    size_function 合法值仅 Curvature / Proximity / Curvature & Proximity。
    vol_max 映射到 poly-hexcore 的 HexMaxCellLength（体网格单元边长）。
    local_sizing：官方 Add Local Sizing 任务，元素形如
        {"name": "facesize_body", "body_label": "body-1", "size": 0.05, "growth_rate": 1.15}
        或 {"name": "boi_wake", "boi_type": "body-of-influence", "size": 0.8, "growth_rate": 1.15}
        （size 用米；BOI 必须封闭体，用官方 "Repair Body of Influence" 校验）
    boundary_layers：官方 Add Boundary Layers，{"n_layers": 14, "rate": 1.15,
        "transition_ratio": 0.5, "type": "smooth-transition"}（官方 ahmed 示例值）
    """
    cad = str(cad_file).replace("\\", "/")
    outm = str(out_mesh).replace("\\", "/")

    # ---- 唯一的单位转换点：config(米) -> journal(毫米) ----
    k = {"m": 1000.0, "mm": 1.0}[size_unit]

    def _s(meters: float) -> float:
        """米 -> 工作流会话单位（mm）。转换只发生在这里。"""
        v = meters * k
        return round(v, 6)

    size_line = (f"dict(MinSize={_s(min_size)}, MaxSize={_s(max_size)}, "
                 f"GrowthRate={growth_rate}, SizeFunctions='{size_function}')")

    # ---- 局部加密（官方 Add Local Sizing：逐面尺寸 + BOI 身体）----
    local_block = ""
    for item in (local_sizing or []):
        name = item["name"]
        size = _s(item["size"])
        gr = item.get("growth_rate", 1.15)
        if item.get("boi_type"):
            args = (f"dict(AddChild='yes', BOIControlName=r'{name}', "
                    f"BOIType='{item['boi_type']}', BOIGrowthRate={gr}, BOISize={size})")
        else:
            args = (f"dict(AddChild='yes', BOIControlName=r'{name}', "
                    f"BOIFaceLabelList=[r'{item['body_label']}'], "
                    f"BOIGrowthRate={gr}, BOISize={size})")
        local_block += (
            f"(%py-exec \"workflow.TaskObject['Add Local Sizing'].Arguments={args}\")\n"
            f"(%py-exec \"workflow.TaskObject['Add Local Sizing'].Execute()\")\n"
            f"(%py-exec \"workflow.TaskObject['Add Local Sizing'].InsertCompoundChildTask()\")\n"
            f'(display "; STEP-OK local_sizing_{name}")\n(newline)\n')

    # ---- 边界层（官方 Add Boundary Layers）----
    bl_block = ""
    if boundary_layers:
        bl = boundary_layers
        bl_type = bl.get("type", "smooth-transition")
        bl_block = (
            '(%py-exec "workflow.TaskObject[\'Add Boundary Layers\'].AddChildToTask()")\n'
            '(%py-exec "workflow.TaskObject[\'Add Boundary Layers\'].InsertCompoundChildTask()")\n'
            f'(%py-exec "workflow.TaskObject[\'{bl_type}_1\'].Arguments=dict(**{{\'NumberOfLayers\': {bl.get("n_layers", 14)}, \'Rate\': {bl.get("rate", 1.15)}, \'TransitionRatio\': {bl.get("transition_ratio", 0.5)}}})")\n'
            '(%py-exec "workflow.TaskObject[\'Add Boundary Layers\'].Execute()")\n'
            '(display "; STEP-OK boundary_layers")\n(newline)\n')

    vol_args = "dict(VolumeFill='poly-hexcore'"
    if vol_max is not None:
        vol_args += f", VolumeFillControls=dict(HexMaxCellLength={_s(vol_max)})"
    vol_args += ")"

    expected = ["init_workflow", "import_geometry"]
    if local_sizing:
        expected += [f"local_sizing_{i['name']}" for i in local_sizing]
    expected += ["surface_mesh", "describe_geometry", "update_boundaries",
                 "create_regions", "update_regions"]
    if boundary_layers:
        expected.append("boundary_layers")
    expected += ["volume_mesh", "write_mesh"]

    return f"""; @AERO-TEMPLATE mesh_watertight v3 (v222 真实 CAD 校准 + 单位修复，2026-09-24)
; 输入必须 CAD（.step/.x_t/.scdoc）；v222 不支持 STL。
; ⚠️ 尺寸单位：config 用米，此处已 ×1000 转成毫米（工作流会话单位=CAD 声明单位）。
;    run_watertight 会核对 CAD 头的 SI_UNIT 声明与本行标记是否一致，
;    不符立即失败（防止单位错配退化成"慢 20 分钟"）。
;    注意：本注释会被 Fluent 回显进 transcript，勿写可被正则误匹配的示例文本。
; @EXPECTED-UNIT {'mm' if size_unit == 'm' else 'mm'}
; @EXPECTED-STEPS {','.join(expected)}
(%py-exec "workflow.InitializeWorkflow(WorkflowType=r'Watertight Geometry')")
(display "; STEP-OK init_workflow")
(newline)
(%py-exec "workflow.TaskObject['Import Geometry'].Arguments=dict(**{{'FileName': r'{cad}'}})")
(%py-exec "workflow.TaskObject['Import Geometry'].Execute()")
{_guard("Import Geometry")}(display "; STEP-OK import_geometry")
(newline)
{local_block}(%py-exec "workflow.TaskObject['Generate the Surface Mesh'].Arguments=dict(**{{'CFDSurfaceMeshControls': {size_line}}})")
(%py-exec "workflow.TaskObject['Generate the Surface Mesh'].Execute()")
{_guard("Generate the Surface Mesh")}(display "; STEP-OK surface_mesh")
(newline)
(%py-exec "workflow.TaskObject['Describe Geometry'].Arguments=dict(**{{'CappingRequired': '{capping_required}', 'SetupType': '{setup_type}'}})")
(%py-exec "workflow.TaskObject['Describe Geometry'].Execute()")
{_guard("Describe Geometry")}(display "; STEP-OK describe_geometry")
(newline)
(%py-exec "workflow.TaskObject['Update Boundaries'].Execute()")
{_guard("Update Boundaries")}(display "; STEP-OK update_boundaries")
(newline)
(%py-exec "workflow.TaskObject['Create Regions'].Execute()")
(%py-exec "workflow.TaskObject['Update Regions'].Execute()")
{_guard("Update Regions")}(display "; STEP-OK create_regions")
(newline)
(display "; STEP-OK update_regions")
(newline)
{bl_block}(%py-exec "workflow.TaskObject['Generate the Volume Mesh'].Arguments={vol_args}")
(%py-exec "workflow.TaskObject['Generate the Volume Mesh'].Execute()")
{_guard("Generate the Volume Mesh")}(display "; STEP-OK volume_mesh")
(newline)
/file/write-mesh "{outm}"
(display "; STEP-OK write_mesh")
(newline)
(display "; DONE")
(newline)
exit
y
"""


def run_watertight(cfg: dict, workdir: str | Path, cad_file: str,
                   out_mesh: str, timeout_s: float = 1800,
                   mesh_cfg: dict | None = None) -> dict:
    """启动 fluent -meshing 执行 watertight journal。

    mesh_cfg 支持：min_size/max_size/growth_rate/size_function/vol_max/
    local_sizing/boundary_layers/setup_type/capping_required/parallel。
    v222 + STL 输入会明确失败（官方报错）。
    """
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    mesh_cfg = dict(mesh_cfg or {})
    cad_path = Path(cad_file)
    if cad_path.exists():
        _make_writable(cad_path)

    journal = workdir / "mesh.jou"
    journal.write_text(
        render_meshing_journal(
            cad_file, out_mesh,
            min_size=mesh_cfg.get("min_size", 0.0005),
            max_size=mesh_cfg.get("max_size", 0.02),
            growth_rate=mesh_cfg.get("growth_rate", 1.2),
            size_function=mesh_cfg.get("size_function", "Curvature"),
            vol_max=mesh_cfg.get("vol_max"),
            local_sizing=mesh_cfg.get("local_sizing"),
            boundary_layers=mesh_cfg.get("boundary_layers"),
            setup_type=mesh_cfg.get(
                "setup_type",
                "The geometry consists of only fluid regions with no voids"),
            capping_required=mesh_cfg.get("capping_required", "No"),
            size_unit=mesh_cfg.get("size_unit", "m")),
        encoding="utf-8")

    exe = cfg["fluent"].get("exe")
    if not exe:
        from .adapters.journal_adapter import discover_fluent_exe
        exe = discover_fluent_exe()
    if not exe:
        return {"ok": False, "error": "fluent.exe 未发现"}

    nproc = int(mesh_cfg.get("parallel", cfg["fluent"].get("parallel", 1)))
    # 经验：TGrid 吃内存很重，低并行反而更稳（每进程一份 faceting 缓存）
    nproc = max(1, min(nproc, int(mesh_cfg.get("max_parallel", 4))))

    transcript = workdir / "transcript.log"
    t0 = time.time()
    timed_out = False
    with open(transcript, "w", encoding="utf-8", errors="replace") as tf:
        proc = subprocess.Popen(
            [str(exe), "3d", "-meshing", f"-t{nproc}",
             "-g", "-i", str(journal)],
            cwd=str(workdir), stdout=tf, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, text=True)
        try:
            proc.wait(timeout=timeout_s)
            rc = proc.returncode
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_tree(proc.pid)
            rc = proc.returncode

    text = transcript.read_text(encoding="utf-8", errors="replace")

    # ---- 单位断言：工作流会话单位必须与 journal 尺寸语义一致 ----
    # CAD 声明 mm -> 工作流按 mm 解释尺寸。单位错配会让 0.02mm 的曲率细分
    # 退化成"跑 20 分钟不完成"，这里提前失败并指向知识库。
    # 判定依据：优先读 CAD 文件头的 SI_UNIT 声明（权威且稳定）；transcript 里的
    # "length unit" 打印仅作补充——注意 journal 注释会被 Fluent 原样回显进
    # transcript，必须跳过注释行，否则会把注释里的示例文本当成真实单位。
    want_unit = "mm" if mesh_cfg.get("size_unit", "m") == "m" else "mm"
    got_unit = None
    if cad_path.exists():
        try:
            head = cad_path.read_text(encoding="utf-8",
                                      errors="replace")[:400000]
            if re.search(r"SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)", head):
                got_unit = "mm"
            elif re.search(r"SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)", head):
                got_unit = "m"
        except OSError:
            pass
    if got_unit is None:
        for line in text.splitlines():
            s = line.strip()
            if s.startswith(";") or s.startswith(">"):
                continue  # 跳过注释与命令回显
            if "length unit" in s and "[" in s:
                got_unit = s.split("[")[-1].split("]")[0].strip().lower()
                break
    unit_ok = (got_unit is None) or (got_unit == want_unit)
    unit_error = None
    if not unit_ok:
        unit_error = (
            f"单位错配：journal 尺寸按 {want_unit} 语义写，但 CAD 会话单位是 [{got_unit}]。"
            f"差 1000 倍会让曲率细分爆炸（表现为极慢/OOM）。"
            f"处置：让 cadquery 导出 MILLI+METRE 的 STEP（write.step.unit='MM'，"
            f"OCCT 不支持 'M'），config 保持 size_unit='m' 由渲染层换算。")

    # ---- 产物判定：v222 的 /file/write-mesh x.msh 实际写出 x.msh.h5 ----
    produced = [p for p in _mesh_outputs(out_mesh) if p.exists()]
    ok = (rc == 0 and not timed_out and "; DONE" in text
          and bool(produced) and unit_ok)

    # 定量信息：步骤完成情况 + 网格规模（供网格无关性/成本分析）
    from .transcript_parser import parse_expected_steps
    expected = parse_expected_steps(journal.read_text(encoding="utf-8"))
    stats = {}
    for label, pat in (("boundary_nodes", "boundary nodes"),
                       ("boundary_faces", "boundary faces")):
        for line in text.splitlines():
            if pat in line:
                digits = "".join(c for c in line.split(pat)[0].split()[-1]
                                 if c.isdigit())
                if digits:
                    stats[label] = int(digits)
                    break
    missing = [s for s in expected if f"STEP-OK {s}" not in text]

    # 软失败兜底（2026-09-24 真机实测）：Fluent 报
    # "The surface meshing was not successful" / "Free faces still exists" 时，
    # 任务的 getState() 可能不是 Out-of-date，assert 拦不住、哨兵照打 -> 假通过。
    # 这里把这类硬错误映射回对应步骤的 missing，让上层正确判失败。
    soft_fail_markers = (
        ("surface meshing was not successful", "surface_mesh"),
        ("Free faces still exists", "surface_mesh"),
        ("was not succe", "surface_mesh"),
        ("has no faces", "surface_mesh"),
    )
    soft_hits = [step for pat, step in soft_fail_markers if pat in text]
    for step in soft_hits:
        if step not in missing:
            missing.append(step)

    return {"ok": ok, "returncode": rc, "timed_out": timed_out,
            "journal": str(journal), "transcript": str(transcript),
            "out_mesh": str(produced[0]) if produced else None,
            "duration_s": time.time() - t0, "parallel": nproc,
            "missing_steps": missing, "stats": stats,
            "session_unit": got_unit, "unit_ok": unit_ok,
            "unit_error": unit_error}
