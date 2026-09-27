# -*- coding: utf-8 -*-
"""selftest —— M1 验收的离线全链路自测：mock 算例 + 失败注入 + 解析器 + 重试 + 优化闭环。

运行：python tools/selftest.py   （无网络/无 Fluent/无 optuna 均可跑）
全部通过输出 ALL PASS，任一失败输出 FAIL 与明细，进程退出码非 0。
"""
from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aeroharness import error_rules  # noqa: E402
from aeroharness import journal_gen  # noqa: E402
from aeroharness import runner as R  # noqa: E402
from aeroharness.config import CONFIG_DEFAULTS, _deep_merge, load_config  # noqa: E402
from aeroharness.fluent_slot import FluentSlot, SlotBusy  # noqa: E402
from aeroharness.optimize import run_optimization  # noqa: E402
from aeroharness.transcript_parser import (ForceParseError, parse_forces_text,  # noqa: E402
                                           parse_transcript)

PASS, FAIL = [], []


def check(name: str, cond: bool, detail: str = ""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" —— {detail}" if detail and not cond else ""))


def demo_cfg(**over) -> dict:
    cfg = load_config(ROOT / "configs" / "demo_channel.json")
    cfg["case"]["name"] = "selftest_demo"
    from aeroharness.config import set_by_path
    for k, v in over.items():
        if "." in k:
            set_by_path(cfg, k, v)
        else:
            cfg = _deep_merge(cfg, {k: v})
    return cfg


def with_env(**kv):
    saved = {k: os.environ.get(k) for k in kv}
    os.environ.update({k: str(v) for k, v in kv.items()})

    def restore():
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return restore


# ---------------- 1. 配置层 ----------------
def test_config():
    print("[1] 配置层")
    cfg = demo_cfg()
    check("默认值深合并", cfg["bc"]["outlet"]["gauge_pressure"] == 0.0
          and cfg["objective"]["weights"]["cd"] == 1.0)
    cfg2 = _deep_merge(CONFIG_DEFAULTS, {"bc": {"inlet": {"vmag": 300}}})
    check("嵌套覆盖不丢兄弟键", cfg2["bc"]["inlet"]["turb_intensity"] == 5.0
          and cfg2["bc"]["inlet"]["vmag"] == 300)
    try:
        load_config(ROOT / "configs" / "no_such_file.json")
        check("缺失配置报错", False)
    except Exception:
        check("缺失配置报错", True)


# ---------------- 2. journal 生成 ----------------
def test_journal_gen():
    print("[2] journal 生成")
    cfg = demo_cfg()
    text, mesh, expected = journal_gen.render_journal(cfg, {"bc.inlet.vmag": 260.0}, "t", 1)
    check("占位符全部填充", "{{" not in text)
    check("预期步骤齐全", all(s in expected for s in
          ["read_mesh", "setup_models", "bc_inlet", "bc_outlet", "initialize",
           "iterate", "report_forces", "mesh_check"]), str(expected))
    check("调参进入 PARAM 快照", "; PARAM bc.inlet.vmag=260" in text)
    check("vmag 写入 TUI 行", "260" in text and "velocity-inlet" in text)
    check("k-epsilon 应答写入", "ke-standard yes" in text)

    cfg2 = demo_cfg(**{"methods.enabled": True, "physics.gravity": [0, 0, -9.81]})
    text2, _, exp2 = journal_gen.render_journal(cfg2, {}, "t2", 1)
    check("methods/gravity 段按需出现",
          "discretization-scheme/pressure 2" in text2 and "gravity yes 0 0 -9.81" in text2
          and "methods" in exp2 and "gravity" in exp2)

    cfg3 = demo_cfg(**{"methods.enabled": False})
    text3, _, exp3 = journal_gen.render_journal(cfg3, {}, "t3", 1)
    check("空段整体删除（无 methods 哨兵）", "STEP-OK methods" not in text3 and "methods" not in exp3)


