# -*- coding: utf-8 -*-
"""runner —— 执行编排：单次运行、分级重试（6.9 第 5 层）、失败打包（第 4 层）、CLI 命令。

降级梯度（6.0）：
  L2 = 本文件 CLI（python run_pipeline.py ...）
  L1 = `run_pipeline.py journal` 只渲染 journal 不执行，交人工 fluent.exe -i 跑
  L0 = Fluent GUI 手工（README 记录 TUI 录制反哺流程）
  L3 = tools/mcp_server.py + skills/aero-fluent
"""
from __future__ import annotations

import argparse
import copy
import os
import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from . import error_rules
from .adapters import JournalFluentAdapter, discover_fluent_exe, release_of
from .config import ROOT, coerce_value, get_by_path, load_config, set_by_path
from .fluent_slot import FluentSlot
from .journal_gen import render_journal
from .post import (compute_coefficients, converged_check, objective_loss,
                   write_results_csv, write_summary_json)
from .feedback import parse_forces_decomposition
from .transcript_parser import (ForceParseError, parse_forces_text,
                                parse_surface_integrals,
                                parse_transcript, transcript_failure)


@dataclass
class RunResult:
    status: str                    # ok / failed
    run_dir: str = ""
    metrics: dict = field(default_factory=dict)
    failure: dict | None = None
    attempt: int = 1
    duration_s: float = 0.0
    summary: dict = field(default_factory=dict)


TAIL_LINES = 200  # 失败打包保留的 transcript 尾部行数（6.9 第 4 层）


def _path_exists(cfg: dict, dotted: str) -> bool:
    cur = cfg
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return False
        cur = cur[part]
    return True


def _apply_params(cfg: dict, params: dict) -> dict:
    for dotted, value in (params or {}).items():
        if not _path_exists(cfg, dotted):
            raise KeyError(f"未知参数路径: {dotted}（必须是配置中已存在的点路径，如 bc.inlet.vmag）")
        set_by_path(cfg, dotted, value)
    return cfg


def _effective(cfg: dict, params: dict, dotted: str):
    if dotted in (params or {}):
        return params[dotted]
    return get_by_path(cfg, dotted)


def _new_run_dir(cfg: dict, run_id: str) -> Path:
    base = run_root_base(cfg)
    base.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    for suffix in ("", "_b", "_c", "_d"):  # 同秒重名防撞
        d = base / f"{ts}{suffix}_{run_id}"
        try:
            d.mkdir(exist_ok=False)
            return d
        except FileExistsError:
            continue
    d = base / f"{ts}_{run_id}_{os.getpid()}_{time.time_ns() % 100000}"
    d.mkdir(parents=True, exist_ok=False)
    return d


def run_root_base(cfg: dict) -> Path:
    return ROOT / "runs" / str(cfg["case"]["name"])


