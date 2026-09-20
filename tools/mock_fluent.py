#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""mock_fluent —— 离线 Fluent 批处理仿真器（测试/演示专用，不是真实求解器）。

用途：
  1. 让 aeroharness 全链路（模板渲染 → 批处理执行 → 哨兵解析 → 握手 → 重试 → 优化）
     在没有 Fluent 许可证的机器上完整自测（调研报告 M1 验收的“失败注入测试”）；
  2. 提供一个确定性的合成响应面（最优解在 turb_intensity=5, turb_viscosity_ratio=10,
     relax_momentum=0.9，对应目标 Cd=0.0386 / Cl=-0.0393），验证优化器真的能收敛。

它模仿真实 fluent.exe 的行为轮廓：
  - 解析 `fluent 3d -tN -g -i journal.jou` 同款参数（只关心 -i）；
  - 逐行执行 journal：TUI 行回显、(display ...) 哨兵输出、错误后继续执行后续行
    （与真实 Fluent 批处理一致，这也是解析器要做错误归属的原因）；
  - 产出 forces.lis + transcript 受力块 + result.ok/result.err 握手文件。

失败注入（环境变量）：
  AERO_MOCK_FAIL     = license | read_mesh | bc | diverge | report
  AERO_MOCK_FAIL_TIMES = 前几次尝试注入失败（默认 999999，配合 AERO_ATTEMPT 做重试测试）
  AERO_MOCK_SLEEP    = 启动后睡眠秒数（超时测试）
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
from pathlib import Path

TRUTH = {"turb_intensity": 5.0, "turb_viscosity_ratio": 10.0,
         "relax_momentum": 0.9, "vmag": 200.0}
CD0 = 0.0386
CL0 = -0.0393


def pick(params: dict, *keys, default=None):
    for k in keys:
        if k in params:
            try:
                return float(params[k])
            except (TypeError, ValueError):
                pass
    return default


def parse_journal(path: Path):
    params, markers, tui_lines, n_iter = {}, [], [], 100
    display_marker = re.compile(r'display\s+";\s*(STEP-OK\s+[A-Za-z0-9_\-]+|DONE)\s*"')
    for raw in path.read_text(encoding="utf-8").splitlines():
        s = raw.strip()
        if s.startswith("; PARAM") and "=" in s:
            k, v = s[len("; PARAM"):].strip().split("=", 1)
            params[k.strip()] = v.strip()
            continue
        m = display_marker.search(s)
        if m:
            markers.append("; " + m.group(1))
            continue
        if s.startswith("/solve/iterate"):
            try:
                n_iter = int(float(s.split()[-1]))
            except ValueError:
                pass
            tui_lines.append(("iterate", n_iter))
        elif s.startswith("/"):
            tui_lines.append(("cmd", s))
        elif s == "exit":
            tui_lines.append(("exit", None))
    return params, markers, tui_lines, n_iter