# ---------------- 3. 解析器 ----------------
def test_parser():
    print("[3] transcript / 受力解析器")
    tr = """
> /file/read-mesh "x.msh"
; STEP-OK read_mesh
> /define/models/viscous/ke-standard yes
; STEP-OK setup_models
> /define/boundary-conditions/set/velocity-inlet inlet () vmag yes 200 ()
Error: invalid input [vmag-yes]
> /solve/iterate 100
 iter  continuity  x-velocity  y-velocity      k  epsilon
    10  2.3e-04  1.2e-05  3.4e-06  5.6e-07  7.8e-07
; STEP-OK iterate
; DONE
"""
    pt = parse_transcript(tr, ["read_mesh", "setup_models", "bc_inlet", "iterate"])
    check("错误归属到第一个未完成步骤", pt.step_status.get("bc_inlet") == "failed"
          and pt.step_status.get("setup_models") == "ok", str(pt.step_status))
    rec = error_rules.classify_lines([e["text"] for e in pt.errors])
    check("错误分类=config 且不可自动重试", rec and rec["category"] == "config"
          and rec["auto_retryable"] is False, str(rec))
    check("残差提取", abs(pt.residuals.get("continuity", 0) - 2.3e-4) < 1e-9)

    tr2 = "nothing here"
    pt2 = parse_transcript(tr2, ["read_mesh"])
    check("全缺步骤=missing", pt2.step_status["read_mesh"] == "missing")

    lis_a = " Zone Name        x-Force      y-Force      z-Force\n" \
            " wall.feiiji   -1.234e+02   6.780e+01   9.100e-01\n"
    f1 = parse_forces_text(lis_a, ["wall.feiiji"])
    check("受力格式A(表格)", abs(f1["wall.feiiji"][0] + 123.4) < 1e-6)

    lis_b = "   Forces on wall\n    Total force - x:  -1.234567e+02\n" \
            "    Total force - y:  +6.789012e+01\n    Total force - z:  +0.0e+00\n"
    f2 = parse_forces_text(lis_b, ["wall"])
    check("受力格式B(键值)", abs(f2["wall"][1] - 67.89012) < 1e-6)

    try:
        parse_forces_text("garbage", ["wall"])
        check("受力解析失败必须报错", False)
    except ForceParseError:
        check("受力解析失败必须报错", True)


# ---------------- 4. 许可证锁 ----------------
def test_slot():
    print("[4] FluentSlot 许可证锁")
    with tempfile.TemporaryDirectory() as td:
        s1 = FluentSlot(td)
        s1.acquire()
        try:
            s2 = FluentSlot(td, timeout_s=1.0, poll_s=0.1)
            s2.acquire()
            check("占用时第二次抢锁阻塞", False)
        except SlotBusy:
            check("占用时第二次抢锁阻塞", True)
        s1.release()
        s3 = FluentSlot(td)
        s3.acquire()
        check("释放后可复用", True)
        s3.release()
        # 僵尸锁（pid 不存在）自动接管
        (Path(td) / "fluent_slot.lock").write_text("999999999|1.0", encoding="utf-8")
        s4 = FluentSlot(td)
        s4.acquire()
        s4.release()
        check("僵尸锁自动接管", True)