def run_once(cfg: dict, params: dict | None = None, run_id: str = "r1",
             attempt: int = 1, run_dir: Path | None = None) -> RunResult:
    """渲染 journal → 抢许可证锁 → 执行 → 三通道解析 → 落盘。"""
    t0 = time.time()
    cfg = copy.deepcopy(cfg)
    try:
        _apply_params(cfg, params or {})
    except KeyError as e:
        return RunResult(status="failed", failure={
            "step": "<config>", "category": "config",
            "evidence_line": str(e), "auto_retryable": False,
            "suggestion": "参数路径写错（点路径需存在于配置中），修正 optimize.params / --set",
        })

    run_dir = run_dir or _new_run_dir(cfg, run_id)
    journal_path = run_dir / "journal.jou"
    summary: dict = {"run_id": run_id, "attempt": attempt, "run_dir": str(run_dir),
                     "case": cfg["case"]["name"], "mode": cfg["fluent"]["mode"]}

    try:
        journal_text, mesh_path, expected = render_journal(cfg, params, run_id, attempt)
    except Exception as e:  # 模板/配置问题：立刻失败，不打 Fluent
        summary["error"] = str(e)
        write_summary_json(run_dir / "summary.json", summary)
        return RunResult(status="failed", run_dir=str(run_dir), failure={
            "step": "<render>", "category": "config", "evidence_line": str(e),
            "auto_retryable": False,
            "suggestion": "journal 渲染失败：检查模板占位符与配置字段",
        }, summary=summary)
    journal_path.write_text(journal_text, encoding="utf-8")
    summary["journal"] = str(journal_path)

    slot_timeout = min(float(cfg["fluent"]["timeout_s"]), 3600.0)
    try:
        # 许可证是机器级资源：全局锁（所有算例共享一把），避免并发抢证
        with FluentSlot(ROOT / "runs", timeout_s=slot_timeout):
            adapter = JournalFluentAdapter()
            result = adapter.execute(cfg, str(run_dir), str(journal_path), attempt=attempt)
    except Exception as e:
        summary["error"] = f"执行器异常: {e}"
        write_summary_json(run_dir / "summary.json", summary)
        return RunResult(status="failed", run_dir=str(run_dir), duration_s=time.time() - t0,
                         failure={"step": "<adapter>", "category": "crash_timeout",
                                  "evidence_line": str(e), "auto_retryable": True,
                                  "suggestion": "执行器异常（许可证锁/进程启动失败），查看 summary.json"},
                         summary=summary)

    summary["duration_s"] = result.duration_s
    transcript_text = ""
    try:
        transcript_text = Path(result.transcript_path).read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        summary["error"] = f"transcript 读取失败: {e}"

    pt = parse_transcript(transcript_text, expected)
    failure = transcript_failure(pt)
    result_ok_file = (run_dir / "result.ok").exists()
    if failure is None and not result_ok_file:
        failure = error_rules.timeout_failure()
        failure["evidence_line"] = failure.get("evidence_line") or "流程结束但无 result.ok 握手文件（6.9 第 2 层）"
    if result.timed_out:
        # 超时/被杀 = 明确的失败信号：归类为 crash_timeout（6.9 第 3 层分类表）
        tf_ = error_rules.timeout_failure()
        if failure is None:
            failure = tf_
        else:
            failure["category"] = "crash_timeout"
            failure["auto_retryable"] = True

    # ---- 质量摘要（尽量从 mesh/check、mesh/quality 输出提取，缺失不致命）----
    quality = dict(pt.quality)

    def _enrich_kb(failure: dict, text: str) -> dict:
        """Q3：知识库命中 → 给失败对象补 kb_hits（根因解释 + 具体修复指令）。"""
        from . import error_kb
        tail = text.splitlines()[-TAIL_LINES:]
        hits = error_kb.lookup(tail)
        if hits:
            failure = dict(failure)
            failure["kb_hits"] = [{k: h.get(k) for k in
                                   ("id", "category", "cause", "fix", "verify",
                                    "evidence_line")} for h in hits]
        return failure

    if failure is not None:
        failure = _enrich_kb(failure, transcript_text)
        summary["failure"] = failure
        summary["step_status"] = pt.step_status
        write_summary_json(run_dir / "summary.json", summary)
        make_failpack(run_dir, failure, transcript_text, pt)
        return RunResult(status="failed", run_dir=str(run_dir), failure=failure,
                         attempt=attempt, duration_s=time.time() - t0, summary=summary)

    # ---- 受力解析（通道 3：lis 文件优先，transcript 兜底）----
    zones = [cfg["run"]["wall_zone"]]
    force_text = ""
    lis_path = run_dir / cfg["run"]["force_file"]
    if lis_path.exists():
        force_text = lis_path.read_text(encoding="utf-8", errors="replace")
    else:
        force_text = transcript_text
    try:
        forces = parse_forces_text(force_text, zones)
    except ForceParseError as e:
        failure = {"step": "report_forces", "category": "config",
                   "evidence_line": str(e), "auto_retryable": False,
                   "suggestion": "受力报告解析失败：核对 force_report_style 应答序列"
                                 "（references/prompt_calibration.md）"}
        summary["failure"] = failure
        write_summary_json(run_dir / "summary.json", summary)
        make_failpack(run_dir, failure, transcript_text, pt)
        return RunResult(status="failed", run_dir=str(run_dir), failure=failure,
                         attempt=attempt, duration_s=time.time() - t0, summary=summary)

    coeffs = compute_coefficients(forces, cfg["run"]["reference"])
    primary = coeffs.get(zones[0], {})
    metrics = {
        "fx": primary.get("fx"), "fy": primary.get("fy"), "fz": primary.get("fz"),
        "cd": primary.get("cd"), "cl": primary.get("cl"),
        "iter": pt.iter_count,
        "converged": converged_check(cfg["run"]["convergence"], pt.residuals, pt.iter_count),
        "reversed_flow_warnings": pt.reversed_flow_warnings,
    }
    if pt.reversed_flow_warnings:
        from .domain_sizing import check_backflow
        metrics["backflow_suggestion"] = check_backflow(transcript_text)["suggestion"]
    if cfg["run"].get("flux_report"):
        si = parse_surface_integrals(transcript_text)
        zi, zo = cfg["bc"]["inlet"]["zone"], cfg["bc"]["outlet"]["zone"]
        min_, mout = si["mass_flow"].get(zi), si["mass_flow"].get(zo)
        pin = list(si["area_weighted_avg"].get(zi, {}).values())
        pout = list(si["area_weighted_avg"].get(zo, {}).values())
        metrics["mass_flow_inlet"] = min_
        metrics["mass_flow_outlet"] = mout
        if min_ is not None and mout is not None and abs(min_) > 1e-12:
            metrics["mass_imbalance"] = abs(min_ + mout) / abs(min_)
        if pin and pout:
            metrics["dp"] = pin[0] - pout[0]
    # ---- Q4 反馈闭环：阻力分解（压差/粘性）----
    try:
        decomp = parse_forces_decomposition(force_text, zones)
        d0 = decomp.get(zones[0]) or {}
        if d0:
            metrics["fx_pressure"] = d0["pressure"][0]
            metrics["fy_pressure"] = d0["pressure"][1]
            metrics["fx_viscous"] = d0["viscous"][0]
            metrics["force_decomposition"] = {k: list(v) for k, v in d0.items()}
    except Exception:
        pass
    metrics.update({f"residual_{k}": v for k, v in pt.residuals.items()})
    metrics.update({f"quality_{k}": v for k, v in quality.items()})
    if cfg["objective"].get("targets"):
        loss, comp = objective_loss(cfg["objective"], metrics, metrics["converged"])
        metrics["loss"] = loss
        summary["loss_components"] = comp
    # Q4 反馈闭环：调参建议 + 残差历史（E10 3.1 结果趋势的数值化）
    from .feedback import extract_residual_history, generate_hints
    summary["tuning_hints"] = generate_hints(metrics, cfg)
    hist = extract_residual_history(transcript_text)
    if hist:
        write_results_csv(run_dir / "residual_history.csv", [dict(h) for h in hist])
        summary["residual_history_points"] = len(hist)

    summary.update({"metrics": metrics, "coefficients": coeffs,
                    "step_status": pt.step_status, "status": "ok"})
    write_summary_json(run_dir / "summary.json", summary)
    write_results_csv(run_dir / "results.csv", [{"run_id": run_id, "attempt": attempt,
                                                 **{k: v for k, v in metrics.items()},
                                                 "run_dir": str(run_dir)}])
    return RunResult(status="ok", run_dir=str(run_dir), metrics=metrics,
                     attempt=attempt, duration_s=time.time() - t0, summary=summary)


