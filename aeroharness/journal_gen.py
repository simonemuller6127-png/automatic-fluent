# -*- coding: utf-8 -*-
"""journal_gen —— L0 主路线核心资产：模板 + {{占位符}} 填充（调研报告 6.8.1）。

铁律：LLM/程序只填参数，不写 journal 语法。所有 prompt 应答序列集中在
config["tui"] 校准项里（references/prompt_calibration.md），模板不硬编码。
"""
from __future__ import annotations

import re
from pathlib import Path

from .config import get_by_path

PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")


def _q(path: str) -> str:
    """journal 内引用路径：正斜杠 + 双引号。"""
    return '"{}"'.format(str(path).replace("\\", "/"))


def _is_turbulent(model: str) -> bool:
    return str(model).lower().startswith(("ke-", "kw-", "k-"))


def build_model_lines(cfg: dict) -> list[str]:
    model = cfg["physics"]["model"]
    tui = cfg["tui"]
    lines: list[str] = []
    if model == "laminar":
        # 2022R2 真机校准：laminar 也有 "Enable the laminar flow model? [no]" 提示
        lines.append("/define/models/viscous/laminar yes")
    elif model in ("ke-standard", "ke-rng", "ke-realizable", "kw-standard", "kw-sst"):
        ans = tui.get("ke_production_limiter", "yes")
        lines.append(f"/define/models/viscous/{model} {ans}")
    else:
        raise ValueError(f"未知湍流模型: {model}")
    return lines


def build_bc_lines(cfg: dict) -> list[str]:
    """2022R2 真机校准（2026-09-20，逐行探针实证）：

      vmag                 → "Use Profile for Velocity Magnitude? [no]" + 数值
      turb-intensity       → 直接数值（无前置问句）
      turb-viscosity-ratio → 直接数值
      gauge-pressure       → "Use Profile for Gauge Pressure? [no]" + 数值
    各字段的前置应答序列在 config.tui.inlet_field_answers / outlet_field_answers 配置。"""
    lines: list[str] = []
    tui = cfg["tui"]
    inlet, outlet = cfg["bc"]["inlet"], cfg["bc"]["outlet"]
    if inlet.get("set_type"):
        lines.append(f"/mesh/modify-zones/zone-type {inlet['zone']} {inlet['type']}")
    if outlet.get("set_type"):
        lines.append(f"/mesh/modify-zones/zone-type {outlet['zone']} {outlet['type']}")

    if inlet["type"] == "velocity-inlet":
        pre = tui.get("inlet_field_answers", {
            "vmag": ["no"], "turb-intensity": [], "turb-viscosity-ratio": []})
        parts = [f"vmag", *pre.get("vmag", []), f"{inlet['vmag']:.6g}"]
        if _is_turbulent(cfg["physics"]["model"]):
            parts += [f"turb-intensity", *pre.get("turb-intensity", []),
                      f"{float(inlet['turb_intensity']):.6g}"]
            parts += [f"turb-viscosity-ratio", *pre.get("turb-viscosity-ratio", []),
                      f"{float(inlet['turb_viscosity_ratio']):.6g}"]
        lines.append(
            f"/define/boundary-conditions/set/velocity-inlet {inlet['zone']} () "
            + " ".join(parts) + " ()"
        )
    elif inlet["type"] == "pressure-far-field":
        # 官方示例翻译（pyfluent external_compressible_flow：跨音速机翼 M0.8395, AoA 3.06°）
        # 应答序列未真机校准（demo 管道不含 far-field），首次使用按 prompt_calibration 探针定案
        pre = tui.get("farfield_field_answers", {
            "gauge-pressure": ["no"], "mach": ["no"], "temperature": ["no"],
            "flow-direction": [], "turb-intensity": [], "turb-viscosity-ratio": []})
        ff = inlet
        parts = [f"gauge-pressure", *pre.get("gauge-pressure", []),
                 f"{float(ff.get('gauge_pressure', 0.0)):.6g}"]
        parts += [f"mach", *pre.get("mach", []), f"{float(ff.get('mach', 0.8)):.6g}"]
        if ff.get("temperature") is not None:
            parts += [f"temperature", *pre.get("temperature", []),
                      f"{float(ff['temperature']):.6g}"]
        if ff.get("flow_direction"):
            fx_, fy_, fz_ = (float(x) for x in ff["flow_direction"])
            parts += [f"flow-direction", *pre.get("flow-direction", []),
                      f"{fx_:.6g} {fy_:.6g} {fz_:.6g}"]
        if _is_turbulent(cfg["physics"]["model"]):
            parts += [f"turb-intensity", *pre.get("turb-intensity", []),
                      f"{float(ff.get('turb_intensity', 0.05)):.6g}"]
            parts += [f"turb-viscosity-ratio", *pre.get("turb-viscosity-ratio", []),
                      f"{float(ff.get('turb_viscosity_ratio', 10.0)):.6g}"]
        lines.append(
            f"/define/boundary-conditions/set/pressure-far-field {ff['zone']} () "
            + " ".join(parts) + " ()"
        )
    else:
        raise ValueError(f"不支持的入口类型: {inlet['type']}")

    if outlet["type"] == "pressure-outlet":
        field_name = tui.get("outlet_pressure_field", "gauge-pressure")
        pre = tui.get("outlet_field_answers", {"gauge-pressure": ["no"]})
        parts = [field_name, *pre.get(field_name, []),
                 f"{float(outlet['gauge_pressure']):.6g}"]
        lines.append(
            f"/define/boundary-conditions/set/pressure-outlet {outlet['zone']} () "
            + " ".join(parts) + " ()"
        )
    else:
        raise ValueError(f"不支持的出口类型: {outlet['type']}")
    return lines


