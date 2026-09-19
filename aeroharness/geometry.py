# -*- coding: utf-8 -*-
"""geometry —— M2 几何自动化：SpaceClaim（SCDM）无头脚本执行 + 产物验证（6.8.3/6.8.4）。

双层结构铁律：CPython 外层读参数 → 写 JSON → 调 SpaceClaim.exe /RunScript（IronPython 内层
只做几何）；`import pandas` 等永远留在外层。

失败检测（6.8.4）：返回码 + 输出 .scdoc 存在性 + 脚本自证 manifest（named selections 清单）。
"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from .config import ROOT, get_by_path
from .adapters.journal_adapter import discover_fluent_exe  # 复用 ANSYS 根目录发现逻辑


def discover_spaceclaim_exe(extra: list[str] | None = None) -> Path | None:
    roots = [
        r"D:\Ansys-2023R1\ANSYS Inc",
        r"C:\Program Files\ANSYS Inc",
    ] + (extra or [])
    best: tuple[int, Path] | None = None
    for root in roots:
        root_p = Path(root)
        if not root_p.exists():
            continue
        for vdir in sorted(root_p.glob("v*")):
            exe = vdir / "scdm" / "SpaceClaim.exe"
            if exe.exists():
                ver = vdir.name[1:] if vdir.name[1:].isdigit() else "0"
                if best is None or int(ver) > int(best[0]):
                    best = (ver, exe)
    return best[1] if best else None


def prepare_params_json(cfg: dict, workdir: Path, params: dict | None) -> Path:
    """从配置生成几何参数 JSON（外层 CPython 职责）。

    两种来源：
      1. cfg["geometry"] 直接给出 box/named_selections（静态域）；
      2. cfg["geometry"]["auto_domain"] + 部件包围盒 → domain_sizing.recommend_domain 计算。
    """
    from .domain_sizing import recommend_domain

    geo = dict(cfg.get("geometry") or {})
    body = geo.get("body_bbox")
    if geo.get("auto_domain") and body:
        dom = recommend_domain(
            body["length"], body["width"], body["height"],
            kind=geo.get("kind", "aircraft"),
            frontal_area=geo.get("frontal_area"),
            ground=geo.get("ground"),
        )
        box = geo.get("box", {})
        box.update({"origin": dom.origin, "size": dom.size})
        geo["box"] = box
        geo["computed"] = dom.to_dict()
    geo.setdefault("box", {
        "origin": [-0.2, -0.05, -0.002], "size": [0.4, 0.1, 0.014]})
    geo.setdefault("named_selections", {
        "inlet": "xmin", "outlet": "xmax", "wall": "rest"})
    geo.setdefault("out_scdoc", str(workdir / "domain.scdoc"))
    geo.setdefault("manifest", str(workdir / "geometry_manifest.json"))
    geo.setdefault("import_cad", None)  # 可选：飞机 x_t/stp 路径
    for k, v in (params or {}).items():
        if k.startswith("geometry."):
            set_deep(geo, k[len("geometry."):], v)
    out = workdir / "geometry_params.json"
    out.write_text(json.dumps(geo, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def set_deep(d: dict, dotted: str, value) -> None:
    parts = dotted.split(".")
    cur = d
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = value


def run_spaceclaim(cfg: dict, workdir: Path, params: dict | None = None,
                   timeout_s: float = 600) -> dict:
    """执行 SpaceClaim 无头脚本并验证产物。返回 {ok, scdoc, manifest, log}。

    脚本以模板+注入参数路径的方式生成工作副本（避免依赖 SpaceClaim CLI 参数语义）。"""
    exe = cfg.get("geometry", {}).get("exe") or discover_spaceclaim_exe()
    if not exe:
        return {"ok": False, "error": "未发现 SpaceClaim.exe（v*/scdm/SpaceClaim.exe），"
                                      "可在 config geometry.exe 指定"}
    workdir.mkdir(parents=True, exist_ok=True)
    params_json = prepare_params_json(cfg, workdir, params)
    geo = json.loads(params_json.read_text(encoding="utf-8"))
    geo["log"] = str(workdir / "spaceclaim_script.log")
    params_json.write_text(json.dumps(geo, ensure_ascii=False, indent=2), encoding="utf-8")

    template = (ROOT / "scripts" / "spaceclaim_box_domain.py").read_text(encoding="utf-8")
    script = workdir / "geometry_script.py"
    script.write_text(
        template.replace("__PARAMS_JSON__", str(params_json).replace("\\", "\\\\")),
        encoding="utf-8")

    log = workdir / "spaceclaim.log"
    cmd = [str(exe), f"/RunScript={script}", "/ExitAfterScript=True"]
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, cwd=str(workdir), capture_output=True,
                              text=True, timeout=timeout_s)
        rc, out = proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        rc, out = -1, "[aeroharness] SpaceClaim 超时被终止"
    log.write_text(out, encoding="utf-8")

    scdoc = Path(geo["out_scdoc"])
    manifest_p = Path(geo["manifest"])
    ok = rc == 0 and scdoc.exists() and manifest_p.exists()
    named_ok = False
    if manifest_p.exists():
        try:
            man = json.loads(manifest_p.read_text(encoding="utf-8"))
            need = set(geo["named_selections"].keys())
            named_ok = need <= set(man.get("named_selections", []))
            ok = ok and named_ok
        except json.JSONDecodeError:
            pass
    return {
        "ok": ok, "returncode": rc,
        "scdoc": str(scdoc) if scdoc.exists() else None,
        "named_selections_ok": named_ok,
        "duration_s": time.time() - t0, "log": str(log),
        "params_json": str(params_json),
    }