def run_with_retry(cfg: dict, params: dict | None = None, run_id: str = "r1",
                   log=print) -> RunResult:
    """6.9 第 5 层：auto_retryable 失败按类别自动重试；非自动类立即返回附诊断。"""
    retry_cfg = cfg.get("retry") or {}
    work_params = dict(params or {})
    attempt = 0
    last: RunResult | None = None
    while True:
        attempt += 1
        res = run_once(cfg, params=work_params, run_id=f"{run_id}-a{attempt}", attempt=attempt)
        last = res
        if res.status == "ok":
            log(f"    [run] 第 {attempt} 次尝试成功: {res.run_dir}")
            return res
        f = res.failure or {}
        cat = f.get("category", "unknown")
        policy = retry_cfg.get(cat) or {}
        max_n = int(policy.get("max", 0))
        log(f"    [run] 第 {attempt} 次尝试失败 [{cat}] {f.get('evidence_line', '')[:120]}")
        if attempt > max_n:
            log(f"    [run] 类别 {cat} 重试额度({max_n})用尽，停止自动重试")
            return res
        if cat == "divergence":
            scale = float(policy.get("relax_scale", 0.85))
            for key in ("methods.relax_momentum", "methods.relax_k", "methods.relax_epsilon"):
                cur = _effective(cfg, work_params, key)
                if isinstance(cur, (int, float)) and float(cur) > 0.01:
                    work_params[key] = round(float(cur) * scale, 4)
            log(f"    [run] 发散重试：松弛因子 ×{scale}")
        elif cat == "license":
            wait_s = float(policy.get("wait_s", 20))
            log(f"    [run] 许可证忙，等待 {wait_s:.0f}s 后重试")
            time.sleep(wait_s)
        else:  # mesh / crash_timeout：原样重跑
            log(f"    [run] 类别 {cat} 自动重试（原参数）")


