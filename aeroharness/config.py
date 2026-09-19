# -*- coding: utf-8 -*-
"""配置加载：JSON 零依赖主路径（YAML 若装了 pyyaml 也支持），深合并默认值，点路径读写。

配置文件里所有相对路径一律相对项目根（aeroharness 的上一级目录）解析。
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CONFIG_DEFAULTS: dict = {
    "case": {
        "name": "demo",
        "mesh_file": "",          # 相对项目根或绝对路径
        "dim": "3d",              # 2d / 3d
        "precision": "single",    # single / double
        "description": "",
    },
    "fluent": {
        "mode": "mock",           # mock(离线仿真器) / real(真实 fluent.exe)
        "exe": None,              # None 则自动发现
        "parallel": 2,
        "timeout_s": 1800,
        "extra_args": [],
    },
    "physics": {
        "model": "ke-standard",   # laminar / ke-standard / kw-sst
        "gravity": None,          # [gx, gy, gz] 或 None
    },
    "bc": {
        "inlet": {
            "zone": "inlet",
            "type": "velocity-inlet",
            "vmag": 200.0,
            "turb_intensity": 5.0,
            "turb_viscosity_ratio": 10.0,
            "set_type": False,    # True 时先执行 zone-type 重指派
        },
        "outlet": {
            "zone": "outlet",
            "type": "pressure-outlet",
            "gauge_pressure": 0.0,
            "set_type": False,
        },
    },
    "methods": {
        "enabled": False,         # True 时写出离散格式/松弛因子 TUI 行（飞机算例用）
        "pressure": 2,            # 压力离散格式代码（2=Second Order，校准项）
        "momentum": 2,            # 动量离散格式代码（2=Second Order Upwind，校准项）
        "turb_kinetic": 2,
        "turb_dissipation": 2,
        "relax_momentum": 0.7,
        "relax_k": 0.7,
        "relax_epsilon": 0.7,
    },
    "run": {
        "n_iter": 100,
        "wall_zone": "wall",      # 受力面（E10 飞机为 wall.feiiji）
        "force_file": "forces.lis",
        "force_report_style": "C3",  # C1/C2/C3 校准项，见 references/prompt_calibration.md
        "reference": {"density": 1.225, "velocity": 200.0, "area": 1.0, "length": 1.0},
        "convergence": {"residual_target": 1e-3, "min_iter": 10},
        "mesh_check": True,
    },
    "objective": {
        "type": "coefficient_match",
        "targets": {},            # {"cd": 0.0386, "cl": -0.0393}
        "weights": {"cd": 1.0, "cl": 1.0},
        "require_converged": False,
        "fail_penalty": 1.0e6,
    },
    "optimize": {
        "params": [],             # [{"name": "bc.inlet.turb_intensity", "type": "float", "low": 1, "high": 20}]
        "seed": 42,
        "n_trials": 10,
        "coarse_fraction": 0.25,  # 粗筛轮迭代数 = n_iter * coarse_fraction
        "top_k": 2,
        "wall_clock_budget_s": None,
        "engine": "auto",         # auto / optuna / builtin
    },
    "retry": {
        "divergence": {"max": 2, "relax_scale": 0.85},
        "license": {"max": 2, "wait_s": 20},
        "mesh": {"max": 1},
        "crash_timeout": {"max": 1},
    },
    "template": {
        "solve": "journals/templates/solve_channel.jou.tmpl",
        "verified": "unknown",    # offline(经 mock 验证) / live(真跑验证) / unknown / false
    },
    "tui": {
        # —— 校准项（references/prompt_calibration.md）——
        "vmag_constant_answer": "yes",        # set velocity-inlet vmag 后的常数/剖面应答
        "ke_production_limiter": "yes",       # ke-standard 后的 Production Limiter 应答
        "outlet_pressure_field": "gauge-pressure",
        "relax_var_names": {"momentum": "momentum", "k": "k", "epsilon": "epsilon"},
    },
}


class ConfigError(Exception):
    pass


def _deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def get_by_path(cfg: dict, dotted: str, default=None):
    cur = cfg
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def set_by_path(cfg: dict, dotted: str, value) -> None:
    parts = dotted.split(".")
    cur = cfg
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


def coerce_value(text: str):
    """--set 命令行传入的字符串自动转型。"""
    low = text.strip().lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("null", "none"):
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        pass
    return text


def resolve_path(p) -> str:
    if not p:
        return ""
    pp = Path(str(p))
    if not pp.is_absolute():
        pp = ROOT / pp
    return str(pp)


def load_config(path: str | os.PathLike, overrides: dict | None = None) -> dict:
    path = Path(path)
    if not path.exists():
        raise ConfigError(f"配置文件不存在: {path}")
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() in (".yaml", ".yml"):
        try:
            import yaml  # 可选依赖
        except ImportError:
            raise ConfigError("读取 YAML 需要 pyyaml：pip install pyyaml（或改用 JSON 配置）")
        user_cfg = yaml.safe_load(text) or {}
    else:
        try:
            user_cfg = json.loads(text)
        except json.JSONDecodeError as e:
            raise ConfigError(f"JSON 解析失败 {path}: {e}")
    if not isinstance(user_cfg, dict):
        raise ConfigError(f"配置根必须是对象: {path}")

    cfg = _deep_merge(CONFIG_DEFAULTS, user_cfg)
    for dotted, value in (overrides or {}).items():
        set_by_path(cfg, dotted, value)

    # 必填校验
    if not cfg["case"]["name"]:
        raise ConfigError("case.name 不能为空")
    # 路径解析（相对项目根）
    cfg["case"]["mesh_file"] = resolve_path(cfg["case"]["mesh_file"])
    cfg["template"]["solve"] = resolve_path(cfg["template"]["solve"])
    if cfg["fluent"]["exe"]:
        cfg["fluent"]["exe"] = resolve_path(cfg["fluent"]["exe"])
    return cfg
