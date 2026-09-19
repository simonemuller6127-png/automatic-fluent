# -*- coding: utf-8 -*-
"""optimize —— M5 试参闭环（调研报告 6.6）：

  "试"（数值搜索）→ optuna 两级预算：粗筛（n_iter×coarse_fraction 的快 trial）+ 精修（top-k 全保真）
  执行            → JournalFluentAdapter（经 runner.run_with_retry，含 6.9 重试）
  "调"（策略决策）→ agent/人工（定范围定目标、读摘要、确认关口）
  重复参数去重不重跑（hfss-harness 同款）。

optuna 缺失时自动降级为内置“随机 + 围绕最优局部精修”引擎（零依赖）。
"""
from __future__ import annotations

import copy
import json
import math
import random
import time
from datetime import datetime
from pathlib import Path

from . import runner as R
from .config import ROOT, get_by_path
from .post import write_results_csv


class ParamSpecError(ValueError):
    pass


def _validate_space(space: list[dict]) -> None:
    if not space:
        raise ParamSpecError("optimize.params 为空：至少定义一个搜索变量"
                             "（例 {\"name\":\"bc.inlet.turb_intensity\",\"type\":\"float\",\"low\":1,\"high\":20}）")
    for s in space:
        if "name" not in s or "type" not in s:
            raise ParamSpecError(f"参数定义缺 name/type: {s}")
        if s["type"] in ("float", "int") and ("low" not in s or "high" not in s):
            raise ParamSpecError(f"float/int 参数需要 low/high: {s}")
        if s["type"] == "categorical" and "choices" not in s:
            raise ParamSpecError(f"categorical 参数需要 choices: {s}")


def _clip(v, low, high):
    return max(low, min(high, v))


class BuiltinSampler:
    """零依赖搜索引擎：先随机探索，再模式搜索（pattern search）——
    坐标轮换 ±步长，失败则翻转符号/换轴/步长减半。对光滑响应面收敛稳定。"""

    def __init__(self, space: list[dict], seed: int = 42, n_random: int = 4):
        self.space = space
        self.rng = random.Random(seed)
        self.best: dict | None = None
        self.best_loss = math.inf
        self.n_random_left = max(1, n_random)
        self.axis_i = 0
        self.sign = 1
        self.delta_frac = 0.25
        self._axis_rounds = 0

    def _random_point(self) -> dict:
        out = {}
        for s in self.space:
            name, typ = s["name"], s["type"]
            if typ == "float":
                out[name] = round(self.rng.uniform(float(s["low"]), float(s["high"])), 6)
            elif typ == "int":
                out[name] = self.rng.randint(int(s["low"]), int(s["high"]))
            elif typ == "categorical":
                out[name] = self.rng.choice(s["choices"])
            else:
                raise ParamSpecError(f"未知参数类型: {typ}")
        return out

    def sample(self) -> dict:
        if self.best is None or self.n_random_left > 0:
            if self.best is not None:
                self.n_random_left -= 1
            return self._random_point()
        s = self.space[self.axis_i]
        if s["type"] not in ("float", "int"):  # 类别变量参与不了坐标搜索，换轴
            self.axis_i = (self.axis_i + 1) % len(self.space)
            s = self.space[self.axis_i]
        name, typ = s["name"], s["type"]
        low, high = float(s["low"]), float(s["high"])
        delta = self.delta_frac * (high - low) * (1 if typ == "float" else max(1, round(self.delta_frac * (high - low))))
        v = _clip(float(self.best[name]) + self.sign * delta, low, high)
        if typ == "int":
            v = int(round(v))
        out = dict(self.best)
        out[name] = round(v, 6) if typ == "float" else v
        return out

    def update(self, params: dict, loss: float) -> None:
        if loss < self.best_loss:
            self.best, self.best_loss = dict(params), loss
            self._axis_rounds += 1  # 沿当前轴/方向继续走
            return
        # 当前试探失败：翻转方向；负方向也失败则换轴，绕完一圈步长减半
        if self.sign > 0:
            self.sign = -1
        else:
            self.sign = 1
            self._axis_rounds += 1
            if self._axis_rounds >= len(self.space):
                self._axis_rounds = 0
                self.delta_frac = max(self.delta_frac * 0.5, 0.02)
            self.axis_i = (self.axis_i + 1) % len(self.space)


class _OptunaAsk:
    """把 optuna.Trial 包装成与 BuiltinSampler 相同的 sample 接口。"""

    def __init__(self, trial, space: list[dict]):
        self.trial = trial
        self.space = space

    def sample(self) -> dict:
        out = {}
        for s in self.space:
            name, typ = s["name"], s["type"]
            if typ == "float":
                out[name] = self.trial.suggest_float(name, float(s["low"]), float(s["high"]))
            elif typ == "int":
                out[name] = self.trial.suggest_int(name, int(s["low"]), int(s["high"]))
            elif typ == "categorical":
                out[name] = self.trial.suggest_categorical(name, s["choices"])
        return out

    def update(self, params: dict, loss: float) -> None:  # pragma: no cover
        pass


def _try_optuna():
    try:
        import optuna  # type: ignore
        optuna.logging.set_verbosity(optuna.logging.WARNING)
        return optuna
    except ImportError:
        return None


