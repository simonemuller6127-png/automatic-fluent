# -*- coding: utf-8 -*-
"""FluentAdapter 接口（hfss-harness 的 adapter 插槽模式，调研报告 6.0）。"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class AdapterResult:
    status: str            # ok / failed
    exit_code: int | None
    transcript_path: str
    journal_path: str
    duration_s: float
    timed_out: bool = False


class BaseFluentAdapter(ABC):
    """set_params / run / read_results 的最小接口；本 harness 中
    参数在 render_journal 阶段已注入，execute 只负责“跑 + 抓 transcript”。"""

    @abstractmethod
    def execute(self, cfg: dict, run_dir: str, journal_path: str, attempt: int = 1) -> AdapterResult:
        ...
