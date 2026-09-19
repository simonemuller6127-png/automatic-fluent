# -*- coding: utf-8 -*-
"""baseline_check —— M1.5 物理正确性基线校验。

闸门（按调研报告 M1.5 验收“误差 <5% 证明自动化不引入额外误差”的可操作化）：
  1) 质量守恒：|ṁ_in + ṁ_out| / |ṁ_in| ≤ 0.5%（Fluent 官方收敛/质量不平衡判据）；
  2) 收敛判定：harness 残差判据 converged=True；
  3) 参考项（不作为硬闸门）：Δp 与二维泊肃叶解析解 12μL·v/H² 对比，
     入口发展段 L_e≈0.05·Re·H 未覆盖部分会造成偏差，报告中注明。

用法：python tools/baseline_check.py [--config configs/demo_baseline.json] [--mock]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aeroharness import runner as R  # noqa: E402


def analytic_dp(mu: float, L: float, v_bulk: float, H: float, rho: float, Re: float) -> tuple[float, str]:
    """二维泊肃叶充分发展压降 + 入口段提示。"""
    dp = 12.0 * mu * L * v_bulk / (H * H)
    le = 0.05 * Re * H
    note = (f"解析解=充分发展段压降 12μLv/H²={dp:.4g} Pa；入口发展段 L_e≈0.05·Re·H={le:.3g} m"
            + ("（已小于通道长，末端充分发展，但整体平均含入口效应，Δp 实测将偏高，仅供参考）"
               if le < L else "（≥通道长：流动未充分发展，解析对比仅定性）"))
    return dp, note


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "configs" / "demo_baseline.json"))
    ap.add_argument("--mock", action="store_true")
    args = ap.parse_args()

    cfg = R.load_config(args.config)
    if args.mock:
        cfg["fluent"]["mode"] = "mock"
    print(f"== M1.5 基线校验 case={cfg['case']['name']} mode={cfg['fluent']['mode']}")

    res = R.run_with_retry(cfg, run_id="baseline")
    report: dict = {"case": cfg["case"]["name"], "status": res.status}
    if res.status != "ok":
        report["failure"] = res.failure
        (ROOT / "runs" / "baseline_report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"FAILED: {json.dumps(res.failure, ensure_ascii=False)}")
        return 1

    m = res.metrics
    mu_air = 1.7894e-5
    rho = float(cfg["run"]["reference"]["density"])
    v = float(cfg["bc"]["inlet"]["vmag"])
    # 通道几何：层流基线约定 H=0.01m，L=0.5m（与生成网格一致，见 config description）
    H, L = 0.01, 0.5
    Re = rho * v * H / mu_air
    dp_ana, note = analytic_dp(mu_air, L, v, H, rho, Re)

    imbalance = m.get("mass_imbalance")
    dp = m.get("dp")
    gates = {
        "converged": bool(m.get("converged")),
        "mass_imbalance<=0.5%": (imbalance is not None and imbalance <= 0.005),
    }
    dp_dev = None
    if dp is not None:
        dp_dev = abs(dp - dp_ana) / dp_ana
    report.update({
        "run_dir": res.run_dir, "metrics": m,
        "gates": gates,
        "reference": {"analytic_dp_pa": dp_ana, "measured_dp_pa": dp,
                      "dp_deviation": dp_dev, "Re": Re, "note": note},
        "all_pass": all(gates.values()),
    })
    (ROOT / "runs" / "baseline_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"    converged={gates['converged']}  mass_imbalance="
          f"{imbalance if imbalance is None else format(imbalance, '.3%')}"
          f"  Δp实测={dp if dp is None else format(dp, '.4g')} Pa  Δp解析={dp_ana:.4g} Pa"
          f"  (偏差 {None if dp_dev is None else format(dp_dev, '.1%')})")
    print(f"    参考说明: {note}")
    print("ALL PASS" if all(gates.values()) else "GATE FAILED")
    return 0 if all(gates.values()) else 2


if __name__ == "__main__":
    raise SystemExit(main())