def make_failpack(run_dir: Path, failure: dict, transcript_text: str,
                  pt) -> None:
    """6.9 第 4 层：失败自动打包（journal + transcript 尾部 + 诊断），供 LLM/人工关口。"""
    fp = Path(run_dir) / "failpack"
    fp.mkdir(parents=True, exist_ok=True)
    tail = "\n".join(transcript_text.splitlines()[-TAIL_LINES:])
    (fp / "transcript_tail.txt").write_text(tail, encoding="utf-8")
    step_status = getattr(pt, "step_status", {}) or {}
    lines = [
        "# 失败诊断包（6.9 第 4 层，机器生成）",
        "",
        f"- 运行目录：`{run_dir}`",
        f"- 失败步骤：`{failure.get('step')}`",
        f"- 类别：`{failure.get('category')}`",
        f"- 自动可重试：`{failure.get('auto_retryable')}`",
        f"- 证据行：`{failure.get('evidence_line', '')[:300]}`",
        f"- 建议：{failure.get('suggestion', '')}",
        "",
        "## 各步骤哨兵状态",
        "",
        "| 步骤 | 状态 |",
        "|---|---|",
    ]
    lines += [f"| {s} | {st} |" for s, st in step_status.items()]
    kb_hits = failure.get("kb_hits") or []
    if kb_hits:
        lines += ["", "## 知识库命中（根因解释 + 修复指令，Q3）", ""]
        for h in kb_hits:
            lines += [
                f"### [{h.get('id')}] {h.get('category')}",
                f"- 根因解释：{h.get('cause')}",
                f"- 修复指令：**{h.get('fix')}**",
                f"- 验证方法：{h.get('verify')}",
                f"- 证据行：`{h.get('evidence_line', '')[:200]}`",
                "",
            ]
    lines += [
        "",
        "## 下一步（给 LLM/人工的决策表）",
        "",
        "1. category=config → 先看 `transcript_tail.txt` 中最后一个 Error 所在的 TUI 行；",
        "   若是 prompt 应答序列与版本不符，按 `references/prompt_calibration.md` 校准 config.tui.*，不要直接重试。",
        "2. category=divergence/mesh/license/crash_timeout → 交给 runner 分级重试即可。",
        "3. 修复后重跑：`python run_pipeline.py run --config ...`",
        "",
        "## transcript 尾部（最后 %d 行）" % TAIL_LINES,
        "",
        "```",
        tail[-4000:],
        "```",
    ]
    (fp / "diagnosis.md").write_text("\n".join(lines), encoding="utf-8")


# ---------------- CLI ----------------

def _parse_overrides(pairs: list[str] | None) -> dict:
    out: dict = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise SystemExit(f"--set 需要 k=v 形式: {pair}")
        k, v = pair.split("=", 1)
        out[k.strip()] = coerce_value(v)
    return out


def _config_from_args(args) -> dict:
    overrides = _parse_overrides(getattr(args, "set", None))
    if getattr(args, "real", False):
        overrides["fluent.mode"] = "real"
    cfg = load_config(args.config, overrides)
    return cfg


