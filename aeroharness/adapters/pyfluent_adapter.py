# -*- coding: utf-8 -*-
"""PyFluentAdapter —— 备用插槽（仅接口与最小示例，不深入开发；调研报告 6.0/6.8.7）。

启用触发条件（满足其一才投入）：
  ① journal 无法结构化读取某类结果且文本解析不可靠；
  ② 升级 Fluent ≥ 2024 R2 后需要 settings/visualization 新能力。

启用成本清单（2022 R2 现实约束，预置备查）：
  ansys-fluent-core==0.12.3 以 --no-deps 安装，传递依赖逐个锁：
    ansys-api-fluent==0.3.5（要求 protobuf~=3.20、grpcio~=1.30）
  + 启动自检 + 提示词约束“只生成 0.12.x API”。
2022 R2 上 0.12.x 本体即 TUI 语法糖，能力增量趋近于零，故默认不装不实现。
"""
from __future__ import annotations

from .base import AdapterResult, BaseFluentAdapter


class PyFluentAdapter(BaseFluentAdapter):
    def __init__(self):
        try:
            import ansys.fluent.core as pyfluent  # noqa: F401
        except ImportError as e:
            raise RuntimeError(
                "PyFluentAdapter 未启用：ansys-fluent-core 未安装。"
                "该插槽默认关闭（journal 主路线不依赖它）；启用步骤见本文件 docstring 与报告 6.8.7。"
            ) from e

    def execute(self, cfg: dict, run_dir: str, journal_path: str, attempt: int = 1) -> AdapterResult:
        raise NotImplementedError(
            "PyFluentAdapter 为备用插槽占位实现；当前版本锁定清单见 docstring。"
            "触发条件未满足前请使用 JournalFluentAdapter。"
        )