# ---------------- 5. mock 全链路 + 失败注入 ----------------
def test_mock_pipeline():
    print("[5] mock 全链路")
    restore = with_env(AERO_MOCK_FAIL="", AERO_MOCK_FAIL_TIMES="999999")
    try:
        # 参数取真值，端到端验证“配置参数 → journal → mock → 解析 → 系数”链路
        res = R.run_once(demo_cfg(), params={
            "bc.inlet.turb_intensity": 5.0,
            "bc.inlet.turb_viscosity_ratio": 10.0,
            "methods.relax_momentum": 0.9,
        }, run_id="happy")
        check("happy path 成功", res.status == "ok", json.dumps(res.failure, ensure_ascii=False))
        cd, cl = res.metrics.get("cd"), res.metrics.get("cl")
        check("Cd≈0.0386(±1%)", cd is not None and abs(cd - 0.0386) / 0.0386 < 0.01, str(cd))
        check("Cl≈-0.0393(±1%)", cl is not None and abs(cl + 0.0393) / 0.0393 < 0.01, str(cl))
        check("results.csv/summary.json 落盘",
              (Path(res.run_dir) / "results.csv").exists()
              and (Path(res.run_dir) / "summary.json").exists())
    finally:
        restore()

    # 发散注入 1 次 → 分级重试第 2 次成功
    restore = with_env(AERO_MOCK_FAIL="diverge", AERO_MOCK_FAIL_TIMES="1")
    try:
        t0 = time.time()
        res = R.run_with_retry(demo_cfg(), run_id="diverge-retry")
        check("发散自动重试后成功", res.status == "ok" and res.attempt == 2,
              json.dumps(res.failure, ensure_ascii=False))
    finally:
        restore()

    # 发散持续 → 重试额度用尽
    restore = with_env(AERO_MOCK_FAIL="diverge", AERO_MOCK_FAIL_TIMES="99")
    try:
        res = R.run_with_retry(demo_cfg(**{"retry.divergence.max": 1}), run_id="diverge-stuck")
        check("发散重试额度用尽后停止", res.status == "failed"
              and res.failure["category"] == "divergence")
        check("失败打包生成 diagnosis.md",
              (Path(res.run_dir) / "failpack" / "diagnosis.md").exists())
    finally:
        restore()

    # BC 配置错误 → 不可自动重试
    restore = with_env(AERO_MOCK_FAIL="bc", AERO_MOCK_FAIL_TIMES="99")
    try:
        res = R.run_with_retry(demo_cfg(), run_id="bc-bad")
        check("配置类失败不自动重试", res.status == "failed"
              and res.failure["category"] == "config" and res.attempt == 1,
              json.dumps(res.failure, ensure_ascii=False))
    finally:
        restore()

    # 许可证忙 → 等待后重试成功
    restore = with_env(AERO_MOCK_FAIL="license", AERO_MOCK_FAIL_TIMES="1")
    try:
        cfg = demo_cfg(**{"retry.license": {"max": 2, "wait_s": 0.5}})
        res = R.run_with_retry(cfg, run_id="license-retry")
        check("许可证忙等待后重试成功", res.status == "ok" and res.attempt == 2,
              json.dumps(res.failure, ensure_ascii=False))
    finally:
        restore()

    # 读网格失败（坏路径）→ config 类失败
    cfg = demo_cfg(**{"case.mesh_file": "meshes/no_such_mesh.msh"})
    res = R.run_with_retry(cfg, run_id="mesh-bad")
    check("坏网格路径报 config 失败", res.status == "failed"
          and res.failure["category"] == "config")

    # 超时 → crash_timeout
    restore = with_env(AERO_MOCK_SLEEP="30")
    try:
        cfg = demo_cfg(**{"fluent.timeout_s": 5, "retry.crash_timeout.max": 0})
        t0 = time.time()
        res = R.run_with_retry(cfg, run_id="timeout")
        check("超时归类 crash_timeout", res.status == "failed"
              and res.failure["category"] == "crash_timeout"
              and time.time() - t0 < 20, json.dumps(res.failure, ensure_ascii=False))
    finally:
        restore()