def cmd_run(args) -> int:
    cfg = _config_from_args(args)
    print(f"== 单次运行 case={cfg['case']['name']} mode={cfg['fluent']['mode']} "
          f"template.verified={cfg['template'].get('verified')}")
    res = run_with_retry(cfg, params=_parse_overrides(getattr(args, "param", None)), run_id="single")
    if res.status == "ok":
        m = res.metrics
        print(f"OK  run_dir={res.run_dir}")
        print(f"    fx={m.get('fx'):.6g} fy={m.get('fy'):.6g} cd={m.get('cd'):.6g} "
              f"cl={m.get('cl'):.6g} iter={m.get('iter')} converged={m.get('converged')}")
        if "loss" in m:
            print(f"    loss={m['loss']:.6g}")
        return 0
    print(f"FAILED run_dir={res.run_dir}")
    print(f"    失败: {json.dumps(res.failure, ensure_ascii=False, indent=2)}")
    print(f"    诊断包: {Path(res.run_dir) / 'failpack' / 'diagnosis.md'}")
    return 1


def cmd_journal(args) -> int:
    """L1 支持：只渲染 journal 并给出手跑命令，不经任何执行器。"""
    cfg = _config_from_args(args)
    out = Path(args.out) if args.out else ROOT / "runs" / str(cfg["case"]["name"]) / "emitted"
    out.mkdir(parents=True, exist_ok=True)
    text, _, expected = render_journal(cfg, _parse_overrides(getattr(args, "param", None)), "emitted", 1)
    jp = out / "journal.jou"
    jp.write_text(text, encoding="utf-8")
    print(f"journal 已生成: {jp}")
    print(f"预期步骤: {','.join(expected)}")
    if cfg["fluent"]["mode"] == "real":
        exe = cfg["fluent"].get("exe") or discover_fluent_exe()
        print(f"手跑命令（L1）:\n  cd {out}\n  "
              f"\"{exe}\" {cfg['case']['dim']}{'dp' if cfg['case']['precision'] == 'double' else ''} "
              f"-t{cfg['fluent']['parallel']} -g -i journal.jou")
    else:
        print(f"手跑命令（mock，L1）:\n  cd {out}\n  python \"{ROOT / 'tools' / 'mock_fluent.py'}\" -i journal.jou")
    print("提示: 把 mesh 文件与 journal 放同目录或改用绝对路径后即可交给 fluent.exe（或 GUI）执行。")
    return 0


def cmd_inspect(args) -> int:
    run_dir = Path(args.run_dir)
    summary_p = run_dir / "summary.json"
    if summary_p.exists():
        print(json.dumps(json.loads(summary_p.read_text(encoding="utf-8")),
                         ensure_ascii=False, indent=2))
        return 0
    tr = run_dir / "transcript.log"
    if not tr.exists():
        raise SystemExit(f"运行目录里没有 summary.json / transcript.log: {run_dir}")
    journal = run_dir / "journal.jou"
    expected = []
    if journal.exists():
        from .transcript_parser import parse_expected_steps
        expected = parse_expected_steps(journal.read_text(encoding="utf-8"))
    pt = parse_transcript(tr.read_text(encoding="utf-8", errors="replace"), expected)
    print(json.dumps({"step_status": pt.step_status, "metrics": pt.metrics,
                      "errors": pt.errors[:5], "done": pt.done},
                     ensure_ascii=False, indent=2, default=str))
    return 0


def cmd_optimize(args) -> int:
    from .optimize import run_optimization
    cfg = _config_from_args(args)
    n_trials = args.trials or cfg["optimize"].get("n_trials", 10)
    report = run_optimization(cfg, n_trials=int(n_trials),
                              budget_s=args.budget_s, engine=args.engine)
    print("\n== 优化结果 ==")
    print(f"最佳参数: {json.dumps(report['best']['params'], ensure_ascii=False)}")
    print(f"最佳 loss: {report['best']['loss']:.6g}   运行目录: {report['best']['run_dir']}")
    print(f"明细: {report['out_dir']}")
    return 0


