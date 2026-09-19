# -*- coding: utf-8 -*-
"""post —— 受力/系数换算、目标函数、结果落盘（CSV/JSON）。"""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path


def compute_coefficients(forces: dict[str, tuple[float, float, float]],
                         reference: dict) -> dict:
    """Cd = Fx/(0.5 ρ v² A)，Cl = Fy/(0.5 ρ v² A)（E10 第 53 页公式，A1 为参考面积）。"""
    rho = float(reference["density"])
    v = float(reference["velocity"])
    area = float(reference["area"])
    q = 0.5 * rho * v * v * area
    out = {}
    for zone, (fx, fy, fz) in forces.items():
        out[zone] = {"fx": fx, "fy": fy, "fz": fz, "cd": fx / q, "cl": fy / q}
    return out


def objective_loss(objective_cfg: dict, metrics: dict, converged: bool | None) -> tuple[float, dict]:
    """coefficient_match：加权相对误差；失败/未收敛可加罚。返回 (loss, 分量)。"""
    targets = objective_cfg.get("targets") or {}
    if not targets:
        raise ValueError("objective.targets 未配置（如 {\"cd\": 0.0386, \"cl\": -0.0393}）")
    weights = objective_cfg.get("weights") or {k: 1.0 for k in targets}
    penalty = float(objective_cfg.get("fail_penalty", 1e6))

    components = {}
    total = 0.0
    for key, target in targets.items():
        if key not in metrics or metrics[key] is None:
            return penalty, {"error": f"目标量 {key} 不在结果里"}
        denom = abs(float(target)) if float(target) != 0 else 1.0
        comp = abs(float(metrics[key]) - float(target)) / denom
        components[key] = comp
        total += float(weights.get(key, 1.0)) * comp

    if objective_cfg.get("require_converged") and converged is False:
        total += penalty * 0.1  # 未收敛软罚
    return total, components


def write_results_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    fieldnames: list[str] = []
    for r in rows:
        for k in r:
            if k not in fieldnames:
                fieldnames.append(k)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fieldnames})


def write_summary_json(path: Path, summary: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2, default=str)


def converged_check(convergence_cfg: dict, residuals: dict, iter_count: int) -> bool | None:
    """全部残差 ≤ target 且迭代数 ≥ min_iter → True；残差缺失 → None（未知）。"""
    target = float(convergence_cfg.get("residual_target", 1e-3))
    min_iter = int(convergence_cfg.get("min_iter", 10))
    if not residuals:
        return None
    if iter_count < min_iter:
        return False
    return all((v == v and v < math.inf) and v <= target for v in residuals.values())
