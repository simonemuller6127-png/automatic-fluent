# -*- coding: utf-8 -*-
"""aeroharness —— Fluent 自动化调参 harness（调研报告第 6 节 v2 方案落地）

路线：journal 主路线（L0 底座）+ JournalFluentAdapter（L1 执行器）
     + runner CLI（L2 自动化层）+ mcp_server / skill（L3 接入层）
错误反馈：6.9 五层增强协议（哨兵标记 / 结果握手 / 错误分类器 / 失败打包 / 分级重试）
"""

__version__ = "0.1.0"

ROOT = None  # 由 config.py 在导入时赋值（项目根目录）
