# -*- coding: utf-8 -*-
"""geom_cadquery —— M2 几何自动化的无头替代路线（绕开 SpaceClaim /RunScript 门控）。

真机背景（2026-09-24，v222 + 本机 SCDM）：
  SpaceClaim.exe /RunScript 在本机挂起（首次运行许可/协议对话框，无 GUI 环境无法代劳），
  但 Fluent Meshing 的 CAD 内核能直接读 SolidWorks 产出的 BREP STEP。
  于是几何环节改用 cadquery/OCCT 纯无头完成，只把最终产物交回 Fluent。

路线：干净构型 STEP -> 包围盒外流场域 -> 布尔挖空成流体域 -> 导出 Fluent 可读的 STEP。

真机踩坑（均为 2026-09-24 实证，勿轻易改动）：
  1. write.step.assembly 必须置 0（单实体模式），否则 Fluent 的 CAD 内核报
     "Error in CAD Import / attaching to assembly"（真机：670 面的域几何因此导入失败）。
     设为 0 后同一文件导入成功（705 边界节点 / 670 面 / 8 面区）。
  2. OCCT 的 STEP 导出写 ORIENTED_CLOSED_SHELL 而非 SolidWorks 的 MANIFOLD_SOLID_BREP，
     这本身 Fluent 可接受；assembly=0 的作用是让 shape representation 变成单实体引用。
     改 schema（AP203/AP214CD/AP242DIS）无效。
  3. CAD 文件带只读属性（微信/邮件下载常见）时，Fluent 报成 "File ... not found"，
     极具误导性——需先 chmod u+w（见 _make_writable）。
  4. STEP 头声明 SI_UNIT(.MILLI.,.METRE.) 时 OCCT 按毫米读入，必须换算到米再建域，
     否则域盒放大 1000 倍（曾导致域体积 4.9e11 m^3）。
  5. cadquery 不支持导出 Parasolid(x_t/x_b)。

参考实测：飞机 jigefeiji.STEP（7 实体，L=3.112m W=0.845m H=4.170m V=0.3671m^3）
→ 域 493 m^3 / 48 面 / 1 solid，全程 <1s。
"""
from __future__ import annotations

import json
import os
import stat
import time
from pathlib import Path


def _log(msg: str, log_path: Path | None = None) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    if log_path:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def _make_writable(path: Path) -> None:
    """去掉只读属性——Fluent 的 CAD 内核以读写方式打开几何文件。"""
    try:
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
    except OSError:
        pass


def heal_and_audit(shape, min_size_m: float = 0.0, log_path: Path | None = None):
    """几何水密性收尾（2026-09-24 P0-2）：合并重复面 + 修复 + 碎片面审计。

    布尔挖空后 OCC 常留下共面/共缝的重复面（same-domain），
    watertight 的 surface mesh 会报 "Free faces still exists" 或
    "surface meshing was not successful"。处置阶梯：
      1) ShapeUpgrade_UnifySameDomain 合并同域重复面
      2) ShapeFix_Shape 修小几何缺陷
      3) 审计：自由边数量 + 碎片面清单（面积 < (min_size/10)^2）
    返回 (修复后 shape, 审计 dict)。
    """
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
    from OCP.ShapeFix import ShapeFix_Shape
    from OCP.BRepCheck import BRepCheck_Analyzer

    audit: dict = {}
    raw_in = shape.wrapped if hasattr(shape, "wrapped") else shape
    try:
        unifier = ShapeUpgrade_UnifySameDomain(raw_in, True, True, False)
        unifier.Build()
        healed = unifier.Shape()
        audit["unified"] = True
    except Exception as exc:  # noqa: BLE001 - 修复是尽力而为，失败要记录不中断
        healed = raw_in
        audit["unified"] = f"failed: {exc}"

    try:
        fixer = ShapeFix_Shape(healed)
        fixer.Perform()
        healed = fixer.Shape()
        audit["shape_fix"] = True
    except Exception as exc:  # noqa: BLE001
        audit["shape_fix"] = f"failed: {exc}"

    # 审计：闭合性 + 碎片面
    try:
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
        from OCP.BRep import BRep_Tool
        from OCP.GProp import GProp_GProps
        from OCP.BRepGProp import BRepGProp

        n_edges = 0
        exp = TopExp_Explorer(healed, TopAbs_EDGE)
        while exp.More():
            n_edges += 1
            exp.Next()
        audit["n_edges"] = n_edges

        thr = (min_size_m / 10.0) ** 2 if min_size_m > 0 else 0.0
        frags = []
        n_faces = 0
        from OCP.TopoDS import TopoDS
        exp = TopExp_Explorer(healed, TopAbs_FACE)
        while exp.More():
            n_faces += 1
            f = TopoDS.Face_s(exp.Current())
            if thr > 0:
                props = GProp_GProps()
                BRepGProp.SurfaceProperties_s(f, props)
                if props.Mass() < thr:
                    frags.append(round(props.Mass(), 8))
            exp.Next()
        audit["n_faces"] = n_faces
        if thr > 0:
            audit["fragment_threshold_m2"] = thr
            audit["n_fragment_faces"] = len(frags)
            audit["fragments"] = sorted(frags)[:20]
    except Exception as exc:  # noqa: BLE001
        audit["audit_error"] = str(exc)

    try:
        audit["is_valid"] = bool(BRepCheck_Analyzer(healed).IsValid())
    except Exception:  # noqa: BLE001
        audit["is_valid"] = None

    if log_path:
        _log(f"  水密性审计: {audit}", log_path)
    return healed, audit


