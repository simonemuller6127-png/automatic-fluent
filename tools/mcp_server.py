#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tools/mcp_server.py —— L3 MCP 桥（stdio，调研报告 6.4/6.5/7.1）。

把 aeroharness 的能力暴露成 MCP 工具，任一支持 MCP 的 agent
（VSCode Cline/Roo、Codex、zcode、Claude Code）即可自然语言驱动：
  aero_doctor     环境自检（M0）
  aero_run        单次求解（含自动重试；plan+confirm 人工关口）
  aero_optimize   试参闭环（optuna 两级；plan+confirm 人工关口）
  aero_pipeline   M7 一键管线 geometry→mesh→solve(→optimize)
  aero_results    读取某次运行的摘要/诊断包

依赖：pip install mcp  （缺 mcp 时本脚本给出明确提示后退出）
注册示例（Codex CLI）：codex mcp add aero-fluent -- python <本文件绝对路径>
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

try:
    try:  # mcp 2.x：FastMCP 更名为 MCPServer
        from mcp.server.mcpserver import MCPServer as _FastMCP
    except ImportError:  # mcp 1.x
        from mcp.server.fastmcp import FastMCP as _FastMCP
    mcp = _FastMCP("aero-fluent")
except ImportError:
    print("未安装 mcp：pip install mcp  （L3 MCP 桥为可选增强；"
          "CLI 路线 python run_pipeline.py 不依赖它）", file=sys.stderr)
    raise SystemExit(1)

from aeroharness import runner as R  # noqa: E402


def _plan_text(cfg: dict, params: dict | None, n_trials: int | None,
               budget_s: int | None) -> str:
    opt = cfg["optimize"]
    lines = [
        f"- 算例: {cfg['case']['name']}  模板: {cfg['template']['solve']} "
        f"(verified={cfg['template'].get('verified')})",
        f"- 执行模式: {cfg['fluent']['mode']}  并行: {cfg['fluent']['parallel']}  "
        f"单次超时: {cfg['fluent']['timeout_s']}s",
        f"- 求解: 模型 {cfg['physics']['model']}  入口 {cfg['bc']['inlet']['vmag']} m/s  "
        f"迭代 {cfg['run']['n_iter']}",
    ]
    if params:
        lines.append(f"- 临时参数: {json.dumps(params, ensure_ascii=False)}")
    if n_trials:
        lines.append(f"- 试参: {n_trials} trials, 搜索空间 "
                     f"{json.dumps(opt['params'], ensure_ascii=False)}, "
                     f"两级预算 coarse_fraction={opt['coarse_fraction']}")
        if budget_s:
            lines.append(f"- 总时长预算: {budget_s}s")
    return "\n".join(lines)


@mcp.tool()
def aero_doctor() -> str:
    """环境自检：Python/依赖/Fluent 发现/mock 冒烟（M0 验收）。"""
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = R.cmd_doctor(type("A", (), {"config": None, "real": False})())
    return "exit=%d\n%s" % (code, buf.getvalue())


@mcp.tool()
def aero_run(config: str, params_json: str = "{}", confirm: bool = False) -> str:
    """单次求解。confirm=false 时只返回执行计划等人工确认（关口规则）。"""
    params = json.loads(params_json or "{}")
    cfg = R.load_config(config, dict(params))
    plan = _plan_text(cfg, params, None, None)
    if not confirm:
        return "【待确认执行计划】\n" + plan + "\n\n确认后请以 confirm=true 重新调用。"
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        param_args = ["%s=%s" % (k, v) for k, v in params.items()]
        code = R.cmd_run(type("A", (), {"config": config, "set": [], "real": False,
                                        "param": param_args})())
    return "exit=%d\n%s" % (code, buf.getvalue())


@mcp.tool()
def aero_optimize(config: str, trials: int = 10, budget_s: int | None = None,
                  confirm: bool = False) -> str:
    """试参闭环（optuna 两级）。confirm=false 时只返回执行计划等人工确认。"""
    cfg = R.load_config(config, {})
    plan = _plan_text(cfg, None, trials, budget_s)
    if not confirm:
        return "【待确认试参计划】\n" + plan + "\n\n确认后请以 confirm=true 重新调用。"
    from aeroharness.optimize import run_optimization
    report = run_optimization(cfg, n_trials=trials, budget_s=budget_s)
    return json.dumps({"best": report["best"], "out_dir": report["out_dir"],
                       "n_evaluations": len(report["rows"])},
                      ensure_ascii=False, indent=2, default=str)


@mcp.tool()
def aero_pipeline(config: str, confirm: bool = False) -> str:
    """M7 一键管线 geometry→mesh→solve(→optimize)。confirm=false 时先返回计划。"""
    cfg = R.load_config(config, {})
    pipe = cfg.get("pipeline") or {}
    geo_on = bool((pipe.get("geometry") or {}).get("enabled"))
    opt_on = bool((pipe.get("optimize") or {}).get("enabled"))
    plan = "\n".join([
        "- 算例: %s" % cfg["case"]["name"],
        "- geometry: %s" % ("执行" if geo_on else "跳过"),
        "- mesh: %s" % str((pipe.get("mesh") or {}).get("generator", "跳过")),
        "- solve: mode=%s iter=%s" % (cfg["fluent"]["mode"], cfg["run"]["n_iter"]),
        "- optimize: %s" % ("trials=%s" % (pipe.get("optimize") or {}).get("trials")
                            if opt_on else "跳过"),
    ])
    if not confirm:
        return "【待确认管线计划】\n" + plan + "\n\n确认后请以 confirm=true 重新调用。"
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = R.cmd_pipeline(type("A", (), {"config": config, "set": [],
                                             "real": False})())
    return "exit=%d\n%s" % (code, buf.getvalue())


@mcp.tool()
def aero_results(run_dir: str) -> str:
    """读取运行目录的 summary.json / failpack 诊断。"""
    p = Path(run_dir)
    out: dict = {}
    summary = p / "summary.json"
    diag = p / "failpack" / "diagnosis.md"
    if summary.exists():
        out["summary"] = json.loads(summary.read_text(encoding="utf-8"))
    if diag.exists():
        out["diagnosis"] = diag.read_text(encoding="utf-8")[:4000]
    return json.dumps(out, ensure_ascii=False, indent=2, default=str)


if __name__ == "__main__":
    mcp.run()  # stdio
