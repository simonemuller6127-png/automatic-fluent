# -*- coding: utf-8 -*-
"""6.9 第 1/3 层：transcript 哨兵解析器 + 受力报告解析器。

三通道设计：
  1) 哨兵标记行（journal 内 (display "; STEP-OK xxx") 主动埋点）
  2) 结果握手文件 result.ok / result.err（存在性由 runner 检查，本模块只管文本）
  3) report 文件导出（forces.lis 表格 / transcript 受力块），解析失败即报错而非给错数
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# 哨兵行不带行尾锚定：实测 Fluent 会把同行第二个 Scheme 表达式当字面文本回显
# （如 "; STEP-OK read_mesh(newline)"），因此只锚定标记名本身。
SENTINEL_OK = re.compile(r"^\s*;\s*STEP-OK\s+([A-Za-z0-9_\-]+)")
SENTINEL_FAIL = re.compile(r"^\s*;\s*STEP-FAIL\s+([A-Za-z0-9_\-]+)")
METRIC_LINE = re.compile(r"^\s*;\s*METRIC\s+(.+)$")
QUALITY_LINE = re.compile(r"^\s*;\s*QUALITY\s+(.+)$")
DONE_LINE = re.compile(r"^\s*;\s*DONE\b")
EXPECTED_STEPS_LINE = re.compile(r"^\s*;\s*@EXPECTED-STEPS\s+(.+)$")

# Fluent 报错行（Error: 开头）与发散行；发散不一定以 Error 开头，单独列出
ERROR_LINE = re.compile(r"^\s*error\b\s*:?\s*(.*)$", re.IGNORECASE)
DIVERGENCE_HINT = re.compile(r"divergence detected", re.IGNORECASE)

FLOAT_RE = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
FORCE_PAIR = re.compile(rf"(Total|Pressure|Viscous)\s+force\s+-\s+([xyz])\s*:\s*({FLOAT_RE})", re.IGNORECASE)
RESID_HEADER = re.compile(r"^\s*(?:iter|iteration)\b(.*)$", re.IGNORECASE)
# 行尾可选 Fluent "time/iter" 列（0:00:00 + 剩余迭代数）；mock 无该列
RESID_ROW = re.compile(rf"^\s*(\d+)\s+((?:{FLOAT_RE}\s+)+){FLOAT_RE}(?:\s+\d+:\d+:\d+)?(?:\s+\d+)?\s*$")

KV_PAIR = re.compile(r"([A-Za-z_][A-Za-z0-9_\-\.]*)\s*=\s*([-+]?[\d\.eE+-]+|true|false|null)")

REVERSED_FLOW = re.compile(r"reversed flow|reverse flow at", re.IGNORECASE)


class ForceParseError(Exception):
    """受力结果解析失败（宁可报错，不给错数）。"""


@dataclass
class ParsedTranscript:
    steps_ok: list[str] = field(default_factory=list)
    step_status: dict = field(default_factory=dict)   # step -> ok / failed / missing
    errors: list[dict] = field(default_factory=list)  # {line_no, text, step}
    metrics: dict = field(default_factory=dict)       # METRIC 行 k=v
    quality: dict = field(default_factory=dict)
    residuals: dict = field(default_factory=dict)     # 最后一次迭代的残差
    iter_count: int = 0
    reversed_flow_warnings: int = 0                    # 出口回流告警计数（Q5 对策闭环）
    done: bool = False


def parse_surface_integrals(text: str) -> dict[str, dict[str, float]]:
    """解析 surface-integrals 报告块（2022R2 格式）：

        Mass Flow Rate               [kg/s]
       -------------------------------- --------------------
                                 outlet                    0

        Area-Weighted Average
              Static Pressure                 [Pa]
       ...
                                 outlet                    0

    返回 {"mass_flow": {zone: value}, "area_weighted_avg": {zone: value}}。
    """
    out: dict[str, dict[str, float]] = {"mass_flow": {}, "area_weighted_avg": {}}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if "Mass Flow Rate" in s and "[kg/s]" in s:
            # 下两行内：zone 名 + 数值
            for j in range(i + 1, min(i + 4, len(lines))):
                m = re.match(rf"^\s*([\w\.\-]+)\s+({FLOAT_RE})\s*$", lines[j])
                if m:
                    out["mass_flow"][m.group(1)] = float(m.group(2))
                    i = j
                    break
        elif "Area-Weighted Average" in s:
            # 表头两行内找到物理量名；再取 zone + 数值
            var = "static-pressure"
            for j in range(i + 1, min(i + 4, len(lines))):
                if "Pressure" in lines[j]:
                    var = "static-pressure"
                m = re.match(rf"^\s*([\w\.\-]+)\s+({FLOAT_RE})\s*$", lines[j])
                if m:
                    out["area_weighted_avg"].setdefault(m.group(1), {})[var] = float(m.group(2))
                    i = j
                    break
        i += 1
    return out


def parse_expected_steps(journal_text: str) -> list[str]:
    for line in journal_text.splitlines():
        m = EXPECTED_STEPS_LINE.match(line)
        if m:
            return [s.strip() for s in m.group(1).split(",") if s.strip()]
    return []


def _parse_kv(text: str) -> dict:
    out = {}
    for k, v in KV_PAIR.findall(text):
        low = v.lower()
        if low in ("true", "false"):
            out[k] = (low == "true")
        elif low == "null":
            out[k] = None
        else:
            try:
                out[k] = float(v)
            except ValueError:
                out[k] = v
    return out


def extract_residuals(text: str) -> tuple[dict, int]:
    """返回 ({方程名: 残差}, 迭代数)。表头行给出方程名，缺表头时用 res_1..n。

    真实 Fluent 行尾带 "0:00:00 剩余迭代数" 列，必须先剥离再取数，
    否则剩余迭代数会被当成最后一个残差（真机实测踩过的坑）。"""
    names: list[str] | None = None
    last: tuple[list[float], int] | None = None
    strip_tail = re.compile(r"\s+\d+:\d+:\d+\s+\d+\s*$")
    for line in text.splitlines():
        mh = RESID_HEADER.match(line)
        if mh and len(mh.group(1).split()) >= 3:
            names = [w for w in mh.group(1).split() if not re.fullmatch(r"[\d\.\-+eE]+", w)]
            continue
        mr = RESID_ROW.match(line)
        if mr:
            row = strip_tail.sub("", line)
            nums = [float(x) for x in re.findall(FLOAT_RE, row)]
            if len(nums) >= 3:  # 首个是迭代号，其后至少 2 个残差
                last = (nums[1:], int(mr.group(1)))
    if not last:
        return {}, 0
    vals, it = last
    if not names or len(names) < len(vals):
        names = [f"res_{i+1}" for i in range(len(vals))]
    return {n: v for n, v in zip(names, vals)}, it


def parse_transcript(text: str, expected_steps: list[str]) -> ParsedTranscript:
    pt = ParsedTranscript()
    seen: set[str] = set()
    current_step: str | None = None
    error_step_names: set[str] = set()

    def _first_unseen() -> str | None:
        for s in expected_steps:
            if s not in seen:
                return s
        return None

    for i, raw in enumerate(text.splitlines(), 1):
        m = SENTINEL_OK.match(raw)
        if m:
            current_step = m.group(1)
            seen.add(current_step)
            pt.steps_ok.append(current_step)
            continue
        m = SENTINEL_FAIL.match(raw)
        if m:
            step = m.group(1)
            reason = raw.strip()[raw.strip().find("reason=") + 7:].strip('"') if "reason=" in raw else ""
            error_step_names.add(step)
            pt.errors.append({"line_no": i, "text": f"STEP-FAIL {step}: {reason}", "step": step})
            continue
        m = METRIC_LINE.match(raw)
        if m:
            pt.metrics.update(_parse_kv(m.group(1)))
            continue
        m = QUALITY_LINE.match(raw)
        if m:
            pt.quality.update(_parse_kv(m.group(1)))
            continue
        if DONE_LINE.match(raw):
            pt.done = True
            continue
        if REVERSED_FLOW.search(raw):
            pt.reversed_flow_warnings += 1
            continue
        if ERROR_LINE.match(raw) or DIVERGENCE_HINT.search(raw):
            # 归属规则：错误行归到“第一个尚未完成的预期步骤”——
            # 例如 inlet 设置报错时 bc_inlet 标记还没出现，应归到 bc_inlet 而不是上一个步骤。
            step = _first_unseen() or current_step
            error_step_names.add(step or "<unknown>")
            pt.errors.append({"line_no": i, "text": raw.strip()[:300], "step": step})

    for step in expected_steps:
        if step in error_step_names:
            pt.step_status[step] = "failed"
        elif step in pt.steps_ok:
            pt.step_status[step] = "ok"
        else:
            pt.step_status[step] = "missing"

    pt.residuals, pt.iter_count = extract_residuals(text)
    return pt


def transcript_failure(pt: ParsedTranscript) -> dict | None:
    """把解析结果归纳成失败对象（若无失败返回 None）。优先级：STEP-FAIL/报错归属 > 缺步 > 无 DONE。"""
    from . import error_rules

    failed = [s for s, st in pt.step_status.items() if st == "failed"]
    missing = [s for s, st in pt.step_status.items() if st == "missing"]
    if pt.errors:
        err = pt.errors[-1]
        rec = error_rules.classify_lines([e["text"] for e in pt.errors] + [""])
        cat = rec["category"] if rec else "unknown"
        auto = rec["auto_retryable"] if rec else (cat == "divergence")
        return {
            "step": err["step"] or (failed[0] if failed else (missing[0] if missing else "<unknown>")),
            "category": cat,
            "evidence_line": err["text"],
            "auto_retryable": auto,
            "suggestion": (rec["suggestion"] if rec else "查看 failpack/transcript 定位"),
        }
    if failed or missing:
        return {
            "step": (failed + missing)[0],
            "category": "step_incomplete",
            "evidence_line": f"STEP-OK 缺失: failed={failed} missing={missing}",
            "auto_retryable": False,
            "suggestion": "某步骤的哨兵标记未出现或被报错打断：看 transcript 对应行，"
                          "若为 TUI 应答序列问题按 references/prompt_calibration.md 校准",
        }
    if not pt.done:
        return {
            "step": "<end>",
            "category": "step_incomplete",
            "evidence_line": "transcript 未出现 ; DONE 标记",
            "auto_retryable": False,
            "suggestion": "journal 未跑完（中途报错或崩溃）：结合握手文件与错误分类定位",
        }
    return None


# ---------------- 受力报告解析（通道 3） ----------------

_ZONE_FLOAT_LINE = re.compile(rf"^(?P<zone>[\w\.:\-]+)\s+(?P<nums>(?:{FLOAT_RE}\s+){{2,}}{FLOAT_RE})\s*$")


def _floats_after_zone(line: str, zone: str) -> list[float] | None:
    idx = line.find(zone)
    if idx < 0:
        return None
    tail = line[idx + len(zone):]
    nums = [float(x) for x in re.findall(FLOAT_RE, tail)]
    if len(nums) >= 3 and all(n == n for n in nums[:3]):  # 过滤 NaN
        return nums[:3]
    return None


def parse_forces_text(text: str, zones: list[str]) -> dict[str, tuple[float, float, float]]:
    """从 forces.lis 表格或 transcript 受力块解析 {zone: (fx, fy, fz)}。

    兼容三种格式：
      A) .lis 表格式：      wall.feiiji    -1.23e+02   6.78e+01   9.10e-01
      B) 键值式：           Total force - x:  -1.23e+02   （逐行 x/y/z）
      C) 2022R2 矢量表：    Net   (px py pz)   (vx vy vz)   (tx ty tz) ...
                             取第三组括号矢量 = Total (fx, fy, fz)
    解析不到 → ForceParseError（fail loud）。
    """
    out: dict[str, tuple[float, float, float]] = {}
    want = set(zones or [])

    # 格式 C：Net 行的三组括号矢量（Pressure/Viscous/Total），Total 为第三组
    vec_triple = re.compile(
        r"^\s*Net\s+\(([^)]+)\)\s+\(([^)]+)\)\s+\(([^)]+)\)", re.IGNORECASE)
    for raw in text.splitlines():
        m = vec_triple.match(raw)
        if m:
            nums = [float(x) for x in re.findall(FLOAT_RE, m.group(3))]
            if len(nums) >= 3:
                key = "<net>"
                if key not in out:
                    out[key] = (nums[0], nums[1], nums[2])

    # 把 <net> 映射到请求的区域（单区域受力场景：Net 即该区域合力）
    if "<net>" in out and zones and len(zones) == 1 and zones[0] not in out:
        out[zones[0]] = out.pop("<net>")

    remaining = [z for z in (zones or []) if z not in out]

    # 格式 A：zone 名 + 一行多个浮点。排除命令回显行（含 "/"、">"、哨兵），
    # 且要求出现带小数点/指数的真浮点（命令回显里的裸整数 "1 0 0" 不算）。
    def _looks_like_float(t: str) -> bool:
        return ("." in t) or ("e" in t.lower())

    for raw in text.splitlines():
        line = raw.strip()
        if not remaining:
            break
        if any(ch in line for ch in ("/", ">", ";")):
            continue
        for zone in list(remaining):
            if zone and zone in line:
                idx = line.find(zone)
                tokens = re.findall(FLOAT_RE, line[idx + len(zone):])
                if len(tokens) >= 3 and any(
                        ("." in t or "e" in t.lower()) for t in tokens[:3]):
                    out[zone] = (float(tokens[0]), float(tokens[1]), float(tokens[2]))
                    remaining.remove(zone)

    # 格式 B：Total force - x/y/z 键值行（离最近出现的 zone 上下文块）
    if remaining:
        current_zone = None
        acc: dict[str, float] = {}
        for raw in text.splitlines():
            line = raw.strip()
            for zone in remaining:
                if zone and zone in line:
                    current_zone = zone
            m = FORCE_PAIR.search(line)
            if m and current_zone:
                acc[m.group(2).lower()] = float(m.group(3))
                if {"x", "y", "z"} <= acc.keys():
                    out[current_zone] = (acc["x"], acc["y"], acc["z"])
                    remaining.remove(current_zone)
                    acc = {}
                    current_zone = None
                    if not remaining:
                        break

    if zones and any(z not in out for z in zones):
        missing = [z for z in zones if z not in out]
        raise ForceParseError(
            f"受力解析失败：在 report 文本中找不到区域 {missing} 的 x/y/z 三个数。"
            f"known_zones={list(out)}。请检查报告是否成功生成（force_report_style 校准项 /"
            f" references/prompt_calibration.md），或把 transcript 尾部贴给 skill 排查。"
        )
    return out
