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


def bridge_close_gaps(solids: list, max_gap_mm: float = 50.0,
                      ext_gap_mm: float = 0.0, ext_proj_mm: float = 0.0,
                      depth_mm: float = 30.0,
                      log_path: Path | None = None) -> tuple[list, list]:
    """闭合多实体装配间隙（2026-09-24 路线 A，真机 41.6s 全链通过）。

    为什么不能用 BRepBuilderAPI_Sewing：缝合只作用于**容差级**（微米级）缝隙，
    而多部件 CAD 的装配间隙是毫米~厘米级（真机实测 25.6mm），缝了也白缝。
    真正管用的是**桥接体填充**：
        filler = bridge_box - A - B，再 fuse(A, B, filler)
    fuse 顺带消除部件间干涉重叠（真机：体积 0.3671→0.3557 m^3）。

    算法（探针 v2，**ext_gap=0 是零碎片面的关键**——外扩会在部件表面边缘
    留下 1mm 裸露条带碎片面，进而让体网格八叉树追细到分钟级）：
      1. 实体两两 BRepExtrema_DistShapeShape 测距，gap < max_gap_mm 的进入桥接列表；
      2. 对每对：找 bbox 分离轴，**分离轴方向不外扩**（ext_gap=0），
         另两轴取投影交集，**默认不外扩**（ext_proj=0）——外扩会让桥接盒与部件面
         重叠，TGrid 报 "Front could not be closed at eNNN"（真机 2026-09-27 实证）。
         深度 depth_mm 取 30mm，只跨间隙本身，不吃进部件内部；
      3. filler = bridge - A - B；fuse 全部实体 + fillers，再 UnifySameDomain。

    返回 (融合后的实体列表, 桥接审计列表)。
    """
    import cadquery as cq
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

    n = len(solids)
    if n < 2:
        return solids, []

    # ---- 1) 两两测距（普查，装配间隙的唯一可靠来源） ----
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            dss = BRepExtrema_DistShapeShape(solids[i].wrapped, solids[j].wrapped)
            dss.Perform()
            gap = dss.Value()
            pairs.append((i, j, gap))
    near = [p for p in pairs if p[2] < max_gap_mm]
    if log_path:
        _log(f"  间隙普查: {n} 实体, {len(near)} 对 < {max_gap_mm}mm "
             f"(最近 {min(p[2] for p in pairs):.2f}mm)", log_path)
    if not near:
        return solids, []

    audit = []
    fillers = []
    work = cq.Workplane("XY")
    for i, j, gap in near:
        bi, bj = solids[i].BoundingBox(), solids[j].BoundingBox()
        axes = []
        if bi.xmax < bj.xmin or bj.xmax < bi.xmin:
            axes.append("x")
        if bi.ymax < bj.ymin or bj.ymax < bi.ymin:
            axes.append("y")
        if bi.zmax < bj.zmin or bj.zmax < bi.zmin:
            axes.append("z")
        if not axes:
            # bbox 相交 = 干涉/贴合，fuse 本身即可消重，无需桥接
            audit.append({"pair": [i, j], "gap_mm": round(gap, 4),
                          "action": "fuse_only"})
            continue
        sep = axes[0]
        ext = ext_proj_mm
        # 分离轴：只跨"间隙 + 两侧各一点材料"，而不是实体全厚度。
        # （真机踩坑：按 min/max 跨越会把垂尾的 454mm 全长当桥接长度，
        #   域的 Y 从 2540mm 被撑到 12286mm，网格严重变形。）
        # 这里用 BoundingBox 中心距离定位间隙区间，向两侧各留 depth_mm。
        depth_mm = 20.0
        if sep == "x":
            lo_b, hi_b = (bi, bj) if bi.xmin < bj.xmin else (bj, bi)
            gap_lo, gap_hi = lo_b.xmax, hi_b.xmin
            org = (gap_lo - depth_mm,
                   max(bi.ymin, bj.ymin) - ext, max(bi.zmin, bj.zmin) - ext)
            size = (gap_hi - gap_lo + 2 * depth_mm,
                    min(bi.ymax, bj.ymax) + ext - org[1],
                    min(bi.zmax, bj.zmax) + ext - org[2])
        elif sep == "y":
            lo_b, hi_b = (bi, bj) if bi.ymin < bj.ymin else (bj, bi)
            gap_lo, gap_hi = lo_b.ymax, hi_b.ymin
            org = (max(bi.xmin, bj.xmin) - ext, gap_lo - depth_mm,
                   max(bi.zmin, bj.zmin) - ext)
            size = (min(bi.xmax, bj.xmax) + ext - org[0],
                    gap_hi - gap_lo + 2 * depth_mm,
                    min(bi.zmax, bj.zmax) + ext - org[2])
        else:
            lo_b, hi_b = (bi, bj) if bi.zmin < bj.zmin else (bj, bi)
            gap_lo, gap_hi = lo_b.zmax, hi_b.zmin
            org = (max(bi.xmin, bj.xmin) - ext, max(bi.ymin, bj.ymin) - ext,
                   gap_lo - depth_mm)
            size = (min(bi.xmax, bj.xmax) + ext - org[0],
                    min(bi.ymax, bj.ymax) + ext - org[1],
                    gap_hi - gap_lo + 2 * depth_mm)
        if min(size) <= 0:
            audit.append({"pair": [i, j], "gap_mm": round(gap, 4),
                          "action": "skip_degenerate"})
            continue
        box = work.box(size[0], size[1], size[2],
                       centered=(False, False, False)).translate(org)
        filler = box.cut(solids[i]).cut(solids[j]).val()
        if filler is not None and filler.Volume() > 0:
            fillers.append(filler)
            audit.append({"pair": [i, j], "gap_mm": round(gap, 4),
                          "action": "bridged", "sep_axis": sep,
                          "filler_mm3": round(filler.Volume(), 2),
                          "box_mm": [round(v, 2) for v in size]})
            if log_path:
                _log(f"    桥接 {i}-{j}: gap={gap:.2f}mm 轴={sep} "
                     f"filler={filler.Volume():.0f}mm^3", log_path)

    # ---- 2) fuse 全部实体 + fillers ----
    if not fillers:
        return solids, audit
    try:
        # 用 Workplane 承载 union（cadquery 的 Solid/Compound 没有 union 方法）
        wp = cq.Workplane("XY").newObject([solids[0]])
        for s in solids[1:]:
            wp = wp.union(cq.Workplane("XY").newObject([s]))
        for f in fillers:
            wp = wp.union(cq.Workplane("XY").newObject([f]))
        fused = wp.val()
        fused = fused.wrapped if hasattr(fused, 'wrapped') else fused
        try:
            up = ShapeUpgrade_UnifySameDomain(fused, True, True, False)
            up.Build()
            fused = up.Shape()
        except Exception:  # noqa: BLE001
            pass
        out = []
        try:
            from OCP.TopExp import TopExp_Explorer
            from OCP.TopAbs import TopAbs_SOLID
            from OCP.TopoDS import TopoDS
            sol = []
            ex = TopExp_Explorer(fused, TopAbs_SOLID)
            while ex.More():
                sol.append(cq.Solid(TopoDS.Solid_s(ex.Current())))
                ex.Next()
            out = sol
        except Exception:  # noqa: BLE001
            out = []
        if not out:
            if log_path:
                _log("  fuse 后无法拆回实体列表，保留原实体", log_path)
            return solids, audit
        if log_path:
            _log(f"  桥接完成: {n} 实体 -> {len(out)} "
                 f"(filler {len(fillers)} 个, 总体积 "
                 f"{sum(s.Volume() for s in out) / 1e9:.4f} m^3)", log_path)
        return out, audit
    except Exception as exc:  # noqa: BLE001 - 桥接失败不应中断建域
        if log_path:
            _log(f"  桥接失败({exc})，回退原始实体", log_path)
        return solids, audit