def response_surface(params: dict) -> tuple[float, float]:
    """合成 Cd/Cl 响应面：全局最优在 TRUTH 处，最优值即 CD0/CL0（±确定性小噪声）。"""
    def g(x, x0, lin, quad):
        d = x - x0
        return 1.0 + lin * d + quad * d * d

    ti = pick(params, "bc.inlet.turb_intensity", "turb_intensity", default=TRUTH["turb_intensity"])
    tvr = pick(params, "bc.inlet.turb_viscosity_ratio", "turb_viscosity_ratio",
               default=TRUTH["turb_viscosity_ratio"])
    rm = pick(params, "methods.relax_momentum", "relax_momentum", default=TRUTH["relax_momentum"])

    cd_rel = g(ti, 5, 0.012, 0.02) * g(tvr, 10, 0.006, 0.01) * g(rm, 0.9, -0.2, 4.0)
    cl_rel = g(ti, 5, -0.008, 0.015) * g(tvr, 10, 0.004, 0.008) * g(rm, 0.9, -0.18, 3.0)

    # 网格离散误差（Q：网格面数×时间联合优化的响应面维度）：
    # 网格越粗误差越大（~1/NX，经典一阶离散误差形态），NX 缺省=0 表示网格不参与
    nx = pick(params, "mesh.NX", "NX", default=0)
    if nx and nx > 0:
        disc = 0.5 / nx
        cd_rel *= (1.0 + disc)
        cl_rel *= (1.0 + 0.6 * disc)

    key_src = json.dumps({k: params[k] for k in sorted(params)
                          if any(t in k for t in ("turb", "relax", "vmag"))}, sort_keys=True)
    seed = int(hashlib.md5(key_src.encode("utf-8")).hexdigest()[:8], 16)
    n1 = ((seed % 2000) - 1000) / 1000.0 * 0.003       # ±0.3% 确定性噪声
    n2 = (((seed >> 11) % 2000) - 1000) / 1000.0 * 0.003

    rho = pick(params, "ref_density", default=1.225)
    v = pick(params, "vmag", default=TRUTH["vmag"])
    area = pick(params, "ref_area", default=1.0)
    q = 0.5 * rho * v * v * area
    fx = q * CD0 * cd_rel * (1.0 + n1)      # 阻力沿流动方向（+x），Cd=fx/q>0，与 E10 一致
    fy = q * CL0 * cl_rel * (1.0 + n2)      # Cl 目标为负
    return fx, fy