# ---------------- 6. 优化闭环 ----------------
def test_optimize():
    print("[6] 优化闭环（合成响应面）")
    cfg = demo_cfg()
    t0 = time.time()
    rep = run_optimization(cfg, n_trials=16, engine="builtin")
    check("builtin 引擎 ≤16 次评估（重复参数去重后允许更少）",
          12 <= len(rep["rows"]) <= 16, str(len(rep["rows"])))
    best = rep["best"]
    check("builtin 收敛到真值附近 (loss<0.1)", best["loss"] < 0.1, f"loss={best['loss']:.4g}")
    p = best["params"]
    check("最优参数接近真值(ti≈5,tvr≈10,relax≈0.9)",
          abs(p["bc.inlet.turb_intensity"] - 5) < 4.0
          and abs(p["bc.inlet.turb_viscosity_ratio"] - 10) < 5.0
          and abs(p["methods.relax_momentum"] - 0.9) < 0.12,
          json.dumps(p))
    print(f"      用时 {time.time()-t0:.1f}s, best loss={best['loss']:.4g}")

    try:
        import optuna  # noqa: F401
        has_optuna = True
    except ImportError:
        has_optuna = False
    if has_optuna:
        rep2 = run_optimization(demo_cfg(), n_trials=16, engine="optuna")
        p2 = rep2["best"]["params"]
        # TPE 特性：少次数内找到最优区域（参数贴近真值）即可；精修交给 pattern search
        check("optuna 引擎找到最优区域 (loss<0.3 且参数贴近真值)",
              rep2["best"]["loss"] < 0.3
              and abs(p2["bc.inlet.turb_intensity"] - 5) < 4.0
              and abs(p2["bc.inlet.turb_viscosity_ratio"] - 10) < 5.0
              and abs(p2["methods.relax_momentum"] - 0.9) < 0.15,
              f"loss={rep2['best']['loss']:.4g} params={json.dumps(p2)}")
    else:
        print("      optuna 未安装，跳过 TPE 引擎用例（pip install optuna 后自动启用）")

    check("trials.csv / best.json / report.md 落盘",
          (Path(rep["out_dir"]) / "trials.csv").exists()
          and (Path(rep["out_dir"]) / "best.json").exists()
          and (Path(rep["out_dir"]) / "report.md").exists())


# ---------------- 7. M2/M1.5/M7 新模块 ----------------
def test_new_modules():
    print("[7] 域尺寸/基线解析/几何参数/管线")
    from aeroharness.domain_sizing import recommend_domain, check_backflow
    dom = recommend_domain(4.0, 1.0, 1.0, kind="aircraft", frontal_area=0.8)
    check("域尺寸：下游≥4×体长", dom.size[0] - 4.0 >= 4.0 * 4.0 - 1e-6, str(dom.size))
    check("域尺寸：堵塞比已计算", dom.blockage is not None and dom.blockage < 0.05,
          str(dom.blockage))
    dom_veh = recommend_domain(4.0, 1.8, 1.5, kind="vehicle")
    check("域尺寸：地面车堵塞比自动扩域", dom_veh.blockage <= 0.05, str(dom_veh.blockage))
    bf = check_backflow("Warning: reversed flow at outlet on 3 faces\n" * 3)
    check("回流告警检测", bf["reversed_flow_warnings"] == 3 and bf["suggestion"])

    from aeroharness.transcript_parser import parse_surface_integrals
    si = parse_surface_integrals(
        "                 Mass Flow Rate               [kg/s]\n"
        "-------------------------------- --------------------\n"
        "                          inlet             0.2450\n"
        "           Area-Weighted Average\n"
        "                 Static Pressure                 [Pa]\n"
        "                          outlet             -12.3\n")
    check("surface-integrals 解析",
          abs(si["mass_flow"]["inlet"] - 0.245) < 1e-9
          and abs(si["area_weighted_avg"]["outlet"]["static-pressure"] + 12.3) < 1e-9,
          str(si))

    from aeroharness.geometry import prepare_params_json
    cfg = demo_cfg()
    cfg["geometry"] = {"auto_domain": True, "kind": "aircraft",
                        "body_bbox": {"length": 4.0, "width": 1.0, "height": 1.0},
                        "frontal_area": 0.8}
    pj = prepare_params_json(cfg, Path(tempfile.mkdtemp()), None)
    geo = json.loads(Path(pj).read_text(encoding="utf-8"))
    check("几何参数自动域计算", "computed" in geo and geo["box"]["size"][0] > 4.0,
          str(geo.get("box")))

    from aeroharness import meshing  # noqa: F401
    j = meshing.render_meshing_journal("D:/x/cad.scdoc", "D:/x/out.msh.h5")
    check("watertight journal 骨架（datamodel 校准版）",
          "InitializeWorkflow" in j and "Import Geometry" in j and "; DONE" in j)