def build_methods_lines(cfg: dict) -> list[str]:
    if not cfg["methods"].get("enabled"):
        return []
    m = cfg["methods"]
    relax_names = cfg["tui"]["relax_var_names"]
    return [
        f"/solve/set/discretization-scheme/pressure {m['pressure']}",
        f"/solve/set/discretization-scheme/mom {m['momentum']}",
        f"/solve/set/discretization-scheme/tk {m['turb_kinetic']}",
        f"/solve/set/discretization-scheme/te {m['turb_dissipation']}",
        f"/solve/set/under-relaxation/{relax_names['momentum']} {m['relax_momentum']:.4g}",
        f"/solve/set/under-relaxation/{relax_names['k']} {m['relax_k']:.4g}",
        f"/solve/set/under-relaxation/{relax_names['epsilon']} {m['relax_epsilon']:.4g}",
    ]


def build_gravity_lines(cfg: dict) -> list[str]:
    g = cfg["physics"].get("gravity")
    if not g:
        return []
    gx, gy, gz = (float(x) for x in g)
    return [f"/define/operating-conditions/gravity yes {gx:.6g} {gy:.6g} {gz:.6g}"]


def build_report_lines(cfg: dict) -> list[str]:
    """2022R2 真机校准：wall-forces 提示序 = all-wall-zones(y/n) → Zone 列表 → 力方向分量
    → Write to File?(y/n → 文件名)。C3 列到 transcript（矢量三元组表）；C1 末尾写 lis 文件。"""
    style = cfg["run"]["force_report_style"]
    zone = cfg["run"]["wall_zone"]
    ffile = cfg["run"]["force_file"]
    if style == "C1":   # 同 C3 选择区域/分量，最后写文件
        return [f"/report/forces/wall-forces no {zone} () 1 0 0 yes {ffile}"]
    if style == "C2":   # 备选：全量 wall 区域列表模式
        return [f"/report/forces/wall-forces yes 1 0 0"]
    if style == "C3":   # 不写文件，矢量表进 transcript
        return [f"/report/forces/wall-forces no {zone} () 1 0 0 no"]
    raise ValueError(f"未知 force_report_style: {style}（可选 C1/C2/C3）")


def build_flux_report_lines(cfg: dict) -> list[str]:
    """M1.5 基线：入口/出口质量流量与面积加权平均静压（2022R2 校准：尾答 no=不写文件）。"""
    if not cfg["run"].get("flux_report"):
        return []
    zi = cfg["bc"]["inlet"]["zone"]
    zo = cfg["bc"]["outlet"]["zone"]
    return [
        f"/report/surface-integrals/mass-flow-rate {zi} () no",
        f"/report/surface-integrals/mass-flow-rate {zo} () no",
        f"/report/surface-integrals/area-weighted-avg {zi} () pressure no",
        f"/report/surface-integrals/area-weighted-avg {zo} () pressure no",
    ]


def build_quality_lines(cfg: dict) -> list[str]:
    return ["/mesh/check", "/mesh/quality"] if cfg["run"].get("mesh_check") else []


def build_param_lines(kv: dict) -> list[str]:
    out = []
    for k in sorted(kv):
        v = kv[k]
        out.append(f"; PARAM {k}={v}")
    return out


def _mark(step: str) -> str:
    # 实测（v222 真跑）：同一行里第二个 Scheme 表达式会被当作字面文本回显，
    # 因此 display 与 newline 必须分行写。
    return f'(display "; STEP-OK {step}")\n(newline)'


def _section(lines: list[str], marker: str | None = None) -> str:
    """有内容才输出该段（含哨兵标记），空段整体消失 → expected_steps 与之一致。"""
    if not lines:
        return ""
    body = "\n".join(lines)
    return body + ("\n" + _mark(marker) if marker else "")