def classify_faces(shape, aircraft_faces: set, tol: float = 1e-6):
    """把外域面分成"飞机表面"与"域盒六面"，用于命名（2026-09-24 P0-4）。

    判据：面的外法向朝内/几何与原飞机实体重合 -> aircraft_skin；
    其余按法向主轴归为 inlet(-x)/outlet(+x)/farfield(±y)/top(+z)/bottom(-z)。
    """
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    groups: dict[str, list] = {"aircraft_skin": [], "inlet": [], "outlet": [],
                               "farfield": [], "top": [], "bottom": []}

    # shape 可能是 cadquery Shape（有 .wrapped）或裸 TopoDS_Shape
    raw = shape.wrapped if hasattr(shape, "wrapped") else shape

    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopoDS import TopoDS

    faces = []
    exp = TopExp_Explorer(raw, TopAbs_FACE)
    while exp.More():
        faces.append(TopoDS.Face_s(exp.Current()))
        exp.Next()

    for f in faces:
        ad = BRepAdaptor_Surface(f)
        if ad.GetType() != GeomAbs_Plane:
            groups["aircraft_skin"].append(f)
            continue
        pl = ad.Plane()
        n = pl.Axis().Direction()
        nx, ny, nz = n.X(), n.Y(), n.Z()
        ax = max(abs(nx), abs(ny), abs(nz))
        # 域盒面是纯轴对齐平面；飞机面绝大多数不是（且已在上面归类）
        if ax < 0.999:
            groups["aircraft_skin"].append(f)
        elif abs(abs(nx) - 1) < 1e-6:
            (groups["inlet"] if nx < 0 else groups["outlet"]).append(f)
        elif abs(abs(ny) - 1) < 1e-6:
            groups["farfield"].append(f)
        else:
            (groups["top"] if nz > 0 else groups["bottom"]).append(f)
    return groups


def export_with_names(shape, face_groups: dict, out_step: Path,
                      log_path: Path | None = None) -> bool:
    """带命名选择导出 STEP（P0-4）：STEPCAFControl_Writer + TDataStd_Name。

    Fluent Meshing 侧 ImportNamedSelections=Yes（默认）会把这些命名自动注册成
    face zone，配置里的 inlet/outlet/wall 就能对上真实 zone 名。
    """
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.TDocStd import TDocStd_Document
    from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label
    from OCP.STEPControl import STEPControl_StepModelType
    from OCP.Interface import Interface_Static
    from OCP.IFSelect import IFSelect_RetDone

    try:
        doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
        tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
        raw = shape.wrapped if hasattr(shape, "wrapped") else shape
        label = tool.AddShape(raw, True)

        named = 0
        # 不建 assembly：直接在顶层标签下把每个面挂成子形状并命名。
        # (AddComponent 的第二参是 shape 而非字符串，建 assembly 反而多余。)
        for name, faces in face_groups.items():
            for f in faces:
                fl = tool.AddSubShape(label, f)
                TDataStd_Name.Set_s(fl, TCollection_ExtendedString(name))
                named += 1
        # 同时给整体一个名字，便于 Fluent 侧识别
        TDataStd_Name.Set_s(label, TCollection_ExtendedString("fluid_domain"))

        Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
        Interface_Static.SetIVal_s("write.step.assembly", 0)
        Interface_Static.SetCVal_s("write.step.unit", "MM")
        w = STEPCAFControl_Writer()
        w.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs)
        status = w.Write(str(out_step))
        if log_path:
            _log(f"  命名导出: {named} 个面已命名 -> {out_step.name} (status={status})", log_path)
        return status == IFSelect_RetDone
    except Exception as exc:  # noqa: BLE001 - 命名失败退回普通导出
        if log_path:
            _log(f"  命名导出失败({exc})，退回普通 STEP 写出", log_path)
        return False