def test_mesh_time():
    print("[8] 网格面数×求解时间联合优化")
    cfg = load_config(ROOT / "configs" / "demo_meshtime.json")
    cfg["case"]["name"] = "selftest_mesh"
    rep = run_optimization(cfg, n_trials=16, engine="builtin")
    best = rep["best"]
    nx = best["params"]["NX"]
    # 理论平衡点：acc≈0.8/NX，cost=0.03·ln(NX/20) → NX*≈27（约 107 单元）
    check("最优网格密度落在成本-精度平衡带 (NX 18~42)", 18 <= nx <= 42, f"NX={nx}")
    check("best 记录面数与精度分量", best["cells"] == nx * 4 and best["accuracy"] is not None,
          str(best))
    check("trials 行含网格成本审计列", any(r.get("mesh_cost") is not None for r in rep["rows"]))
    # 成本项有效性：最优面数应明显小于搜索上限（NX=60 → 240 单元）
    check("成本项抑制了“无脑最密网格”", nx < 55, f"NX={nx}")


def test_mesh_diagnostics():
    print("[9] 网格诊断解析（真机原文夹具） + 负体积根因闸门")
    from aeroharness.transcript_parser import parse_mesh_diagnostics, parse_transcript

    # ---- 夹具 1：真机 v222 实录（runs/demo_channel/20260920_030418_single-a1 原样截取）----
    real_2d = (
        "> /mesh/quality\n\n"
        "Minimum Orthogonal Quality =  1.00000e+00 cell -1 on zone -1 "
        "(ID: 0 on partition: 0) at location ( 2.82976e+20,  7.93162e+34)\n\n"
        "Maximum Aspect Ratio =  4.12311e+00 cell 27 on zone 1000 "
        "(ID: 28 on partition: 0) at location ( 7.50000e-02,  6.25000e-03)\n\n"
        "> (display \"; STEP-OK mesh_check\")\n")
    d2 = parse_mesh_diagnostics(real_2d)
    check("真机2D：正交质量/长宽比数值正确",
          d2.get("min_orthogonal") == 1.0 and abs(d2.get("max_aspect_ratio", 0) - 4.12311) < 1e-9,
          str(d2))
    check("真机2D：cell -1 是哨兵，垃圾坐标必须丢弃",
          "min_orthogonal_location" not in d2 and d2.get("min_orthogonal_cell") == -1,
          str(d2))
    check("真机2D：真实单元坐标保留",
          d2.get("max_aspect_ratio_location") == [0.075, 0.00625], str(d2))

    # ---- 夹具 2：用户真机截图 3D 格式（三分量）----
    shot_3d = (
        "Minimum Orthogonal Quality =  2.86861e-01 cell 18463 on zone 3 "
        "(ID: 13690 on partition: 3) at location "
        "( 1.07846e+00, 1.04442e-01, -2.43722e-01)\n"
        "Maximum Aspect Ratio =  3.35887e+01 cell 20778 on zone 3 "
        "(ID: 8757 on partition: 0) at location "
        "( 8.86668e-01, -5.55940e-01, -1.72690e+00)\n")
    d3 = parse_mesh_diagnostics(shot_3d)
    check("真机3D：分量解析正确",
          abs(d3.get("min_orthogonal", 0) - 0.286861) < 1e-9
          and abs(d3.get("max_aspect_ratio", 0) - 33.5887) < 1e-9, str(d3))
    check("真机3D：三维坐标保留",
          d3.get("min_orthogonal_location") == [1.07846, 0.104442, -0.243722], str(d3))

    # ---- 夹具 3：负体积警告（WARNING: 开头，ERROR_LINE 抓不到）----
    real_neg = ("Info: The mesh contains elements that are invalid or of poor quality.\n"
                "WARNING: 40 cells with non-positive volume detected.\n")
    dn = parse_mesh_diagnostics(real_neg)
    check("负体积计数解析（WARNING: 通道）",
          dn.get("negative_volume") == 40 and dn.get("poor_elements_reported") is True,
          str(dn))
    check("无匹配/空串不抛异常（解析失败不得升级为算例失败）",
          parse_mesh_diagnostics("完全无关的文本") == {} and parse_mesh_diagnostics("") == {})

    # ---- 夹具 4：整条链路（read-case 阶段即报负体积，天然早于 iterate）----
    chain = ("> /file/read-case \"x.msh\"\nBuilding...\n" + real_neg
             + "\n> /solve/iterate 100\n iter continuity\n 1 1.0e-02\n"
             + "\n/solve/iterate 100\n> (display \"; STEP-OK iterate\")\n; STEP-OK iterate\n"
             + "\n/solve/iterate 100\n; DONE\n")
    pt = parse_transcript(chain, ["read_mesh", "iterate"])
    check("parse_transcript 把网格诊断装进 pt.mesh",
          pt.mesh.get("negative_volume") == 40, str(pt.mesh))
    check("负体积警告不污染 pt.errors（警告≠错误，置否交由闸门）",
          not any("non-positive" in e["text"] for e in pt.errors), str(pt.errors))

    # ---- 闸门：根因改判 ----
    cfg = demo_cfg()
    div = {"step": "iterate", "category": "divergence",
           "evidence_line": "Divergence detected in AMG solver", "auto_retryable": True}
    g = R._mesh_gate(cfg, {"negative_volume": 40}, div)
    check("闸门：负体积把 divergence 改判为 mesh 根因",
          g["category"] == "mesh" and g["step"] == "read_mesh", str(g))
    check("闸门：对 config/license 让位（它们才是当次直接阻断原因）",
          R._mesh_gate(cfg, {"negative_volume": 40}, dict(div, category="config"))["category"]
          == "config")
    check("闸门：负体积为 0 时不改判", R._mesh_gate(cfg, {"negative_volume": 0}, div) is div)
    check("闸门：mesh_gate=false 可完全关闭",
          R._mesh_gate(demo_cfg(**{"run.convergence.mesh_gate": False}),
                       {"negative_volume": 40}, div) is div)
    check("闸门：阈值可调（容差内不改判）",
          R._mesh_gate(demo_cfg(**{"run.convergence.max_negative_volume": 40}),
                       {"negative_volume": 40}, div) is div)

    # ---- error_rules / error_kb 接线 ----
    check("error_rules：Read_Grid_Section: Aborted 归 mesh（原先落 config）",
          (error_rules.classify_lines(["Error at Node 1: Read_Grid_Section: Aborted "
                                       "due to critical error."]) or {}).get("category")
          == "mesh")
    from aeroharness import error_kb
    hits = error_kb.lookup(["WARNING: 40 cells with non-positive volume detected."])
    check("error_kb：负体积条目命中且给出根因+修复指令",
          any(h["id"] == "negvol_count_warning" and h["cause"] and h["fix"] for h in hits),
          str([h["id"] for h in hits]))


