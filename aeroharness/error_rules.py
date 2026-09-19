# -*- coding: utf-8 -*-
"""6.9 第 3 层：错误分类器规则库。

从 transcript 尾部按规则分类为结构化错误对象
{step, category, evidence_line, auto_retryable, suggestion}。
规则库随使用积累（项目记忆），新增规则往 RULES 里追加即可。
"""
from __future__ import annotations

import re

# 规则按序匹配，先命中先得。pattern 对整行做 re.IGNORECASE 搜索。
RULES: list[dict] = [
    {
        "category": "divergence",
        "patterns": [
            r"divergence detected",
            r"\bNaN\b",
            r"floating point exception",
            r"residual[s]?\s+.*\binf(?:inity)?\b",
            r"solution.*(diverged|is diverging)",
        ],
        "auto_retryable": True,
        "suggestion": "下调松弛因子（retry 策略已按 relax_scale 缩放）或换初始化方式后重试（≤2 次）",
    },
    {
        "category": "license",
        "patterns": [
            r"(unable|fail\w*|could not)\s+to\s+.{0,40}licen[cs]e",
            r"licen[cs]e\s+(unavailable|in use|denied|error|checkout|server)",
            r"all\s+licen[cs]es\s+are\s+in\s+use",
            r"ansys.{0,20}licen[cs]e.{0,30}(error|fail|invalid|expire)",
        ],
        "auto_retryable": True,  # 排队后重试（runner 走 license 等待策略）
        "suggestion": "许可证被占用：等待 wait_s 后重试（≤2 次），或检查许可证服务器",
    },
    {
        "category": "mesh",
        "patterns": [
            r"negative volume",
            r"non[- ]positive",
            r"left[- ]handed",
            r"mesh\s+check.{0,20}fail",
            r"failed\s+to\s+(create|mesh|read).{0,30}(mesh|volume|face)",
            r"invalid\s+mesh",
        ],
        "auto_retryable": True,
        "suggestion": "网格质量问题：调整网格尺寸/边界层参数重跑（网格类自动重试 ≤2 次）",
    },
    {
        "category": "config",
        "patterns": [
            r"^\s*error\b\s*:?",
            r"\bno such\b",
            r"\bnot defined\b",
            r"\binvalid\b",
            r"\bunrecognized\b",
            r"is not a recognized",
            r"invalid (input|command|zone|number|name)",
        ],
        "auto_retryable": False,
        "suggestion": "设置类错误（配置矛盾/命令或区域名不对）：不要盲目重试；"
                      "先核对 failpack 里出错的 TUI 行——多数是 prompt 应答序列与版本不符，"
                      "按 references/prompt_calibration.md 校准 tui.* 配置项",
    },
]

_TIMEOUT_CATEGORY = {
    "category": "crash_timeout",
    "evidence_line": "",
    "auto_retryable": True,
    "suggestion": "进程超时/崩溃（无 DONE 标记或无握手文件）：视日志而定，重试 1 次；"
                  "若复现，检查并行核数/内存/超时上限",
}


def classify_lines(lines: list[str]) -> dict | None:
    """对候选行（一般是 transcript 尾部 N 行）做分类，返回结构化错误或 None。"""
    for rule in RULES:
        for line in lines:
            for pat in rule["patterns"]:
                if re.search(pat, line, re.IGNORECASE):
                    return {
                        "category": rule["category"],
                        "evidence_line": line.strip()[:300],
                        "auto_retryable": rule["auto_retryable"],
                        "suggestion": rule["suggestion"],
                    }
    return None


def timeout_failure() -> dict:
    return dict(_TIMEOUT_CATEGORY)