def classify_faces(shape, aircraft_faces: set, tol: float = 1e-6,
                   domain_bbox=None):
    """把外域面分成"飞机表面"与"域盒六面"，用于命名（2026-09-24 P0-4）。

    ⚠️ 判别顺序（桥接带来的教训）：**先按面中心位置判别是不是域面**，
    只有域面才按法向细分 inlet/outlet/top/bottom。若反过来先看法向，
    桥接墙这类轴对齐平面会被误判成 inlet/outlet。

    域面判据：面在两轴上几乎跨越整个域盒（"整块侧板"而非局部），
    且落在盒面平面上（中心/包围盒触边）。
    """
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopoDS import TopoDS

    groups: dict[str, list] = {"aircraft_skin": [], "inlet": [], "outlet": [],
                               "farfield": [], "top": [], "bottom": []}
    raw = shape.wrapped if hasattr(shape, "wrapped") else shape

    if domain_bbox is None:
        bnd = Bnd_Box()
        BRepBndLib.Add_s(raw, bnd)
        domain_bbox = bnd.Get()  # (xmin,ymin,zmin,xmax,ymax,zmax)
    xd, yd, zd = (domain_bbox[3] - domain_bbox[0], domain_bbox[4] - domain_bbox[1],
                  domain_bbox[5] - domain_bbox[2])
    pos_tol = max(xd, yd, zd) * 1e-3

    faces = []
    exp = TopExp_Explorer(raw, TopAbs_FACE)
    while exp.More():
        faces.append(TopoDS.Face_s(exp.Current()))
        exp.Next()

    for f in faces:
        bb = Bnd_Box()
        BRepBndLib.Add_s(f, bb)
        xm, ym, zm, xM, yM, zM = bb.Get()
        spans = ((xM - xm) / xd if xd else 0, (yM - ym) / yd if yd else 0,
                 (zM - zm) / zd if zd else 0)
        on_box = (abs(xm - domain_bbox[0]) < pos_tol or abs(xM - domain_bbox[3]) < pos_tol
                  or abs(ym - domain_bbox[1]) < pos_tol or abs(yM - domain_bbox[4]) < pos_tol
                  or abs(zm - domain_bbox[2]) < pos_tol or abs(zM - domain_bbox[5]) < pos_tol)
        if not (on_box and max(spans) > 0.98):
            groups["aircraft_skin"].append(f)
            continue
        ad = BRepAdaptor_Surface(f)
        if ad.GetType() != GeomAbs_Plane:
            groups["aircraft_skin"].append(f)
            continue
        n = ad.Plane().Axis().Direction()
        nx, ny, nz = n.X(), n.Y(), n.Z()
        if abs(abs(nx) - 1) < 1e-6:
            (groups["inlet"] if nx < 0 else groups["outlet"]).append(f)
        elif abs(abs(ny) - 1) < 1e-6:
            groups["farfield"].append(f)
        else:
            (groups["top"] if nz > 0 else groups["bottom"]).append(f)
    return groups