def cmd_pipeline(args) -> int:
    """M7 一键流水线：geometry(可选) → mesh(可选) → solve → optimize(可选) + 汇总报告。"""
    cfg = _config_from_args(args)
    steps: dict = {}
    pipe = cfg.get("pipeline") or {}

    # ---- Step 1: geometry（SpaceClaim 无头；环境门控时可关闭）----
    geo_cfg = pipe.get("geometry") or {"enabled": False}
    if geo_cfg.get("enabled"):
        from .geometry import run_spaceclaim
        work = ROOT / "runs" / str(cfg["case"]["name"]) / "pipeline_geometry"
        print("== [1/3] geometry (SpaceClaim)")
        steps["geometry"] = run_spaceclaim(cfg, work, timeout_s=float(geo_cfg.get("timeout_s", 600)))
        print(f"    ok={steps['geometry'].get('ok')}  detail={steps['geometry']}")
        if not steps["geometry"].get("ok"):
            print("    几何失败：见上条 log；管线终止（几何产物是网格的输入）")
            _write_pipeline_summary(cfg, steps)
            return 1
    else:
        steps["geometry"] = {"skipped": True, "reason": "pipeline.geometry.enabled=false"}

    # ---- Step 2: mesh（参数化网格生成器；watertight 路线见 aeroharness/meshing.py）----
    mesh_cfg = pipe.get("mesh") or {"enabled": False}
    if mesh_cfg.get("enabled"):
        gen = ROOT / mesh_cfg.get("generator", "tools/make_demo_msh.py")
        out = mesh_cfg.get("out", "meshes/channel2d.msh")
        print("== [2/3] mesh generator")
        proc = subprocess.run(
            [sys.executable, str(gen), out, *(mesh_cfg.get("args", []))],
            cwd=str(ROOT), capture_output=True, text=True, timeout=300)
        steps["mesh"] = {"ok": proc.returncode == 0 and Path(ROOT / out).exists(),
                          "out": str(ROOT / out), "returncode": proc.returncode,
                          "log": proc.stdout[-800:] + proc.stderr[-400:]}
        print(f"    ok={steps['mesh']['ok']}  out={out}")
        if not steps["mesh"]["ok"]:
            _write_pipeline_summary(cfg, steps)
            return 1
    else:
        steps["mesh"] = {"skipped": True, "reason": "pipeline.mesh.enabled=false"}

    # ---- Step 3: solve（可选接 optimize）----
    if pipe.get("solve", {"enabled": True}).get("enabled", True):
        print(f"== [3/3] solve (mode={cfg['fluent']['mode']})")
        res = run_with_retry(cfg, run_id="pipeline")
        steps["solve"] = {"status": res.status, "run_dir": res.run_dir,
                           "metrics": res.metrics, "failure": res.failure}
        if res.status != "ok":
            _write_pipeline_summary(cfg, steps)
            print(f"FAILED 求解失败，诊断包见 {Path(res.run_dir) / 'failpack'}")
            return 1
        print(f"    OK fx={res.metrics.get('fx')} cd={res.metrics.get('cd')} "
              f"iter={res.metrics.get('iter')} converged={res.metrics.get('converged')}")
    else:
        steps["solve"] = {"skipped": True}

    opt_cfg = pipe.get("optimize") or {"enabled": False}
    if opt_cfg.get("enabled"):
        from .optimize import run_optimization
        print(f"== [bonus] optimize trials={opt_cfg.get('trials', 10)}")
        rep = run_optimization(cfg, n_trials=int(opt_cfg.get("trials", 10)),
                               budget_s=opt_cfg.get("budget_s"),
                               engine=opt_cfg.get("engine", "auto"))
        steps["optimize"] = {"best": rep["best"], "out_dir": rep["out_dir"],
                              "n_evaluations": len(rep["rows"])}

    _write_pipeline_summary(cfg, steps)
    print(f"== 管线汇总: runs/{cfg['case']['name']}/pipeline_summary.json")
    return 0


def _write_pipeline_summary(cfg: dict, steps: dict) -> None:
    from .post import write_summary_json
    write_summary_json(run_root_base(cfg) / "pipeline_summary.json",
                       {"case": cfg["case"]["name"], "steps": steps,
                        "finished_at": datetime.now().isoformat(timespec="seconds")})