def expected_steps(cfg: dict) -> list[str]:
    steps = ["read_mesh", "setup_models"]
    if cfg["physics"].get("gravity"):
        steps.append("gravity")
    steps += ["bc_inlet", "bc_outlet"]
    if cfg["methods"].get("enabled"):
        steps.append("methods")
    steps += ["initialize", "iterate", "report_forces"]
    if cfg["run"].get("flux_report"):
        steps.append("flux_report")
    if cfg["run"].get("mesh_check"):
        steps.append("mesh_check")
    return steps


def render_journal(cfg: dict, params: dict | None, run_id: str, attempt: int) -> tuple[str, str, list[str]]:
    """渲染 journal 到字符串。返回 (journal_text, mesh_path, expected_steps)。"""
    params = dict(params or {})
    mesh_path = cfg["case"]["mesh_file"]
    if not mesh_path:
        raise ValueError("case.mesh_file 未配置")

    kv = {
        "run_id": run_id,
        "attempt": attempt,
        "model": cfg["physics"]["model"],
        "vmag": cfg["bc"]["inlet"]["vmag"],
        "turb_intensity": cfg["bc"]["inlet"]["turb_intensity"],
        "turb_viscosity_ratio": cfg["bc"]["inlet"]["turb_viscosity_ratio"],
        "outlet_gauge_pressure": cfg["bc"]["outlet"]["gauge_pressure"],
        "relax_momentum": cfg["methods"]["relax_momentum"],
        "relax_k": cfg["methods"]["relax_k"],
        "relax_epsilon": cfg["methods"]["relax_epsilon"],
        "n_iter": cfg["run"]["n_iter"],
        "wall_zone": cfg["run"]["wall_zone"],
        "ref_density": cfg["run"]["reference"]["density"],
        "ref_velocity": cfg["run"]["reference"]["velocity"],
        "ref_area": cfg["run"]["reference"]["area"],
        "force_file": cfg["run"]["force_file"],
        "force_report_style": cfg["run"]["force_report_style"],
    }
    kv.update(params)  # 调参项覆盖快照（mock 与审计都用）
    kv.update(cfg.get("journal_kv_extras") or {})  # mesh.* 等透传维度（runner 注入）

    # BC 段内 inlet/outlet 各带一个哨兵，失败归属更细
    inlet_lines = [ln for ln in build_bc_lines(cfg) if "velocity-inlet" in ln or ln.startswith("/mesh")]
    outlet_lines = [ln for ln in build_bc_lines(cfg) if "pressure-outlet" in ln]
    if not outlet_lines:  # zone-type 行归 inlet 段后的剩余行兜底
        rest = [ln for ln in build_bc_lines(cfg) if ln not in inlet_lines]
        outlet_lines = rest
    bc_section = _section(inlet_lines, "bc_inlet") + ("\n" if inlet_lines and outlet_lines else "") \
        + _section(outlet_lines, "bc_outlet")

    sections = {
        "params_kv_lines": "\n".join(build_param_lines(kv)),
        "mesh_file": _q(mesh_path),
        "model_section": _section(build_model_lines(cfg), "setup_models"),
        "gravity_section": _section(build_gravity_lines(cfg), "gravity"),
        "bc_section": bc_section,
        "methods_section": _section(build_methods_lines(cfg), "methods"),
        "n_iter": str(int(cfg["run"]["n_iter"])),
        "report_section": _section(build_report_lines(cfg), "report_forces"),
        "flux_section": _section(build_flux_report_lines(cfg), "flux_report"),
        "quality_section": _section(build_quality_lines(cfg), "mesh_check"),
        "expected_steps": ",".join(expected_steps(cfg)),
    }

    template_path = Path(cfg["template"]["solve"])
    if not template_path.exists():
        raise FileNotFoundError(f"solve 模板不存在: {template_path}")
    text = template_path.read_text(encoding="utf-8")

    def _sub(m: re.Match) -> str:
        key = m.group(1)
        if key not in sections:
            raise KeyError(f"模板变量 {key} 未定义（模板 {template_path.name}）")
        return sections[key]

    rendered = PLACEHOLDER.sub(_sub, text)
    leftovers = PLACEHOLDER.findall(rendered)
    if leftovers:
        raise ValueError(f"模板存在未填充占位符: {leftovers}")
    # 空行会让 Fluent 在当前菜单回显一次菜单列表（实测 v222），生成物压缩为无空行
    rendered = "\n".join(ln for ln in rendered.splitlines() if ln.strip()) + "\n"
    return rendered, mesh_path, sections["expected_steps"].split(",")