def export_clean_solid(shape, out_step: Path, expect_volume_mm3: float | None = None,
                       log_path: Path | None = None) -> dict:
    """干净 solid-only STEP 导出 + **强制回读自检**（2026-09-27 落地）。

    为什么不做面命名（判死，双证据）：
      证据1（本地回读）：AddSubShape 对面引用一律返回 null Label——那套结构无法
        命名面，且会让导出物退化成"solids=0 + 37 个开放面壳"。
      证据2（真机）：改用自由命名形状 + 实体并列，名字确实进了 STEP，但重合面
        导致 watertight 表面网格 Join 时 node insertion failed。
    结论：CAD 侧命名这条路放弃；边界命名改走**求解器侧拆区**（见 config _zone_todo）。

    自检（fail fast，永久闭环"导出缺口"）：
      - 回读后 solids 必须 >= 1（solids=0 是导出损坏的硬信号）
      - 体积与期望一致（相对误差 <1%）
      - 壳数记录下来供诊断（外域合法形态是 2 壳：域盒 + 飞机腔）
    """
    from OCP.STEPControl import STEPControl_Writer, STEPControl_StepModelType
    from OCP.Interface import Interface_Static

    raw = shape.wrapped if hasattr(shape, "wrapped") else shape
    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    Interface_Static.SetIVal_s("write.step.assembly", 0)
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    w = STEPControl_Writer()
    w.Transfer(raw, STEPControl_StepModelType.STEPControl_AsIs, True)
    w.Write(str(out_step))
    _make_writable(out_step)

    # ---- 回读自检 ----
    import cadquery as cq
    rb = cq.importers.importStep(str(out_step))
    rb_shape = rb.val()
    n_solids = len(rb.solids().vals())
    n_shells = len(rb_shape.Shells())
    vol = rb_shape.Volume()
    result = {"ok": False, "solids": n_solids, "shells": n_shells,
              "volume_mm3": vol, "bytes": out_step.stat().st_size}
    if n_solids < 1:
        result["error"] = (f"导出损坏：回读 solids=0（期望>=1）。"
                           f"这通常是把面而非实体写进了 STEP。")
    elif expect_volume_mm3 and abs(vol - expect_volume_mm3) / max(
            expect_volume_mm3, 1.0) > 0.01:
        result["error"] = (f"体积不符：回读 {vol:.4g} vs 期望 "
                           f"{expect_volume_mm3:.4g} mm^3（相对误差>1%）")
    else:
        result["ok"] = True
    if log_path:
        _log(f"  导出自检: solids={n_solids} shells={n_shells} "
             f"V={vol / 1e9:.2f}m^3 ok={result['ok']}"
             + (f" ({result['error']})" if result.get("error") else ""), log_path)
    return result