def cmd_doctor(args) -> int:
    cfg_path = args.config or str(ROOT / "configs" / "demo_channel.json")
    overrides = {"fluent.mode": "mock"}  # doctor 冒烟永远先走离线
    cfg = load_config(cfg_path, overrides)
    report: dict = {"python": sys.version.split()[0], "root": str(ROOT)}
    deps = {}
    for mod in ("optuna", "yaml", "mcp"):
        try:
            __import__(mod)
            deps[mod] = "installed"
        except ImportError:
            deps[mod] = "missing(可选)"
    report["deps"] = deps

    exe = discover_fluent_exe()
    report["fluent_exe"] = str(exe) if exe else None
    if exe:
        vd = exe.parts[-5] if len(exe.parts) >= 5 else ""
        report["fluent_release"] = release_of(vd)
    print(f"[doctor] Python {report['python']} | 依赖 {deps}")
    print(f"[doctor] fluent.exe: {report['fluent_exe']}  ({report.get('fluent_release', '未发现')})")

    # 模板渲染自检
    try:
        text, _, expected = render_journal(cfg, {}, "doctor", 1)
        report["template_render"] = {"ok": True, "expected_steps": expected}
        print(f"[doctor] 模板渲染 OK，预期步骤: {','.join(expected)}")
    except Exception as e:
        report["template_render"] = {"ok": False, "error": str(e)}
        print(f"[doctor] 模板渲染失败: {e}")

    # mock 冒烟（M0 自检）
    try:
        res = run_once(cfg, run_id="doctor")
        report["smoke_run"] = {"ok": res.status == "ok", "run_dir": res.run_dir,
                               "metrics": res.metrics, "failure": res.failure}
        if res.status == "ok":
            print(f"[doctor] mock 冒烟通过: cd={res.metrics.get('cd'):.4g} "
                  f"cl={res.metrics.get('cl'):.4g} (run_dir={res.run_dir})")
        else:
            print(f"[doctor] mock 冒烟失败: {res.failure}")
    except Exception as e:
        report["smoke_run"] = {"ok": False, "error": str(e)}
        print(f"[doctor] mock 冒烟异常: {e}")

    out = ROOT / "runs" / "doctor"
    out.mkdir(parents=True, exist_ok=True)
    (out / "doctor_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"[doctor] 报告: {out / 'doctor_report.json'}")
    return 0 if report.get("smoke_run", {}).get("ok") and report["template_render"]["ok"] else 1


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass
    p = argparse.ArgumentParser(prog="run_pipeline",
                                description="aeroharness：Fluent 自动化调参（journal 主路线）")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--config", default=str(ROOT / "configs" / "demo_channel.json"))
        sp.add_argument("--set", action="append", default=[],
                        help="覆盖配置项，点路径 k=v，可多次")
        sp.add_argument("--real", action="store_true", help="强制真实 fluent 模式")

    d = sub.add_parser("doctor", help="环境自检 + mock 冒烟（M0）")
    d.add_argument("--config", default=None)
    d.set_defaults(fn=cmd_doctor)

    r = sub.add_parser("run", help="单次求解（含自动重试）")
    common(r)
    r.add_argument("--param", action="append", default=[], help="临时参数 k=v（点路径）")
    r.set_defaults(fn=cmd_run)

    o = sub.add_parser("optimize", help="optuna 两级试参闭环（M5）")
    common(o)
    o.add_argument("--trials", type=int, default=None)
    o.add_argument("--budget-s", type=int, default=None, dest="budget_s")
    o.add_argument("--engine", default="auto", choices=["auto", "optuna", "builtin"])
    o.set_defaults(fn=cmd_optimize)

    pp = sub.add_parser("pipeline", help="M7 一键管线：geometry→mesh→solve→optimize")
    common(pp)
    pp.set_defaults(fn=cmd_pipeline)

    j = sub.add_parser("journal", help="只渲染 journal（L1 保底入口）")
    common(j)
    j.add_argument("--out", default=None)
    j.add_argument("--param", action="append", default=[])
    j.set_defaults(fn=cmd_journal)

    i = sub.add_parser("inspect", help="查看某次运行解析摘要")
    i.add_argument("run_dir")
    i.set_defaults(fn=cmd_inspect)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
