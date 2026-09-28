# -*- coding: utf-8 -*-
"""mesh_post —— 网格产物后处理（外流场管线的关键自动化环节）。

两个职责（2026-09-28 定稿）：

A. patch_msh_zones —— 7 体域（slab7）路线：把 WTM Join 后仍为 wall 的两面
   界面区在 h5 双层（zoneTopology + Thread Variables）改成 interior。
   （该路线后被弃用：贴片外表面区面积虚增 3.5-10 倍，见 split 说明。保留作备份。）

B. split_boundary_and_identify —— 单体域路线（现役）：
   单体域网格干净，但 6 个外表面 + 飞机表皮被 WTM 归入 1-2 个 wall 大区。
   用求解器 sep-face-zone-angle 40° 把外表面大区按角度拆成 6 个平面区，
   再离线按面质心落在哪个域范围面 -> inlet/outlet/symmetry/skin 角色识别，
   cell 区按单元数 -> 主域 fluid / 飞机内腔 solid。
   全程 zone id 寻址，规避名字解析歧义。

.h5 布局铁律（违反即被 Fluent 拒读）：
  * 补丁副本命名必须以 **.msh.h5** 结尾（read-case 对其他后缀会去找 *.cas.h5）；
  * h5py 只允许**原位写同 shape 同 dtype** 数组，禁止删除/重建数据集
    （重建会把定长字符串变变长，Fluent 的 HDF5 读取器报 iostream error）。
  * meshing 写的 .msh.h5 与 solver 写的 .cas.h5 **布局不同**：
    .msh.h5 的 c0/c1/nodes/coords 按 zone 分组；.cas.h5 是单一平面数组 +
    zoneTopology 的 minId/maxId 区间索引。读取必须双布局兼容。

单位结论（2026-09-28 定案）：WTM 写出的网格求解器读取时**原生按米**解释
（域范围/体积实测均为米级），不要 /mesh/scale 0.001（会把域缩小 1000 倍）。
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

import numpy as np


def _require_h5py():
    try:
        import h5py  # noqa: F401
    except ImportError as exc:  # pragma: no cover
        raise ImportError(
            "mesh_post 需要 h5py（pip install h5py）。它是网格后处理的唯一可选依赖，"
            "缺失时外流场管线无法自动打通。") from exc
    import h5py
    return h5py


def default_out_path(msh_path: str | Path) -> Path:
    """补丁副本路径：<name>_patched.msh.h5（必须保留 .msh.h5 后缀）。"""
    p = Path(msh_path)
    name = p.name
    if name.endswith(".msh.h5"):
        out = p.parent / (name[: -len(".msh.h5")] + "_patched.msh.h5")
    else:
        out = p.parent / (p.stem + "_patched.msh.h5")
    if not out.name.endswith(".msh.h5"):
        out = p.parent / (out.name + ".msh.h5")
    return out


# ======================================================================
# A. 两面界面区 interior 化（slab7 路线用）
# ======================================================================

def _patch_thread_variables(blob: str, zone_ids: set[int]) -> tuple[str, list[int]]:
    """Thread Variables scheme 文本里 zone_ids 的条目改成 interior。"""
    blob = blob.replace(")(\n))", ")())")
    changed: list[int] = []
    for zid in sorted(zone_ids):
        pat = re.compile(r"\(39 \(" + str(zid) + r" (\S+) ([^)]*)\)\(")
        m = pat.search(blob)
        if not m:
            continue
        old_type, name = m.group(1), m.group(2)
        if old_type == "interior":
            continue
        new_name = name.replace("freeparts-", "")
        blob = blob[:m.start()] + f"(39 ({zid} interior {new_name})(" + blob[m.end():]
        changed.append(zid)
    return blob, changed


def patch_msh_zones(msh_path: str | Path, out_path: str | Path | None = None,
                    log=None) -> dict:
    """把 .msh.h5 里所有两面（两侧都有单元）的非 interior 面区改成 interior。"""
    h5py = _require_h5py()
    src = Path(msh_path)
    if not src.exists():
        return {"ok": False, "error": f"网格文件不存在: {src}"}
    out = Path(out_path) if out_path else default_out_path(src)
    if not out.name.endswith(".msh.h5"):
        return {"ok": False, "error": f"补丁副本命名必须以 .msh.h5 结尾: {out}"}
    shutil.copy(src, out)

    with h5py.File(out, "r+") as f:
        zt = f["meshes/1/faces/zoneTopology"]
        ids = [int(v) for v in zt["id"][()]]
        ztype = np.array([int(v) for v in zt["zoneType"][()]])
        ref_type = 2
        two_sided: list[int] = []
        for k in range(1, len(ids) + 1):
            zid = ids[k - 1]
            c0 = f[f"meshes/1/faces/c0/{k}"][()]
            c1 = f[f"meshes/1/faces/c1/{k}"][()]
            if (c0 != 0).any() and (c1 != 0).any():
                two_sided.append(zid)
        to_patch = [zid for zid in two_sided if ztype[ids.index(zid)] != ref_type]
        for zid in to_patch:
            ztype[ids.index(zid)] = ref_type
        if to_patch:
            zt["zoneType"][...] = ztype
        tv_changed: list[int] = []
        if "settings/Thread Variables" in f and to_patch:
            d = f["settings/Thread Variables"]
            itemsize = d.dtype.itemsize
            blob = d[0].decode("utf-8")
            new_blob, tv_changed = _patch_thread_variables(blob, set(to_patch))
            new_bytes = new_blob.encode("utf-8")
            if len(new_bytes) > itemsize:
                return {"ok": False,
                        "error": f"Thread Variables 补丁超预算：{len(new_bytes)} > {itemsize} 字节。"}
            d[...] = np.array([new_bytes], dtype=d.dtype)

    with h5py.File(out, "r") as f2:
        zt2 = f2["meshes/1/faces/zoneTopology"]
        ids2 = [int(v) for v in zt2["id"][()]]
        zt2v = [int(v) for v in zt2["zoneType"][()]]
        bad = [zid for zid in two_sided if zt2v[ids2.index(zid)] != ref_type]
        if bad:
            return {"ok": False, "error": f"自检失败，仍有两面区非 interior: {bad}"}

    return {"ok": True, "patched": to_patch, "tv_changed": tv_changed,
            "two_sided_total": len(two_sided), "out_mesh": str(out),
            "interior_code": ref_type}


# ======================================================================
# B. 双布局 h5 读取 + 单体域边界拆区（现役路线）
# ======================================================================

def _read_mesh_layout(f):
    """兼容 meshing(.msh.h5) 与 solver(.cas.h5) 两种布局。

    import h5py  # 布局探测需要（调用方已确认可导入）

    返回 dict:
      zones:      {id: {"type": str|None, "name": str, "ztype": int, "row": int}}
      cell_zones: {id: {"name": str, "ncells": int}}
      centroids:  {id: np.ndarray(N,3)}   逐面质心
      extents:    ((x0,x1),(y0,y1),(z0,z1))
    """
    import h5py
    zt = f["meshes/1/faces/zoneTopology"]
    n_rows = len([int(v) for v in zt["id"][()]])
    # 布局判据：c0 组的键数 == zone 行数 -> meshing 逐区布局；否则 solver 扁平布局
    # （case 文件的 c0 也是 Group 但只有 1 个扁平键，不能用 isinstance 区分）
    face_is_group = isinstance(zt.parent["c0"], h5py.Group) and         len(list(zt.parent["c0"].keys())) == n_rows

    # ---- 节点坐标池（统一为一个 (N,3) 数组 + 1-based 全局索引） ----
    nzt = f["meshes/1/nodes/zoneTopology"]
    # coords 池：meshing 布局键为 1..N，solver 布局键为任意 id——按实际键全量收集
    pools = [f[f"meshes/1/nodes/coords/{k}"][()]
             for k in f["meshes/1/nodes/coords"].keys()]
    nmin = [int(v) for v in nzt["minId"][()]]
    nmax = [int(v) for v in nzt["maxId"][()]]
    npool = sum(p.shape[0] for p in pools if p is not None)
    allxyz = np.full((npool, 3), np.nan)
    filled = 0
    for p in pools:
        if p is None:
            continue
        allxyz[filled:filled + p.shape[0]] = p
        filled += p.shape[0]
    allxyz = allxyz[:filled]

    def node_xyz(gids):
        gids = np.asarray(gids, dtype=np.int64)
        # 1-based -> 0-based（两种布局的节点索引都从 1 起）
        ok = (gids >= 1) & (gids <= len(allxyz))
        out = np.full((len(gids), 3), np.nan)
        out[ok] = allxyz[gids[ok] - 1]
        return out

    # ---- 面质心（双布局） ----
    fn = f["meshes/1/faces/nodes"]
    if face_is_group:
        # meshing 布局：faces/nodes/<row>/{nnodes,nodes}，行号与 zoneTopology 行对应
        def cents_for(row):
            nn = f[f"meshes/1/faces/nodes/{row}/nnodes"][()].astype(np.int64)
            nd = f[f"meshes/1/faces/nodes/{row}/nodes"][()].astype(np.int64)
            cents = np.full((len(nn), 3), np.nan)
            start = 0
            for fi, n in enumerate(nn):
                xyz = node_xyz(nd[start:start + n])
                start += n
                if not np.isnan(xyz).any():
                    cents[fi] = xyz.mean(axis=0)
            return cents
    else:
        # solver 布局：faces/nodes/1/{nnodes,nodes} 全域扁平
        nn = f["meshes/1/faces/nodes/1/nnodes"][()].astype(np.int64)
        nd = f["meshes/1/faces/nodes/1/nodes"][()].astype(np.int64)
        cents_all = np.full((len(nn), 3), np.nan)
        start = 0
        for fi, n in enumerate(nn):
            xyz = node_xyz(nd[start:start + n])
            start += n
            if not np.isnan(xyz).any():
                cents_all[fi] = xyz.mean(axis=0)

        def cents_for(row):
            return cents_all  # 全局面质心，调用方按 minId/maxId 切

    # ---- 面区表 ----
    tv_text = None
    if "settings/Thread Variables" in f:
        tv_text = f["settings/Thread Variables"][0].decode("utf-8", errors="replace")
    tv_entries = {}
    if tv_text:
        for m in re.finditer(r"\(39 \((\d+) (\S+) ([^)\s]+)", tv_text):
            tv_entries[int(m.group(1))] = (m.group(2), m.group(3))

    zt_ids = [int(v) for v in zt["id"][()]]
    zt_types = [int(v) for v in zt["zoneType"][()]] if "zoneType" in zt else [3] * len(zt_ids)
    zt_min = [int(v) for v in zt["minId"][()]] if "minId" in zt else None
    zt_max = [int(v) for v in zt["maxId"][()]] if "maxId" in zt else None

    shadows = {}
    if "shadowZoneId" in zt:
        shadows = [int(v) for v in zt["shadowZoneId"][()]]
    zones = {}
    centroids = {}
    for r, zid in enumerate(zt_ids):
        ztype = zt_types[r]
        t, nm = tv_entries.get(zid, (None, f"z{zid}"))
        shadow = shadows[r] if r < len(shadows) else 0
        c0_cell = None
        if "c0" in zt:  # case 布局：zone 级 c0 = 该区邻接的 cell 区 id
            try:
                c0_cell = int(zt["c0"][r])
            except Exception:
                c0_cell = None
        zones[zid] = {"type": t, "name": nm, "ztype": ztype, "row": r + 1,
                      "shadow": shadow, "c0_cell": c0_cell}
        if face_is_group:
            centroids[zid] = cents_for(r + 1)
        else:
            lo, hi = zt_min[r], zt_max[r]
            centroids[zid] = cents_all[lo - 1:hi]

    # ---- cell 区 ----
    czt = f["meshes/1/cells/zoneTopology"]
    cids = [int(v) for v in czt["id"][()]]
    cnames_blob = czt["name"][0].decode("utf-8") if "name" in czt else ""
    cnames = cnames_blob.split(";")
    cmin = [int(v) for v in czt["minId"][()]]
    cmax = [int(v) for v in czt["maxId"][()]]
    cell_zones = {}
    for j, cid in enumerate(cids):
        nm = cnames[j] if j < len(cnames) and cnames[j] else f"cell{cid}"
        cell_zones[cid] = {"name": nm, "ncells": cmax[j] - cmin[j] + 1}

    extents = ((float(allxyz[:, 0].min()), float(allxyz[:, 0].max())),
               (float(allxyz[:, 1].min()), float(allxyz[:, 1].max())),
               (float(allxyz[:, 2].min()), float(allxyz[:, 2].max())))
    return {"zones": zones, "cell_zones": cell_zones, "centroids": centroids,
            "extents": extents}


def _plane_of(cent, extents, tol):
    """质心数组落在哪个范围面上：[(面名, 占比)]，面名 x-/x+/y-/y+/z-/z+。"""
    (x0, x1), (y0, y1), (z0, z1) = extents
    flags = []
    for axis, (lo, hi), names in ((0, (x0, x1), ("x-", "x+")),
                                  (1, (y0, y1), ("y-", "y+")),
                                  (2, (z0, z1), ("z-", "z+"))):
        v = cent[:, axis]
        if not len(v):
            continue
        frac_lo = float(np.nanmean(np.abs(v - lo) < tol))
        frac_hi = float(np.nanmean(np.abs(v - hi) < tol))
        if frac_lo > 0.95:
            flags.append((names[0], frac_lo))
        elif frac_hi > 0.95:
            flags.append((names[1], frac_hi))
    return flags


def _frac_on_extents(cent, extents, tol):
    """质心落在任意范围面上的行占比（0~1）。识别聚合外表面大区用。"""
    (x0, x1), (y0, y1), (z0, z1) = extents
    if not len(cent):
        return 0.0
    on = np.zeros(len(cent), dtype=bool)
    for axis, (lo, hi) in ((0, (x0, x1)), (1, (y0, y1)), (2, (z0, z1))):
        v = cent[:, axis]
        on |= (np.abs(v - lo) < tol) | (np.abs(v - hi) < tol)
    return float(np.nanmean(on))


def split_boundary_and_identify(cfg: dict, mesh_path: str | Path,
                                workdir: str | Path) -> dict:
    """单体域边界自动拆区 + 角色识别（外流场管线专用步骤）。

    1. 离线识别外表面大区（wall 区且 90% 以上面质心落在域范围面上）；
    2. Fluent 会话：sep-face-zone-angle 40° 拆成 6 个平面区，write-case 落盘
       <stem>_split.cas.h5（拆区是求解器命令，会话是 solver 模式）；
    3. 离线对拆后 case 的每个 wall 区做质心平面归属 -> inlet/outlet/symmetry/skin，
       cell 区按单元数 -> 主域 fluid / 飞机内腔 solid；
    4. 返回角色 -> zone id 映射，runner 回填 cfg 的 BC/wall_zone/cell 修正。
    """
    h5py = _require_h5py()
    src = Path(mesh_path).resolve()
    if not src.exists():
        return {"ok": False, "error": f"网格文件不存在: {src}"}
    workdir = Path(workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    stem = src.name[:-len(".msh.h5")] if src.name.endswith(".msh.h5") else src.stem
    split_mesh = (workdir / (stem + "_split.cas.h5")).resolve()

    # ---- 离线：识别外表面大区 ----
    try:
        with h5py.File(src, "r") as f:
            lay = _read_mesh_layout(f)
    except Exception as exc:
        return {"ok": False, "error": f"读取网格失败: {exc}"}
    extents = lay["extents"]
    tol = (max(hi - lo for lo, hi in extents)) * 0.01
    outer = []
    for zid, z in lay["zones"].items():
        if z["type"] != "wall":
            continue
        frac = _frac_on_extents(lay["centroids"][zid], extents, tol)
        if frac > 0.9:
            outer.append(zid)
    if len(outer) != 1:
        return {"ok": False,
                "error": (f"外表面大区识别到 {len(outer)} 个（期望 1）：{outer}。"
                          f"判据=wall 区且 90% 以上面质心落在（任意）域范围面上。")}
    outer_id = outer[0]

    # ---- Pass 1：solver 会话 sep + write-case ----
    exe = (cfg.get("fluent") or {}).get("exe")
    if not exe:
        from .adapters.journal_adapter import discover_fluent_exe
        exe = discover_fluent_exe()
    if not exe:
        return {"ok": False, "error": "fluent.exe 未发现"}
    jou = workdir / "split.jou"
    jou.write_text(
        f'/file/read-case "{src.as_posix()}"\n'
        f"/mesh/modify-zones/sep-face-zone-angle {outer_id} 40\n"
        "y\n"
        f'/file/write-case "{split_mesh.as_posix()}"\n'
        "exit\ny\n", encoding="utf-8")
    import subprocess as sp
    tlog = workdir / "split.log"
    with open(tlog, "w", encoding="utf-8", errors="replace") as tf:
        proc = sp.Popen([str(exe), "3d", "-t4", "-g", "-i", str(jou)],
                        stdout=tf, stderr=sp.STDOUT,
                        stdin=sp.DEVNULL, cwd=str(workdir))
        try:
            proc.wait(timeout=600)
        except sp.TimeoutExpired:
            return {"ok": False, "error": "拆区会话超时(600s)"}
    stext = tlog.read_text(encoding="utf-8", errors="replace")
    errs = [l.strip() for l in stext.splitlines() if re.match(r"^Error", l.strip())]
    if errs:
        return {"ok": False, "error": f"拆区会话报错: {errs[:3]}"}
    if not split_mesh.exists():
        return {"ok": False, "error": "拆区会话未产出 case 文件"}

    # ---- 离线：分类拆后 case ----
    try:
        with h5py.File(split_mesh, "r") as f:
            lay2 = _read_mesh_layout(f)
    except Exception as exc:
        return {"ok": False, "error": f"读取拆后 case 失败: {exc}"}
    extents2 = lay2["extents"]
    tol2 = (max(hi - lo for lo, hi in extents2)) * 0.01
    roles: dict[str, list[int]] = {}
    skin_candidates: list[int] = []
    for zid, z in lay2["zones"].items():
        if z["type"] != "wall":
            continue
        flags = _plane_of(lay2["centroids"][zid], extents2, tol2)
        on_plane = [p for p, fr in flags if fr > 0.95]
        if len(on_plane) == 1:
            roles.setdefault(on_plane[0], []).append(zid)
        else:
            skin_candidates.append(zid)
    # 影子对去重：两面墙互为影子（真机：skin 是 fluid|solid 两面墙），
    # 受力面取邻接 cell 区 = 主域的一侧
    if len(skin_candidates) == 2:
        a, b = skin_candidates
        if lay2["zones"][a].get("shadow", 0) == b:
            main_id = max(lay2["cell_zones"],
                          key=lambda z: lay2["cell_zones"][z]["ncells"])
            pick = [z for z in (a, b)
                    if lay2["zones"][z].get("c0_cell") == main_id]
            skin_candidates = pick or [a]

    need = ("x-", "x+", "y-", "y+", "z-", "z+")
    missing = [p for p in need if len(roles.get(p, [])) != 1]
    if missing:
        return {"ok": False,
                "error": (f"拆后边界区数量异常: {missing}；"
                          f"现有角色={ {k: v for k, v in roles.items()} }")}
    skin_zones = skin_candidates
    if len(skin_zones) != 1:
        return {"ok": False, "error": f"表皮区识别到 {len(skin_zones)} 个（期望 1）：{skin_zones}"}

    main_zid = max(lay2["cell_zones"], key=lambda z: lay2["cell_zones"][z]["ncells"])
    cell_fix = [{"zone": lay2["cell_zones"][main_zid]["name"], "type": "fluid"}]
    for zid, cz in sorted(lay2["cell_zones"].items()):
        if zid != main_zid:
            cell_fix.append({"zone": cz["name"], "type": "solid"})

    return {"ok": True, "split_mesh": str(split_mesh),
            "inlet": roles["x-"][0], "outlet": roles["x+"][0],
            "symmetry": [roles[p][0] for p in ("y-", "y+", "z-", "z+")],
            "skin": skin_zones[0],
            "cell_fix": cell_fix, "outer_id": outer_id}