def build_slab7_domain(src_step: str | Path, out_dir: str | Path,
                        margin: dict | None = None,
                        core_margin_mm: float = 50.0,
                        log_path: Path | None = None) -> dict:
    """7 体域构造（2026-09-27，P1 收尾）：core(挖空飞机) + 6 块域面板。

    为什么需要它：单体域的**域面全部并入 interior**，无法设 inlet/outlet/far-field
    边界条件（无压力驱动 -> cd/cl 恒为 0）。把域盒切成"含飞机的核心区 + 6 块板"，
    WTM 会为每块板生成独立边界 zone，**并按名字自动设置 BC 类型**
    （velocity-inlet / pressure-outlet / pressure-far-field，真机验证）。

    构造要点（**切片不能碰飞机**，否则飞机被切成多段导致表面网格失败）：
        core   = 飞机包围盒外扩 core_margin_mm，挖空飞机
        inlet  = [域xMin → core.xMin] × 全 yz
        outlet = [core.xMax → 域xMax] × 全 yz
        bottom/top = [core.xy] × [域zMin → core.zMin] / [core.zMax → 域zMax]
        farfield_ym/yp = x 取 core 段，y 取域与 core 之间，z 全高
    7 块互不重叠、恰好铺满 core→域盒 的壳层；相邻界面由 WTM 的
    Apply Share Topology 自动 Joining（真机 18 对界面 skewness 0.79）。

    每个实体都做**实体级命名**（v_solidsonly 路线：solid + 名字都存活），
    配合 assembly=0 导出，名字端到端进 zone 名。
    """
    import cadquery as cq
    from OCP.STEPControl import STEPControl_Writer, STEPControl_StepModelType
    from OCP.Interface import Interface_Static
    from OCP.TopoDS import TopoDS_Compound
    from OCP.BRep import BRep_Builder

    src_step = Path(src_step)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    log_p = log_path or (out_dir / "build_domain.log")
    m = {"upstream": 2.0, "downstream": 3.0, "lateral": 1.0, "vertical": 0.75}
    if margin:
        m.update(margin)
    K = 1000.0
    mm = 0.001

    ac = cq.importers.importStep(str(src_step))
    _make_writable(src_step)
    # 桥接装配间隙（否则 WTM 报 3-free-edges）
    solids_in = ac.solids().vals()
    if len(solids_in) > 1:
        solids_in, _ = bridge_close_gaps(solids_in, log_path=log_p)
    ac = cq.Workplane("XY").newObject(solids_in)
    abb = ac.val().BoundingBox()
    L, W, H = abb.xlen, abb.ylen, abb.zlen
    _log(f"7体域: 构型 L={L:.0f} W={W:.0f} H={H:.0f} mm, "
         f"实体={len(solids_in)}", log_p)

    # 未挖空的域盒
    ox = abb.xmin - m["upstream"] * L
    oy = abb.ymin - m["lateral"] * W
    oz = abb.zmin - m["vertical"] * H
    sx = L + (m["upstream"] + m["downstream"]) * L
    sy = W + 2 * m["lateral"] * W
    sz = H + 2 * m["vertical"] * H
    dxm, dym, dzm = sx * mm, sy * mm, sz * mm   # 域尺寸（米，仅记录）
    _log(f"  域盒 size=({dxm:.1f},{dym:.1f},{dzm:.1f}) m", log_p)

    # core = 飞机 bbox 外扩 core_margin
    cm = float(core_margin_mm)
    cx0, cx1 = abb.xmin - cm, abb.xmax + cm
    cy0, cy1 = abb.ymin - cm, abb.ymax + cm
    cz0, cz1 = abb.zmin - cm, abb.zmax + cm
    _log(f"  core: [{cx0:.0f},{cx1:.0f}]x[{cy0:.0f},{cy1:.0f}]x[{cz0:.0f},{cz1:.0f}]"
         f" (+{cm}mm)", log_p)

    wp = cq.Workplane("XY")
    def slab(name, x0, x1, y0, y1, z0, z1):
        box = wp.box(x1 - x0, y1 - y0, z1 - z0,
                     centered=(False, False, False)).translate((x0, y0, z0))
        cut = box.cut(ac)
        vol = cut.val().Volume() / 1e9
        _log(f"  {name:<12} V={vol:7.2f} m^3", log_p)
        return (name, cut)

    parts = [
        slab("fluid_core",   cx0, cx1, cy0, cy1, cz0, cz1),   # 含飞机
        slab("inlet",        ox,  cx0, oy,  oy + sy, oz, oz + sz),
        slab("outlet",       cx1, ox + sx, oy, oy + sy, oz, oz + sz),
        slab("bottom",       cx0, cx1, cy0, cy1, oz, cz0),
        slab("top",          cx0, cx1, cy0, cy1, cz1, oz + sz),
        slab("farfield_ym",  cx0, cx1, oy,  cy0,  oz, oz + sz),
        slab("farfield_yp",  cx0, cx1, cy1, oy + sy, oz, oz + sz),
    ]

    # 组装 compound 并做实体级命名
    b = BRep_Builder()
    comp = TopoDS_Compound()
    b.MakeCompound(comp)
    for _n, p in parts:
        b.Add(comp, p.val().wrapped)

    out_step = out_dir / "fluid_domain_slab7.step"
    named_ok = _export_named_solids(parts, out_step, log_p)
    if not named_ok:
        Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
        Interface_Static.SetIVal_s("write.step.assembly", 0)
        Interface_Static.SetCVal_s("write.step.unit", "MM")
        sw = STEPControl_Writer()
        sw.Transfer(comp, STEPControl_StepModelType.STEPControl_AsIs, True)
        sw.Write(str(out_step))
    _make_writable(out_step)

    # 回读自检：solids 必须 = 7
    rb = cq.importers.importStep(str(out_step))
    n_solids = len(rb.solids().vals())
    vol = rb.val().Volume() / 1e9
    meta = {"n_parts": len(parts), "solids_readback": n_solids,
            "volume_m3": vol, "core_margin_mm": cm,
            "domain_size_m": [dxm, dym, dzm],
            "margin": m, "parts": [{"name": n, "V_m3": p.val().Volume() / 1e9}
                                   for n, p in parts],
            "named": named_ok, "out_step": str(out_step)}
    ok = (n_solids == len(parts))
    _log(f"  导出自检: solids={n_solids} (期望 {len(parts)}) V={vol:.2f} m^3 "
         f"ok={ok}", log_p)
    if not ok:
        return {"ok": False, "error": f"7体域导出自检失败：solids={n_solids}", "meta": meta}
    return {"ok": True, "step": str(out_step), "meta": meta}