def test_mesh_gate_end_to_end():
    print("[10] 负体积闸门端到端（mock 静默通过 → 闸门拦截）")
    restore = with_env(AERO_MOCK_FAIL="negvol")
    try:
        cfg = demo_cfg()
        cfg["case"]["name"] = "selftest_negvol"
        res = R.run_with_retry(cfg, run_id="negvol")
    finally:
        restore()
    # mock 在 negvol 下仍会跑完并写 result.ok（模拟真机的"静默通过"），
    # 因此唯一能拦住它的就是闸门
    check("静默通过被闸门拦下（status=failed）", res.status == "failed",
          f"status={res.status}")
    check("根因归类为 mesh 而非 divergence",
          (res.failure or {}).get("category") == "mesh", str(res.failure))
    diag = (res.summary or {}).get("mesh_diagnostics") or {}
    check("summary 落盘网格诊断", diag.get("negative_volume") == 40, str(diag))
    fp = Path(res.run_dir) / "failpack" / "diagnosis.md"
    body = fp.read_text(encoding="utf-8") if fp.exists() else ""
    check("failpack 诊断包含网格诊断小节与坏单元坐标",
          "网格诊断" in body and "负体积单元数：40" in body
          and "最大长宽比" in body, body[:200])
    # 关闭闸门后应恢复为"通过"，证明阈值是唯一拦截点
    restore2 = with_env(AERO_MOCK_FAIL="negvol")
    try:
        cfg2 = demo_cfg()
        cfg2["case"]["name"] = "selftest_negvol_off"
        cfg2["run"]["convergence"]["mesh_gate"] = False
        res2 = R.run_with_retry(cfg2, run_id="negvolf")
    finally:
        restore2()
    check("mesh_gate=false 后放行（证明拦截点唯一、可回退）", res2.status == "ok",
          f"status={res2.status} failure={res2.failure}")


