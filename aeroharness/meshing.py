# -*- coding: utf-8 -*-
"""meshing —— M3 网格自动化执行器（watertight 工作流，datamodel 路线）。

2022R2(v222) 真机探针校准结论（2026-09-20，8 次探针实证，详见校准表）：
  ✅ workflow.InitializeWorkflow(WorkflowType='Watertight Geometry') 可用；
  ✅ 任务链对象 workflow.TaskObject['Import Geometry']/.Execute() 可用；
  ❌ Import Geometry 不支持 STL（官方报错 "Faceted formats, like '.stl' ... not yet
     supported"）——v222 需要 CAD 输入：.scdoc / .pmdb / .x_t / .step（M2 SpaceClaim
     产物即 .scdoc，二者在此衔接）；STL 支持为更新版本能力；
  ❌ /file/read-mesh、/file/read-boundary-mesh 读 STL 报 "no nodes read"
     （它们面向 .msh/边界网格文件，不是 STL）；
  ℹ️ meshing 模式根 TUI 只有少量菜单，工作流一律走 datamodel（py-exec）。

因此 v222 的自动化链路为：SpaceClaim(.scdoc) → 本执行器 → 体网格 → 求解器。
STL 直连路线（升版 Fluent 或 CAD 转换）触发条件见 PyFluentAdapter 同款门控逻辑。
"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

from .adapters.journal_adapter import _kill_tree
from .config import ROOT


def render_meshing_journal(cad_file: str, out_mesh: str, length_unit: str = "m",
                           min_size: float = 0.0005, max_size: float = 0.02,
                           growth_rate: float = 1.2) -> str:
    """生成 watertight 网格 journal（v222 datamodel 校准骨架；导入后的任务链参数
    需在提供真实 CAD 后按 2 分钟录制法（prompt_calibration.md 第 1 节）终校准）。"""
    cad = str(cad_file).replace("\\", "/")
    outm = str(out_mesh).replace("\\", "/")
    return f"""; @AERO-TEMPLATE mesh_watertight v1 (datamodel 路线，v222 骨架已验证)
; 输入必须是 CAD 格式（scdoc/x_t/step）；v222 不支持 STL（官方报错见 meshing.py docstring）
(%py-exec "workflow.InitializeWorkflow(WorkflowType=r'Watertight Geometry')")
(display "; STEP-OK init_workflow")
(newline)
(%py-exec "workflow.TaskObject['Import Geometry'].Arguments=dict(**{{'File Name': r'{cad}', 'Length Unit': r'{length_unit}'}})")
(%py-exec "workflow.TaskObject['Import Geometry'].Execute()")
(display "; STEP-OK import_geometry")
(newline)
(%py-exec "workflow.TaskObject['Generate the Surface Mesh'].Arguments=dict(**{{'CFDSurfaceMeshControls': dict(MinSize={min_size}, MaxSize={max_size}, GrowthRate={growth_rate})}})")
(%py-exec "workflow.TaskObject['Generate the Surface Mesh'].Execute()")
(display "; STEP-OK surface_mesh")
(newline)
(%py-exec "workflow.TaskObject['Describe Geometry'].Execute()")
(display "; STEP-OK describe_geometry")
(newline)
(%py-exec "workflow.TaskObject['Update Regions'].Execute()")
(display "; STEP-OK update_regions")
(newline)
(%py-exec "workflow.TaskObject['Generate the Volume Mesh'].Execute()")
(display "; STEP-OK volume_mesh")
(newline)
/file/write-mesh "{outm}"
(display "; STEP-OK write_mesh")
(newline)
(display "; DONE")
(newline)
exit
"""


def run_watertight(cfg: dict, workdir: str | Path, cad_file: str,
                   out_mesh: str, timeout_s: float = 1800) -> dict:
    """启动 fluent -meshing 执行 watertight journal。v222 + STL 输入会明确失败。"""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    journal = workdir / "mesh.jou"
    journal.write_text(render_meshing_journal(cad_file, out_mesh), encoding="utf-8")

    exe = cfg["fluent"].get("exe")
    if not exe:
        from .adapters.journal_adapter import discover_fluent_exe
        exe = discover_fluent_exe()
    if not exe:
        return {"ok": False, "error": "fluent.exe 未发现"}

    transcript = workdir / "transcript.log"
    t0 = time.time()
    timed_out = False
    with open(transcript, "w", encoding="utf-8", errors="replace") as tf:
        proc = subprocess.Popen(
            [str(exe), "3d", "-meshing", f"-t{int(cfg['fluent'].get('parallel', 1))}",
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
    ok = (rc == 0 and not timed_out and "; DONE" in text
          and Path(out_mesh).exists())
    return {"ok": ok, "returncode": rc, "timed_out": timed_out,
            "journal": str(journal), "transcript": str(transcript),
            "out_mesh": out_mesh if Path(out_mesh).exists() else None,
            "duration_s": time.time() - t0}