def run_optimization(cfg: dict, n_trials: int = 10, budget_s: int | None = None,
                     engine: str = "auto", log=print) -> dict:
    space = cfg["optimize"]["params"]
    _validate_space(space)
    seed = int(cfg["optimize"].get("seed", 42))
    coarse_fraction = float(cfg["optimize"].get("coarse_fraction", 0.25))
    top_k = max(1, int(cfg["optimize"].get("top_k", 2)))
    penalty = float(cfg["objective"].get("fail_penalty", 1e6))

    optuna = _try_optuna() if engine in ("auto", "optuna") else None
    if engine == "optuna" and optuna is None:
        raise RuntimeError("engine=optuna 但 optuna 未安装（pip install optuna），或改用 engine=builtin/auto")

    out_dir = ROOT / "runs" / str(cfg["case"]["name"]) / f"optimize_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    out_dir.mkdir(parents=True, exist_ok=True)

    cache: dict[tuple, dict] = {}
    rows: list[dict] = []
    deadline = time.time() + budget_s if budget_s else None
    counter = {"n": 0}

    def evaluate(param_values: dict, level: str, tag: str = "") -> float:
        key = tuple(sorted((k, round(v, 6) if isinstance(v, float) else v)
                           for k, v in param_values.items()))
        if key in cache:
            log(f"  [{level}{tag}] 参数重复，直接复用 loss={cache[key]['loss']:.6g}")
            return cache[key]["loss"]
        if deadline and time.time() > deadline:
            raise _BudgetExceeded()
        counter["n"] += 1
        idx = counter["n"]
        log(f"  [{level}{tag}] trial#{idx} params={json.dumps(param_values, ensure_ascii=False)}")
        trial_cfg = copy.deepcopy(cfg)
        if level == "coarse":
            trial_cfg["run"]["n_iter"] = max(5, int(round(cfg["run"]["n_iter"] * coarse_fraction)))
        res = R.run_with_retry(trial_cfg, params=param_values, run_id=f"{level}{idx}", log=log)
        if res.status == "ok":
            loss = float(res.summary["metrics"].get("loss", penalty))
        else:
            loss = penalty
        row = {"n": idx, "level": level, "loss": loss, "status": res.status,
               "run_dir": res.run_dir, "params_json": json.dumps(param_values, ensure_ascii=False)}
        rows.append(row)
        cache[key] = {"loss": loss, "row": row, "params": dict(param_values)}
        return loss

    class _BudgetExceeded(Exception):
        pass

    def finalize(studies_meta: dict) -> dict:
        best = min(cache.values(), key=lambda c: c["loss"])
        write_results_csv(out_dir / "trials.csv", rows)
        best_json = {"params": best["params"], "loss": best["loss"],
                     "run_dir": best["row"]["run_dir"], "engine": studies_meta.get("engine"),
                     "n_evaluations": counter["n"]}
        (out_dir / "best.json").write_text(json.dumps(best_json, ensure_ascii=False, indent=2),
                                           encoding="utf-8")
        (out_dir / "report.md").write_text(
            f"# 试参报告 {cfg['case']['name']}\n\n"
            f"- 引擎: {studies_meta.get('engine')}  评估次数: {counter['n']}\n"
            f"- 最佳 loss: {best['loss']:.6g}\n"
            f"- 最佳参数: `{json.dumps(best['params'], ensure_ascii=False)}`\n"
            f"- 最佳运行目录: `{best['row']['run_dir']}`\n"
            f"- 明细: trials.csv（{len(rows)} 行）\n",
            encoding="utf-8")
        log(f"  [optimize] 完成：{counter['n']} 次评估，最佳 loss={best['loss']:.6g}")
        return {"out_dir": str(out_dir), "best": best_json, "rows": rows}

    if optuna is not None:
        log(f"== optuna 两级试参（trials={n_trials}, coarse_fraction={coarse_fraction}, seed={seed}）")
        n_coarse = max(3, n_trials // 2)
        n_fine = max(top_k + 1, n_trials - n_coarse)

        study_c = optuna.create_study(direction="minimize",
                                      sampler=optuna.samplers.TPESampler(seed=seed))
        try:
            study_c.optimize(
                lambda t: evaluate(_OptunaAsk(t, space).sample(), "coarse"),
                n_trials=n_coarse)
        except _BudgetExceeded:
            pass

        finished = [t for t in study_c.trials if t.value is not None]
        top = sorted(finished, key=lambda t: t.value)[:top_k]
        study_f = optuna.create_study(direction="minimize",
                                      sampler=optuna.samplers.TPESampler(seed=seed + 1))
        for t in top:
            fixed = {s["name"]: t.params.get(s["name"]) for s in space if s["name"] in t.params}
            if fixed:
                study_f.enqueue_trial(fixed)
        try:
            study_f.optimize(
                lambda t: evaluate(_OptunaAsk(t, space).sample(), "fine"),
                n_trials=n_fine)
        except _BudgetExceeded:
            pass
        return finalize({"engine": "optuna"})

    log(f"== 内置两级试参（optuna 未安装，随机+局部精修；trials={n_trials}, seed={seed}）")
    sampler = BuiltinSampler(space, seed=seed)
    n_coarse = max(3, n_trials // 2)
    n_fine = max(top_k + 1, n_trials - n_coarse)
    try:
        for _ in range(n_coarse):
            p = sampler.sample()
            try:
                sampler.update(p, evaluate(p, "coarse"))
            except _BudgetExceeded:
                break
        for _ in range(n_fine):
            p = sampler.sample()
            try:
                sampler.update(p, evaluate(p, "fine"))
            except _BudgetExceeded:
                break
    except _BudgetExceeded:
        pass
    return finalize({"engine": "builtin"})