def _export_named_solids(parts, out_step: Path, log_path=None) -> bool:
    """7 体域的实体级命名导出（v_solidsonly 路线：每个 solid 一个 top-level 名字）。

    真机验证（2026-09-27）：solid + 名字都能存活到 STEP，且 WTM 会把 body 名
    带进 zone 名（freeparts-inlet 等）并据此自动设置 BC 类型。
    """
    from OCP.TDocStd import TDocStd_Document
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.TDataStd import TDataStd_Name
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_StepModelType
    from OCP.Interface import Interface_Static
    from OCP.IFSelect import IFSelect_RetDone

    try:
        doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
        tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
        for name, p in parts:
            lbl = tool.AddShape(p.val().wrapped, False)  # 独立 top-level solid
            TDataStd_Name.Set_s(lbl, TCollection_ExtendedString(name))
        Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
        Interface_Static.SetIVal_s("write.step.assembly", 0)
        Interface_Static.SetCVal_s("write.step.unit", "MM")
        w = STEPCAFControl_Writer()
        w.Transfer(doc, STEPControl_StepModelType.STEPControl_AsIs)
        status = w.Write(str(out_step))
        text = out_step.read_text(encoding="utf-8", errors="replace")
        hits = [n for n, _ in parts if ("'%s'" % n) in text]
        if log_path:
            _log(f"  实体级命名: {len(hits)}/{len(parts)} 落盘"
                 f"（缺: {sorted(set(n for n, _ in parts) - set(hits)) or '无'}）", log_path)
        return status == IFSelect_RetDone and len(hits) == len(parts)
    except Exception as exc:  # noqa: BLE001
        if log_path:
            _log(f"  实体级命名失败({exc})，退回普通导出", log_path)
        return False