def main(argv) -> int:
    journal = None
    for i, a in enumerate(argv):
        if a == "-i" and i + 1 < len(argv):
            journal = Path(argv[i + 1])
    if journal is None or not journal.exists():
        print("Error: no journal specified via -i", file=sys.stderr)
        return 1

    fail_mode = os.environ.get("AERO_MOCK_FAIL", "")
    fail_times = int(os.environ.get("AERO_MOCK_FAIL_TIMES", "999999"))
    attempt = int(os.environ.get("AERO_ATTEMPT", "1"))
    sleep_s = float(os.environ.get("AERO_MOCK_SLEEP", "0"))
    do_fail = fail_mode and attempt <= fail_times

    run_dir = Path.cwd()
    params, markers, tui_lines, n_iter = parse_journal(journal)
    wall_zone = str(params.get("wall_zone") or "wall")
    force_file = str(params.get("force_file") or "forces.lis")

    print("Fluent 2022 R2 (MOCK) [3d, spbns, mock-processes] [CFD Solver]")
    print("Welcome to the offline mock of ANSYS Fluent - for harness testing only.")
    if sleep_s > 0:
        time.sleep(sleep_s)

    failed = False
    last_error = ""
    marker_set = set(markers)
    emitted = set()

    def emit_marker(text: str):
        if not failed and text not in emitted:
            emitted.add(text)
            print(text, flush=True)

    def fail(msg: str):
        nonlocal failed, last_error
        failed = True
        last_error = msg
        print(msg, flush=True)
        print(f"; STEP-FAIL mock reason=\"{msg}\"", flush=True)

    if do_fail and fail_mode == "license":
        fail("Error: Unable to acquire license - all licenses are in use (ANSYS License Manager)")
        (run_dir / "result.err").write_text(last_error, encoding="utf-8")
        return 1

    for kind, val in tui_lines:
        if kind == "exit":
            break
        if kind == "cmd":
            line = val
            if "read-case" in line or "read-mesh" in line:
                mesh_path = line.split(None, 2)[-1].strip().strip('"')
                mp = Path(mesh_path)
                if not mp.is_absolute():
                    mp = run_dir / mp
                if not mp.exists():
                    fail(f"Error: Failed to open mesh file {mesh_path}: No such file or directory")
                    continue
                print(line, flush=True)
                nx_mock = pick(params, "mesh.NX", "NX", default=0)
                cells = int(nx_mock * 4) if nx_mock else 2000
                print(f"  Mesh Statistics: cells={cells}, faces={int(cells*2.3)}, "
                      f"nodes={int(cells*0.6)} (mock)", flush=True)
                emit_marker("; STEP-OK read_mesh")
            elif "viscous" in line:
                print(line, flush=True)
                print("  Viscous model set (mock)", flush=True)
                emit_marker("; STEP-OK setup_models")
            elif "operating-conditions" in line:
                print(line, flush=True)
                emit_marker("; STEP-OK gravity")
            elif "velocity-inlet" in line:
                print(line, flush=True)
                if do_fail and fail_mode == "bc":
                    fail("Error: invalid input [vmag-yes] - no such field for this boundary (mock)")
                    continue
                emit_marker("; STEP-OK bc_inlet")
            elif "pressure-outlet" in line:
                print(line, flush=True)
                emit_marker("; STEP-OK bc_outlet")
            elif "initialize-flow" in line:
                print(line, flush=True)
                print("  Initializing flow (standard, mock)", flush=True)
                emit_marker("; STEP-OK initialize")
            elif "discretization-scheme" in line or "under-relaxation" in line:
                print(line, flush=True)
                emit_marker("; STEP-OK methods")
            elif "report/forces" in line:
                print(line, flush=True)
                if do_fail and fail_mode == "report":
                    fail("Error: zone name not found in force report (mock)")
                    continue
                fx, fy = response_surface(params)
                lis = run_dir / force_file
                lis.write_text(
                    "                     Force Report (mock)\n\n"
                    "                       Forces (N)\n"
                    " --------------------------------------\n"
                    " Zone Name            x-Force        y-Force        z-Force\n"
                    " ---------------  ---------------  ---------------  ---------------\n"
                    f" {wall_zone:<16s}  {fx:+.6e}  {fy:+.6e}  +0.000000e+00\n"
                    " -------- Total -------- \n",
                    encoding="utf-8")
                print("   Force report", flush=True)
                print(f"   Forces on {wall_zone}", flush=True)
                print(f"    Total force - x:  {fx:+.6e}", flush=True)
                print(f"    Total force - y:  {fy:+.6e}", flush=True)
                print(f"    Total force - z:  +0.000000e+00", flush=True)
                emit_marker("; STEP-OK report_forces")
            elif "/mesh/check" == line:
                print(line, flush=True)
                print("  Mesh check: Done (mock)", flush=True)
            elif "/mesh/quality" == line:
                print(line, flush=True)
                print("  Minimum Orthogonal Quality is 8.5e-01 (mock)", flush=True)
                print("  Maximum Aspect Ratio is 1.2e+01 (mock)", flush=True)
                print("; QUALITY min_orthogonal=0.85 max_aspect=12 neg_vol=0", flush=True)
                emit_marker("; STEP-OK mesh_check")
            else:
                print(line, flush=True)
        elif kind == "iterate":
            n = int(val)
            print("/solve/iterate " + str(n), flush=True)
            if not failed:
                rm = pick(params, "methods.relax_momentum", "relax_momentum", default=TRUTH["relax_momentum"])
                decay = 0.10 + 0.25 * max(0.0, rm - 0.5)
                print(" iter  continuity  x-velocity  y-velocity      k  epsilon", flush=True)
                for it in range(1, n + 1):
                    if do_fail and fail_mode == "diverge" and it == max(3, int(n * 0.4)):
                        fail("Divergence detected in AMG solver: pressure correction (mock)")
                        break
                    base = 1.0e-2 * math.exp(-decay * it)
                    vals = [max(base * f, 1e-8) for f in (1.0, 0.8, 0.6, 1.5, 1.2)]
                    print(" {:>5d}  {:10.3e}  {:10.3e}  {:10.3e}  {:10.3e}  {:10.3e}".format(it, *vals), flush=True)
                if not failed:
                    emit_marker("; STEP-OK iterate")

    for m in markers:
        if m == "; DONE":
            emit_marker("; DONE")
        elif m.startswith("; STEP-OK"):
            emit_marker(m)

    if failed:
        (run_dir / "result.err").write_text(last_error, encoding="utf-8")
        return 1
    (run_dir / "result.ok").write_text("ok", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