def test_mesh_post():
    print("[11] mesh_post：两面区识别 + Thread Variables 补丁 + BC 侧面板")
    try:
        from aeroharness import mesh_post
    except ImportError as exc:
        check("mesh_post 可导入（h5py 可选依赖）", False, str(exc))
        return

    # ---- 1) 纯文本补丁：wall -> interior，字节预算收紧 ----
    blob = ('(0 "Zone variables:")\n'
            '(39 (101 wall pad_x0:1)(\n))\n'
            '(39 (102 wall pad_x0-pad_b)(\n))\n'
            '(39 (103 interior interior--pad_b)(\n))\n')
    new_blob, changed = mesh_post._patch_thread_variables(blob, {102})
    check("Thread Variables 补丁：只改目标 zone",
          changed == [102] and "(102 interior pad_x0-pad_b)" in new_blob
          and "(101 wall pad_x0:1)" in new_blob, new_blob)
    check("Thread Variables 补丁：预算收紧（空内层表）",
          ")(\n))" not in new_blob and len(new_blob) < len(blob) + 8, "")

    # ---- 2) 合成 .msh.h5 端到端：识别两面区 + 双层补丁 + 自检 ----
    import h5py
    import numpy as np
    tmp = Path(tempfile.mkdtemp())
    src = tmp / "mini.msh.h5"
    with h5py.File(src, "w") as f:
        zt = f.create_group("meshes/1/faces/zoneTopology")
        # 3 个面区：101 单面(wall 边界) / 102 两面(wall 界面, 需补) / 103 原生 interior
        zt.create_dataset("id", data=np.array([101, 102, 103], dtype=np.int32))
        zt.create_dataset("zoneType", data=np.array([3, 3, 2], dtype=np.int32))
        zt.create_dataset("faceType", data=np.array([5, 5, 5], dtype=np.int32))
        joined = ";".join(["pad_a:1", "pad_a-pad_b", "interior--pad_b"])
        zt.create_dataset("name", data=np.array([joined.encode()], dtype=f"S{len(joined)+8}"))
        # c0/c1 按行号 1..3 组织；c1 非零 = 两面
        f["meshes/1/faces/c0/1"] = np.array([1, 2], dtype=np.uint32)
        f["meshes/1/faces/c1/1"] = np.array([0, 0], dtype=np.uint32)
        f["meshes/1/faces/c0/2"] = np.array([1, 2], dtype=np.uint32)
        f["meshes/1/faces/c1/2"] = np.array([1, 2], dtype=np.uint32)
        f["meshes/1/faces/c0/3"] = np.array([1, 2, 3], dtype=np.uint32)
        f["meshes/1/faces/c1/3"] = np.array([1, 2, 3], dtype=np.uint32)
        blob_full = ('(0 "Zone variables:")\n'
                     '(39 (101 wall freeparts-pad_a:1)(\n))\n'
                     '(39 (102 wall freeparts-pad_a-pad_b)(\n))\n'
                     '(39 (103 interior interior--pad_b)(\n))\n')
        tv = f.create_group("settings").create_dataset(
            "Thread Variables",
            data=np.array([blob_full.encode()], dtype=f"S{len(blob_full)+64}"))
        _ = tv
    rep = mesh_post.patch_msh_zones(src, log=None)
    check("mesh_post 端到端：两面区自动识别并补丁",
          rep.get("ok") and rep.get("patched") == [102],
          str(rep))
    check("mesh_post 输出命名保持 .msh.h5",
          rep.get("ok") and rep["out_mesh"].endswith("_patched.msh.h5"), str(rep))
    check("mesh_post 原网格未被修改", src.exists(), "")
    with h5py.File(rep["out_mesh"], "r") as f2:
        zt2 = f2["meshes/1/faces/zoneTopology"]
        check("mesh_post 自检：补丁后 zoneType 生效",
              int(zt2["zoneType"][1]) == 2 and int(zt2["zoneType"][0]) == 3, "")
        tv2 = f2["settings/Thread Variables"][0].decode()
        check("mesh_post 自检：Thread Variables 同步",
              "(102 interior pad_a-pad_b)" in tv2 and "(101 wall freeparts-pad_a:1)" in tv2,
              tv2[:200])

    # ---- 3) 输出命名守卫 ----
    check("default_out_path：.msh.h5 后缀守卫",
          mesh_post.default_out_path("a/b/case.msh.h5").name == "case_patched.msh.h5"
          and mesh_post.default_out_path("a/b/case.h5").name.endswith(".msh.h5"), "")

    # ---- 4) BC 侧面板 journal 生成 ----
    cfg = {"tui": {}, "physics": {"model": "ke-standard"},
           "bc": {"inlet": {"zone": "in:1", "type": "velocity-inlet", "vmag": 50.0,
                            "turb_intensity": 5.0, "turb_viscosity_ratio": 10.0,
                            "set_type": True},
                  "outlet": {"zone": "out:1", "type": "pressure-outlet",
                             "gauge_pressure": 0.0, "set_type": True},
                  "side_inlet_zones": ["s1:1", "s2:1"]}}
    bc = journal_gen.build_bc_lines(cfg)
    joined = "\n".join(bc)
    check("BC 侧面板：zone-type + 同值 velocity-inlet",
          "/mesh/modify-zones/zone-type s1:1 velocity-inlet" in joined
          and "/define/boundary-conditions/set/velocity-inlet s2:1 () vmag no 50" in joined
          and joined.count("turb-viscosity-ratio") == 3, joined)
    # 无侧面板配置的旧算例不受影响
    cfg2 = copy.deepcopy(cfg)
    cfg2["bc"].pop("side_inlet_zones")
    bc2 = journal_gen.build_bc_lines(cfg2)
    check("BC 无侧面板配置：向后兼容",
          len(bc2) == 4 and not any("s1:1" in l for l in bc2), str(bc2))


def main() -> int:
    t0 = time.time()
    print("== aeroharness 离线全链路自测 ==")
    test_config()
    test_journal_gen()
    test_parser()
    test_slot()
    test_mock_pipeline()
    test_optimize()
    test_new_modules()
    test_mesh_time()
    test_mesh_diagnostics()
    test_mesh_gate_end_to_end()
    test_mesh_post()
    print(f"\n== 结果: PASS={len(PASS)} FAIL={len(FAIL)}  用时 {time.time()-t0:.1f}s ==")
    if FAIL:
        print("失败用例: " + ", ".join(FAIL))
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass
    raise SystemExit(main())
