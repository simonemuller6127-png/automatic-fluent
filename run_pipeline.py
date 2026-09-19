#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""run_pipeline —— L2 自动化层 CLI 入口（调研报告 6.0 降级梯度的第二层）。

  python run_pipeline.py doctor                       # M0 环境自检 + mock 冒烟
  python run_pipeline.py run    --config configs/demo_channel.json
  python run_pipeline.py optimize --config configs/demo_channel.json --trials 10
  python run_pipeline.py journal --config configs/case_airplane.json --out out/   # L1 保底入口
  python run_pipeline.py inspect runs/case_airplane/20260920_120000_single-a1

真实 Fluent 求解统一加 --real 或在配置里 fluent.mode="real"。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aeroharness.runner import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
