# -*- coding: utf-8 -*-
"""domain_sizing —— 外流场计算域参数化计算器（调研 Q5 落地件）。

问题背景（用户）：不同部件需要的内外流场长宽不一样；要给气流留足通道、出口不能回流。

规则来源（见 docs/external_flow_domain_and_mesh.md 完整引文）：
  - 下游 ≥ 3×体长（推荐 5×）让尾流发展；出口回流的首要对策是加大下游长度，
    其次设置真实的 backflow 湍流量（Fluent User's Guide: Pressure Outlet）。
  - 堵塞比（迎风投影面积/域截面积）≤ 3~5%（文献普遍 3%，汽车类可放宽 5~10% + 修正）。
  - 侧向/顶部分别按体宽/体高的倍数给出；地面车辆底面 = 地面。
  - 网格加密：Body of Influence（BOI）做尾流/局部加密（必须封闭体），曲率/近距
    全局加密 + 边界层；参考 Ansys 官方 watertight 工作流与 A&D 外气动最佳实践。

用法：
    box = recommend_domain(body_len, body_width, body_height, kind="vehicle",
                           frontal_area=None, ground=True)
    # 返回 {origin/size, blockage, warnings[]} —— geometry 步骤与配置生成共用
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

# 倍数规则：以体长 L(流向)、体宽 W、体高 H 为基准。
# upstream/downstream × L；lateral × W（每侧）；top/bottom × H。
RULES: dict[str, dict] = {
    # 地面车辆（Ahmed/整车）：底面贴地
    "vehicle": {"upstream": 2.0, "downstream": 5.0, "lateral": 2.5,
                "top": 3.0, "bottom": "ground"},
    # 飞机（自由体，E10 场景）：E10 自身域 ≈ 下游~1.6L / 侧向~2.3W，教学取小值；
    # 推荐值更保守
    "aircraft": {"upstream": 2.0, "downstream": 4.0, "lateral": 2.0,
                 "top": 2.0, "bottom": 2.0},
    # 钝体（桥梁/建筑/柱体）：尾流回流强，下游更大
    "bluff_body": {"upstream": 3.0, "downstream": 8.0, "lateral": 3.0,
                   "top": 3.0, "bottom": 3.0},
}

BLOCKAGE_LIMITS = {"strict": 0.03, "vehicle": 0.05}  # 文献 3%；地面车辆可放宽并修正


@dataclass
class DomainBox:
    origin: tuple[float, float, float]
    size: tuple[float, float, float]
    blockage: float | None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"origin": list(self.origin), "size": list(self.size),
                "blockage": self.blockage, "warnings": self.warnings}


def recommend_domain(body_len: float, body_width: float, body_height: float,
                     kind: str = "aircraft", frontal_area: float | None = None,
                     ground: bool | None = None,
                     blockage_limit: float | None = None) -> DomainBox:
    """按类型规则给出计算域。body_* 为部件包围盒（流向=x，展向=y，竖向=z）。"""
    if kind not in RULES:
        raise ValueError(f"未知部件类型 {kind}，可选 {list(RULES)}")
    r = RULES[kind]
    L, W, H = float(body_len), float(body_width), float(body_height)
    is_ground = (r["bottom"] == "ground") if ground is None else ground
    warn: list[str] = []

    up = r["upstream"] * L
    down = r["downstream"] * L
    lat = r["lateral"] * W
    top = r["top"] * H
    bottom = (0.2 * H if is_ground else r["bottom"] * H)  # 地面车留 0.2H 离地垫层便于网格

    # 堵塞比校核：迎风面积 = frontal_area 或 H*W 近似；域入口截面 = (2*lat+W) × (top+bottom+H)
    blockage = None
    if frontal_area or (H and W):
        fa = float(frontal_area) if frontal_area else H * W
        cross_w = 2 * lat + W
        cross_h = top + H + bottom
        blockage = fa / (cross_w * cross_h)
        limit = blockage_limit or BLOCKAGE_LIMITS.get(kind, BLOCKAGE_LIMITS["strict"])
        while blockage > limit and lat < 50 * W:  # 自动扩侧向/顶部直到满足
            lat *= 1.3
            top *= 1.2
            if not is_ground:
                bottom *= 1.2
            cross_w = 2 * lat + W
            cross_h = top + H + bottom
            blockage = fa / (cross_w * cross_h)
        if blockage > limit:
            warn.append(f"堵塞比 {blockage:.1%} 仍超限 {limit:.0%}：请加大域或核对迎风面积")

    origin = (-up, -lat, -(bottom))
    size = (up + down + L, 2 * lat + W, top + H + bottom)
    if is_ground:
        origin = (-up, -lat, -bottom)
    # 下游回流提示（Q5）：出口必须远于尾流回流区
    warn.append("出口位置已按 ≥{}×体长 设置；若真跑 transcript 仍出现 reversed flow，"
                "优先再加大 downstream（×1.5）并设置真实 backflow 湍流量".format(r["downstream"]))
    return DomainBox(origin=origin, size=size, blockage=blockage, warnings=warn)


def check_backflow(transcript_text: str) -> dict:
    """统计 transcript 中的回流告警（runtime 对策闭环：警告→建议加大下游）。"""
    import re
    hits = re.findall(r"reversed flow|reverse flow at", transcript_text, re.IGNORECASE)
    return {
        "reversed_flow_warnings": len(hits),
        "suggestion": (None if not hits else
                       "存在出口回流：加大下游长度（domain_sizing downstream ×1.5），"
                       "并设置真实 backflow 湍流强度/粘度比（Fluent Pressure Outlet）"),
    }
