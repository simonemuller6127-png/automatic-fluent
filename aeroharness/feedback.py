# -*- coding: utf-8 -*-
"""feedback —— 后处理反馈闭环（Q4）：把受力/残差/质量/回流等“看懂”，翻译成下一轮调参动作。

机制（调研报告 6.6 “调=策略决策”的机器侧实现）：
  数值反馈（解析器）→ generate_hints(规则引擎) → tuning_hints（带触发证据的建议）
  → agent/人工确认 → 改 config 参数 → 下一轮 optimize/run
视觉反馈（云图/矢量图）由 post 模板导出 PNG 供人看，数值化反馈（阻力分解/残差历史）
进优化闭环 —— 与报告 4.2 结论一致：视觉是增强，数值通道是主线。
"""
from __future__ import annotations

from .transcript_parser import FLOAT_RE, re


def parse_forces_decomposition(text: str, zones: list[str]) -> dict[str, dict]:
    """从 2022R2 矢量表解析 {zone: {pressure, viscous, total}} 三分量（格式 C）。

    表结构：Net (px py pz) (vx vy vz) (tx ty tz) —— 三个括号组依次为
    Pressure/Viscous/Total 合力矢量。
    """
    out: dict[str, dict] = {}
    vec_row = re.compile(r"^\s*(Net)\s+((?:\([^)]*\)\s*){3})", re.IGNORECASE)
    for raw in text.splitlines():
        m = vec_row.match(raw)
        if not m:
            continue
        groups = re.findall(r"\(([^)]*)\)", m.group(2))
        if len(groups) < 3:
            continue
        vecs = []
        for g in groups[:3]:
            nums = [float(x) for x in re.findall(FLOAT_RE, g)]
            if len(nums) >= 3:
                vecs.append(tuple(nums[:3]))
        if len(vecs) == 3:
            zone = zones[0] if (len(zones) == 1) else m.group(1)
            out[zone] = {"pressure": vecs[0], "viscous": vecs[1], "total": vecs[2]}
    return out


def extract_residual_history(text: str) -> list[dict]:
    """提取全部残差迭代行 → [{iter, continuity, ...}]（E10 3.1 结果趋势的数值化）。"""
    from .transcript_parser import RESID_HEADER, RESID_ROW
    import re as _re
    names: list[str] | None = None
    rows: list[dict] = []
    strip_tail = _re.compile(r"\s+\d+:\d+:\d+\s+\d+\s*$")
    for line in text.splitlines():
        mh = RESID_HEADER.match(line)
        if mh and len(mh.group(1).split()) >= 3:
            names = [w for w in mh.group(1).split()
                     if not _re.fullmatch(r"[\d\.\-+eE]+", w)]
            continue
        if RESID_ROW.match(line):
            row = strip_tail.sub("", line)
            nums = [float(x) for x in _re.findall(FLOAT_RE, row)]
            if len(nums) >= 3:
                vals = nums[1:]
                ns = names or [f"res_{i+1}" for i in range(len(vals))]
                rec = {"iter": int(nums[0])}
                rec.update({n: v for n, v in zip(ns, vals)})
                rows.append(rec)
    return rows


def generate_hints(metrics: dict, cfg: dict) -> list[dict]:
    """规则引擎：指标模式 → 调参建议（每条含触发条件与证据，供 agent/人裁决）。"""
    hints: list[dict] = []

    def add(trigger, detail, action):
        hints.append({"trigger": trigger, "evidence": detail, "action": action})

    fx, fp = metrics.get("fx"), metrics.get("fx_pressure")
    if fx and fp is not None and abs(fx) > 1e-9:
        share = abs(fp) / abs(fx)
        if share > 0.65:
            add("压差阻力占比 {:.0f}%".format(share * 100),
                f"fx={fx:.4g}, fx_pressure={fp:.4g}",
                "分离/尾流主导：加密尾流（mesh.boi / Surface Mesh 加 BOI 尺寸）、"
                "加大下游域（domain_sizing downstream ×1.5）、确认几何无钝角分离源")
        elif share < 0.35:
            add("粘性阻力占比 {:.0f}%".format((1 - share) * 100),
                f"fx={fx:.4g}, fx_viscous={metrics.get('fx_viscous')}",
                "壁面剪切主导：核对 y+ 与第一层网格（Add Boundary Layers NumberOfLayers/"
                "Rate），确认壁面函数与 Re 匹配")
    if metrics.get("reversed_flow_warnings", 0) > 0:
        add("出口回流 {} 次".format(metrics["reversed_flow_warnings"]),
            "transcript reversed flow 告警",
            "下游域 ×1.5；出口设真实 backflow 湍流量（domain_sizing.check_backflow）")
    if metrics.get("converged") is False:
        lim = cfg["run"]["convergence"].get("residual_target")
        add("未达收敛判据", f"residual_continuity={metrics.get('residual_continuity')}",
            f"提高 run.n_iter 或核对收敛目标 {lim}；残差平台则检查网格质量与松弛因子")
    q = metrics.get("quality_min_orthogonal")
    if q is not None and q < 0.2:
        add("网格质量差", f"min_orthogonal={q}",
            "降 MaxSize / 调 GrowthRate / 修几何（SpaceClaim Repair 或 FTM 工作流）")
    cd, cl = metrics.get("cd"), metrics.get("cl")
    tgt = (cfg.get("objective") or {}).get("targets") or {}
    if cd is not None and "cd" in tgt and abs(cd) > 1e-12:
        dev = abs(cd - tgt["cd"]) / abs(tgt["cd"])
        if dev > 0.15:
            add("Cd 偏离参考 {:.0f}%".format(dev * 100),
                f"cd={cd:.4g} vs 目标 {tgt['cd']}",
                "先做网格无关性（optimize 两级预算），再调湍流模型/入口湍流量；"
                "参考面积 A1 按试验/文献复核（E10 明示无统一定论）")
    return hints