def build_fluid_domain(src_step: str | Path, out_dir: str | Path,
                       margin: dict | None = None,
                       min_size_m: float = 0.05,
                       with_names: bool = True) -> dict:
    """干净构型 STEP -> 外流场流体域 STEP（cadquery/OCCT 无头）。

    margin 为域边距（按部件特征尺寸的倍数）：upstream/downstream/lateral/vertical。
    默认参考 domain_sizing 的 aircraft 规则偏保守取值，保证首轮粗网格能跑完。
    min_size_m 仅用于碎片面审计阈值（(min_size/10)^2），与 meshing 的 size_unit 一致用米。
    with_names=True 时用 STEPCAFControl 把 inlet/outlet/farfield/top/bottom/
    aircraft_skin 命名写进 STEP，Fluent 导入后自动成为同名 face zone。
    """
    import cadquery as cq
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_Writer, STEPControl_StepModelType

    src_step = Path(src_step)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    log_p = out_dir / "build_domain.log"
    m = {"upstream": 2.0, "downstream": 3.0, "lateral": 1.0, "vertical": 0.75}
    if margin:
        m.update(margin)
    t0 = time.time()
    _log(f"开始建域 src={src_step.name} margin={m}", log_p)
    _make_writable(src_step)

    ac = cq.importers.importStep(str(src_step))
    bbr = ac.val().BoundingBox()
    n_solids = len(ac.solids().vals())
    mm = 0.001  # STEP 头为 MILLI+METRE，OCCT 按 mm 读入
    L, W, H = bbr.xlen * mm, bbr.ylen * mm, bbr.zlen * mm
    vol_m3 = ac.val().Volume() * mm ** 3
    _log(f"构型: 实体={n_solids} L={L:.3f}m W={W:.3f}m H={H:.3f}m V={vol_m3:.4f}m^3", log_p)

    ox = bbr.xmin * mm - m["upstream"] * L
    oy = bbr.ymin * mm - m["lateral"] * W
    oz = bbr.zmin * mm - m["vertical"] * H
    sx = L + (m["upstream"] + m["downstream"]) * L
    sy = W + 2 * m["lateral"] * W
    sz = H + 2 * m["vertical"] * H
    _log(f"域盒: origin=({ox:.2f},{oy:.2f},{oz:.2f}) size=({sx:.2f},{sy:.2f},{sz:.2f})", log_p)

    K = 1000.0  # 域盒用 mm 构建以匹配飞机 STEP
    domain = (cq.Workplane("XY")
              .box(sx * K, sy * K, sz * K, centered=(False, False, False))
              .translate((ox * K, oy * K, oz * K)))
    fluid = domain.cut(ac)
    shape = fluid.val()
    _log(f"挖空完成: faces={len(shape.Faces())} V={shape.Volume() * mm**3:.2f}m^3", log_p)

    # 关键：assembly=0，否则 Fluent CAD 导入失败（见模块 docstring 踩坑 1）
    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    Interface_Static.SetIVal_s("write.step.assembly", 0)
    Interface_Static.SetCVal_s("write.step.unit", "MM")

    # ---- P0-2 水密性收尾：合并重复面 + 修复 + 碎片面审计 ----
    _log("水密性修复（UnifySameDomain + ShapeFix）...", log_p)
    healed, audit = heal_and_audit(shape, min_size_m=min_size_m, log_path=log_p)

    # ---- P0-4 边界命名：把面分成命名组并写入 STEP ----
    named_ok = False
    if with_names:
        groups = classify_faces(healed, set())
        summary = {k: len(v) for k, v in groups.items() if v}
        _log(f"  面分组: {summary}", log_p)

    out_step = out_dir / "fluid_domain.step"
    if with_names:
        named_ok = export_with_names(healed, groups, out_step, log_p)
    if not named_ok:
        sw = STEPControl_Writer()
        sw.Transfer(healed, STEPControl_StepModelType.STEPControl_AsIs, True)
        sw.Write(str(out_step))
    _make_writable(out_step)

    meta = {
        "src": str(src_step), "out_step": str(out_step),
        "aircraft": {"n_solids": n_solids, "LWH_m": [L, W, H], "volume_m3": vol_m3,
                     "bbox_mm": [bbr.xmin, bbr.xmax, bbr.ymin, bbr.ymax, bbr.zmin, bbr.zmax]},
        "domain": {"origin_m": [ox, oy, oz], "size_m": [sx, sy, sz],
                   "volume_m3": sx * sy * sz, "margin": m},
        "faces": len(shape.Faces()), "elapsed_s": round(time.time() - t0, 1),
        "watertight_audit": audit,
        "named_export": bool(named_ok),
        "face_groups": ({k: len(v) for k, v in groups.items() if v}
                        if with_names else {}),
        "unit_of_step": "MM",
        "solver_note": "网格是毫米量纲；求解前按 case.mesh_unit_mm 用 /mesh/scale 0.001 缩到米。",
    }
    (out_dir / "domain_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    _log(f"DONE -> {out_step} ({out_step.stat().st_size} bytes, {meta['elapsed_s']}s)", log_p)
    return {"ok": True, "step": str(out_step), "meta": meta}


def run_geometry(cfg: dict, workdir: str | Path) -> dict:
    """pipeline geometry 步骤入口：从 cfg 读源构型与域参数，产出流体域 STEP。"""
    from .config import ROOT
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    geo = cfg.get("geometry") or {}
    src = geo.get("cad_step") or geo.get("src")
    if not src:
        return {"ok": False, "error": "geometry.cad_step 未配置（干净构型 STEP 路径）"}
    src_p = Path(src)
    if not src_p.is_absolute():
        src_p = ROOT / src_p
    if not src_p.exists():
        return {"ok": False, "error": f"源构型不存在: {src_p}"}
    try:
        return build_fluid_domain(src_p, workdir, margin=geo.get("margin"))
    except Exception as exc:  # noqa: BLE001 - 几何失败要带原始异常回诊断
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
