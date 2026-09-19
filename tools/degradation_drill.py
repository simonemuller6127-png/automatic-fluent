# -*- coding: utf-8 -*-
"""degradation_drill —— M7 降级梯度演练（6.0 分层保底的验收动作）。

逐级验证（人为模拟上层失效，确认下一层仍可用）：
  L3  MCP 桥模块可加载、计划/确认关口可用（模拟 MCP 层正常/异常对照）
  L2  CLI run_pipeline.py run 正常出结果
  L1  journal 子命令只出脚本 → 手工执行（mock 顶替 fluent.exe）→ 产物齐全
  L0  GUI 手工 —— 不可脚本化，输出操作指引（TUI 录制反哺）即视为通过

用法：python tools/degradation_drill.py   （全程 mock，不占许可证）
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" —— {detail}" if detail and not cond else ""))


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass
    print("== M7 降级梯度演练（mock） ==")
    report: dict = {}

    # ---- L3：MCP 桥 ----
    print("[L3] MCP 桥")
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "mcp_server", ROOT / "tools" / "mcp_server.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        tools = [t for t in dir(mod) if t.startswith("aero_")]
        check("MCP 工具注册齐全", {"aero_doctor", "aero_run", "aero_optimize",
                                   "aero_results"} <= set(tools), str(tools))
        report["L3"] = {"tools": tools}
    except Exception as e:
        check("MCP 桥加载", False, str(e))

    # ---- L2：CLI ----
    print("[L2] CLI run_pipeline（模拟 MCP 层不可用，直接命令行）")
    r = subprocess.run([sys.executable, str(ROOT / "run_pipeline.py"), "run",
                        "--config", str(ROOT / "configs" / "demo_channel.json")],
                       capture_output=True, text=True, timeout=300)
    check("L2 CLI 单次运行成功", "OK  run_dir=" in r.stdout, r.stdout[-300:] + r.stderr[-200:])
    report["L2"] = {"stdout_tail": r.stdout[-300:]}

    # ---- L1：只出 journal + 手工执行（人工 fluent 的脚本化替身）----
    print("[L1] journal 渲染 + 手工批处理")
    out_dir = ROOT / "runs" / "drill_l1"
    r = subprocess.run([sys.executable, str(ROOT / "run_pipeline.py"), "journal",
                        "--config", str(ROOT / "configs" / "demo_channel.json"),
                        "--out", str(out_dir)], capture_output=True, text=True, timeout=120)
    jou = out_dir / "journal.jou"
    check("L1 journal 已渲染", jou.exists())
    if jou.exists():
        p = subprocess.run([sys.executable, str(ROOT / "tools" / "mock_fluent.py"),
                            "-i", str(jou)], cwd=str(out_dir),
                           capture_output=True, text=True, timeout=120,
                           env={"AERO_ATTEMPT": "1", "PYTHONIOENCODING": "utf-8",
                                "PATH": __import__("os").environ["PATH"],
                                "SYSTEMROOT": __import__("os").environ.get("SYSTEMROOT", "")})
        ok_file = (out_dir / "result.ok").exists()
        check("L1 手工执行产出握手文件", ok_file, p.stdout[-300:])

    # ---- L0：GUI 指引 ----
    print("[L0] Fluent GUI 手工（操作指引即验收物）")
    print("    指引：Fluent 打开 journal.jou 对应参数；或按")
    print("    skills/aero-fluent/references/prompt_calibration.md 第 1 节录制 TUI 反哺模板库")
    check("L0 指引存在（文档化）",
          (ROOT / "skills" / "aero-fluent" / "references" / "prompt_calibration.md").exists())

    (ROOT / "runs" / "degradation_drill_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"\n== 结果: PASS={len(PASS)} FAIL={len(FAIL)}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    raise SystemExit(main())