def build_fluid_domain(src_step: str | Path, out_dir: str | Path,
                       margin: dict | None = None,
                       min_size_m: float = 0.05,
                       with_names: bool = True,
                       bridge_gaps: bool = True,
                       max_bridge_gap_mm: float = 50.0,
                       ext_gap_mm: float = 0.0,
                       ext_proj_mm: float = 1.0) -> dict:
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

    # ---- 路线 A：先闭合多实体装配间隙，再建域 ----
    # 多部件 CAD 之间的毫米级缝隙会让 watertight 的 surface mesh 报
    # "Deleted N faces with 3 free edges" → 网格失败（真机 2026-09-24）。
    bridge_audit = []
    n_solids_in = n_solids
    if bridge_gaps:
        _log(f"装配间隙桥接（阈值 {max_bridge_gap_mm}mm，ext_gap={ext_gap_mm}）...", log_p)
        solids = ac.solids().vals()
        solids, bridge_audit = bridge_close_gaps(
            solids, max_gap_mm=max_bridge_gap_mm,
            ext_gap_mm=ext_gap_mm, ext_proj_mm=ext_proj_mm, log_path=log_p)
        if len(solids) != n_solids_in or bridge_audit and any(
                a.get("action") == "bridged" for a in bridge_audit):
            ac = cq.Workplane("XY").newObject(solids)
            bbr = ac.val().BoundingBox()
            L, W, H = bbr.xlen * mm, bbr.ylen * mm, bbr.zlen * mm
            vol_m3 = ac.val().Volume() * mm ** 3
            n_solids = len(solids)
            _log(f"  桥接后: 实体={n_solids} V={vol_m3:.4f}m^3", log_p)
        else:
            _log("  桥接未产生变化，保持原构型", log_p)

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

    # ---- 面分组（仅诊断；CAD 侧命名已判死，见 export_clean_solid docstring）----
    named_ok = False
    groups = {}
    if with_names:
        try:
            groups = classify_faces(healed, set())
            summary = {k: len(v) for k, v in groups.items() if v}
            _log(f"  面分组（仅诊断，不写入 STEP）: {summary}", log_p)
        except Exception as exc:  # noqa: BLE001
            _log(f"  面分组失败({exc})，不影响导出", log_p)

    # ---- 干净 solid-only 导出 + 强制回读自检（solids=0 直接 fail fast）----
    out_step = out_dir / "fluid_domain.step"
    expect_vol = healed.Volume() if hasattr(healed, "Volume") else None
    exp = export_clean_solid(healed, out_step, expect_volume_mm3=expect_vol,
                             log_path=log_p)
    if not exp["ok"]:
        _log(f"  导出失败: {exp.get('error')}", log_p)
        return {"ok": False, "error": exp.get("error", "STEP 导出自检失败"),
                "export_check": exp, "log": str(log_p)}
    named_ok = exp["ok"]

    meta = {
        "src": str(src_step), "out_step": str(out_step),
        "aircraft": {"n_solids": n_solids, "LWH_m": [L, W, H], "volume_m3": vol_m3,
                     "bbox_mm": [bbr.xmin, bbr.xmax, bbr.ymin, bbr.ymax, bbr.zmin, bbr.zmax]},
        "domain": {"origin_m": [ox, oy, oz], "size_m": [sx, sy, sz],
                   "volume_m3": sx * sy * sz, "margin": m},
        "faces": len(shape.Faces()), "elapsed_s": round(time.time() - t0, 1),
        "watertight_audit": audit,
        "bridge_audit": bridge_audit,
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
