# -*- coding: utf-8 -*-
"""mesh_post —— 网格产物后处理：把 WTM 写出的两面界面区修正为 interior。

背景（2026-09-27 真机实证，7 体外流场域）：
  Watertight 工作流 Join 相邻实体的界面后，界面区在产物 .msh.h5 里仍是
  **wall** 类型（Update Boundaries 对非关键字名的默认处置）。求解器读入后
  wall 型两面区生成 shadow 对，把每块体封死——流场无法建立，力恒为零。
  求解器 TUI **无法**修复：`/mesh/modify-zones/zone-type` 拒绝 interior
  （"interior" 不在合法类型表里）。因此只能在文件层修。

Fluent .msh.h5 的 zone 类型存**两层**，补丁必须同步改：
  1. meshes/1/faces/zoneTopology/zoneType —— 面类型整数码
     （实测：interior=2、wall=3、pressure-outlet=5、pressure-far-field=9、
      velocity-inlet=10；以文件内原生 interior 区的码为准，不硬编码）
  2. settings/Thread Variables —— scheme 文本，每 zone 一条
     `(39 (<id> <类型> <名字>)(\n))`，solver 建 domain 时以此为准
     （只改第 1 层时 solver 照样按本表创建 shadow）。

两面区判据（通用，无需硬编码 zone id）：
  faces/c1/<row> 存在非零单元索引 <=> 该面两侧都有单元 <=> 必须是 interior。
  真边界（外表面/飞机表皮）c1 全 0，保持原类型。

铁律（违反即被 Fluent 拒读）：
  * 补丁副本命名必须以 **.msh.h5** 结尾，否则 read-case 会去找 *.cas.h5；
  * h5py 只允许**原位写同 shape 同 dtype** 的数组，禁止删除/重建任何数据集
    （重建会把定长字符串变成变长，Fluent 的 HDF5 读取器直接报 iostream error）。
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
            "缺失时 7 体域管线无法自动打通。") from exc
    import h5py
    return h5py


def default_out_path(msh_path: str | Path) -> Path:
    """补丁副本路径：<name>_patched.msh.h5（必须保留 .msh.h5 后缀，见模块 docstring）。"""
    p = Path(msh_path)
    name = p.name
    if name.endswith(".msh.h5"):
        out = p.parent / (name[: -len(".msh.h5")] + "_patched.msh.h5")
    else:
        out = p.parent / (p.stem + "_patched.msh.h5")
    if not out.name.endswith(".msh.h5"):
        out = p.parent / (out.name + ".msh.h5")
    return out


def _patch_thread_variables(blob: str, zone_ids: set[int]) -> tuple[str, list[int]]:
    """把 Thread Variables scheme 文本里 zone_ids 的条目改成 interior。

    返回 (新文本, 实际改写的 id 列表)。纯字符串操作，可离线单测。
    字节预算策略：先收紧每条目的空内层表 `)(\\n))` -> `)())`（每条省 1 字节，
    scheme 语义等价——空表 `(<空白>)` 就是 `()`），再把 `wall` 换成 `interior`
    （每条 +4 字节），名字去 `freeparts-` 前缀补足剩余预算。
    """
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
    """把 msh_path 里所有两面（两侧都有单元）的非 interior 面区改成 interior。

    只在副本上操作（原网格保留），返回报告 dict：
      {ok, patched: [zone_id], out_mesh, total_two_sided, error?}
    """
    h5py = _require_h5py()
    src = Path(msh_path)
    if not src.exists():
        return {"ok": False, "error": f"网格文件不存在: {src}"}
    out = Path(out_path) if out_path else default_out_path(src)
    if not out.name.endswith(".msh.h5"):
        return {"ok": False, "error": f"补丁副本命名必须以 .msh.h5 结尾: {out}"}
    shutil.copy(src, out)

    def _log(msg: str):
        if log:
            log(msg)

    with h5py.File(out, "r+") as f:
        zt = f["meshes/1/faces/zoneTopology"]
        ids = zt["id"][()]
        ztype = zt["zoneType"][()]
        znames = zt["name"][0].decode("utf-8").split(";")
        n_rows = len(ids)
        if len(znames) != n_rows:
            return {"ok": False, "error": f"zoneTopology 名字数({len(znames)})与行数({n_rows})不符"}

        # 参考码：文件内原生 interior 区（名字以 interior-- 开头）
        ref_type = None
        for i in range(n_rows):
            if znames[i].startswith("interior--"):
                ref_type = int(ztype[i])
                break
        if ref_type is None:
            ref_type = 2  # Fluent 惯例值；单流体区正常写出的网格必有 interior-- 区

        # ---- 识别两面区：c0 与 c1 都有非零单元索引 ----
        # ⚠️ 不能只测 c1：单面区（外表面/飞机表皮）的单元侧可能落在 c1（c0 全 0），
        # 2026-09-28 真机事故：skin 被误判两面改成 interior，read-case 直接拒绝
        # （"only one adjacent cell thread"）并中止。两面 = 两侧都有单元。
        two_sided: list[int] = []  # zone id
        rows_of: dict[int, int] = {}
        for k in range(1, n_rows + 1):
            zid = int(ids[k - 1])
            c0 = f[f"meshes/1/faces/c0/{k}"][()]
            c1 = f[f"meshes/1/faces/c1/{k}"][()]
            if (c0 != 0).any() and (c1 != 0).any():
                two_sided.append(zid)
                rows_of[zid] = k

        to_patch = [zid for zid in two_sided if int(ztype[ids.tolist().index(zid)]) != ref_type]
        _log(f"两面区 {len(two_sided)} 个，其中非 interior {len(to_patch)} 个")

        # ---- 第 1 层：zoneTopology 原位写 ----
        for zid in to_patch:
            i = ids.tolist().index(zid)
            ztype[i] = ref_type
        if to_patch:
            zt["zoneType"][...] = ztype

        # ---- 第 2 层：settings/Thread Variables scheme 文本 ----
        tv_changed: list[int] = []
        if "settings/Thread Variables" in f and to_patch:
            d = f["settings/Thread Variables"]
            itemsize = d.dtype.itemsize
            blob = d[0].decode("utf-8")
            new_blob, tv_changed = _patch_thread_variables(blob, set(to_patch))
            new_bytes = new_blob.encode("utf-8")
            if len(new_bytes) > itemsize:
                return {"ok": False,
                        "error": (f"Thread Variables 补丁超预算：{len(new_bytes)} > {itemsize} 字节。"
                                  "需要更强的名字缩短策略，禁止重建数据集（Fluent 会拒读）。")}
            import numpy as np
            d[...] = np.array([new_bytes], dtype=d.dtype)  # 原位写，NUL 填充，不重建数据集

        # ---- 自检：重开文件断言 ----
    with h5py.File(out, "r") as f2:
        zt2 = f2["meshes/1/faces/zoneTopology"]
        ids2 = zt2["id"][()].tolist()
        zt2v = zt2["zoneType"][()]
        bad = [zid for zid in two_sided if int(zt2v[ids2.index(zid)]) != ref_type]
        if bad:
            return {"ok": False, "error": f"自检失败，仍有两面区非 interior: {bad}"}
        if "settings/Thread Variables" in f2:
            blob2 = f2["settings/Thread Variables"][0].decode("utf-8")
            leftover = [zid for zid in to_patch
                        if re.search(r"\(39 \(" + str(zid) + r" wall ", blob2)]
            if leftover:
                return {"ok": False, "error": f"Thread Variables 仍有 wall 条目: {leftover}"}

    return {"ok": True, "patched": to_patch, "tv_changed": tv_changed,
            "two_sided_total": len(two_sided), "out_mesh": str(out),
            "interior_code": ref_type}


# ======================================================================
# 单体域边界拆区 + 角色识别（2026-09-28，外流场路线的最后一环）
# ======================================================================

def _load_zone_table(f, tv_text):
    """读取 zone 表：返回 (ids, ztypes, names, tv条目{id:(type,name)})。"""
    zt = f["meshes/1/faces/zoneTopology"]
    ids = [int(v) for v in zt["id"][()]]
    ztypes = [int(v) for v in zt["zoneType"][()]]
    names = zt["name"][0].decode("utf-8").split(";")
    entries = {}
    if tv_text:
        for zid in ids:
            m = re.search(r"\(39 \(" + str(zid) + r" (\S+) ([^)]*)\)\(", tv_text)
            if m:
                entries[zid] = (m.group(1), m.group(2))
    return ids, ztypes, names, entries


def _zone_face_centroids(f, row: int):
    """第 row 行 zone 的逐面质心坐标数组。"""
    nn = f[f"meshes/1/faces/nodes/{row}/nnodes"][()]
    nd = f[f"meshes/1/faces/nodes/{row}/nodes"][()]
    nzt = f["meshes/1/nodes/zoneTopology"]
    nmin = [int(v) for v in nzt["minId"][()]]
    nmax = [int(v) for v in nzt["maxId"][()]]
    pools = []
    for j in range(len(nmin)):
        try:
            pools.append(f[f"meshes/1/nodes/coords/{j+1}"][()])
        except KeyError:
            pools.append(None)

    def node_xyz(gids):
        gids = np.asarray(gids)
        out = np.full((len(gids), 3), np.nan)
        for j in range(len(nmin)):
            if pools[j] is None:
                continue
            sel = (gids >= nmin[j]) & (gids <= nmax[j])
            if sel.any():
                out[sel] = pools[j][gids[sel] - nmin[j]]
        return out

    cents = np.full((len(nn), 3), np.nan)
    start = 0
    for fi, n in enumerate(nn):
        xyz = node_xyz(nd[start:start + n])
        start += n
        if not np.isnan(xyz).any():
            cents[fi] = xyz.mean(axis=0)
    return cents


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
    """质心落在**任意**范围面上的行占比（0~1）。

    用于识别"聚合外表面大区"：未拆分时 6 个外表面共处一个 wall 区，
    单个面的占比只有 ~1/6，必须按'任意面'合计占比判断。
    """
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
    """单体域边界自动拆区（外流场管线专用步骤，2026-09-28）。

    单体域网格干净（无贴片折皱），但 6 个外表面 + 飞机表皮被 WTM 归入
    1-2 个 wall 大区，无法按面设 BC。本函数：
      1. 离线识别"外表面大区"（faces 质心 95% 以上落在域范围面上的 wall 区）；
      2. 跑一遍 Fluent：sep-face-zone-angle 40° 把它拆成 6 个平面区，另存
         <stem>_split.msh.h5（.msh.h5 后缀铁律）；
      3. 离线对拆后网格逐 wall 区做质心平面归属 -> inlet/outlet/symmetry/skin，
         cell 区按单元数 -> 主域 fluid / 飞机内腔 solid；
      4. 返回角色 -> zone id 映射，runner 回填 cfg 的 BC/wall_zone/cell 修正。
    """
    h5py = _require_h5py()
    src = Path(mesh_path)
    if not src.exists():
        return {"ok": False, "error": f"网格文件不存在: {src}"}
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    stem = src.name[:-len(".msh.h5")] if src.name.endswith(".msh.h5") else src.stem
    # sep-face-zone-angle 是求解器命令 -> 拆区会话是 solver 模式，
    # 产物用 /file/write-case 落盘（write-mesh 是 meshing 模式命令，不存在）
    split_mesh = workdir / (stem + "_split.cas.h5")

    # ---- 离线：全域范围 + 识别外表面大区 ----
    with h5py.File(src, "r") as f:
        ids, ztypes, names, _ = _load_zone_table(f, None)
        nzt = f["meshes/1/nodes/zoneTopology"]
        nmin = [int(v) for v in nzt["minId"][()]]
        nmax = [int(v) for v in nzt["maxId"][()]]
        lo = np.full(3, np.inf); hi = np.full(3, -np.inf)
        for j in range(len(nmin)):
            try:
                co = f[f"meshes/1/nodes/coords/{j+1}"][()]
            except KeyError:
                continue
            lo = np.minimum(lo, co.min(axis=0)); hi = np.maximum(hi, co.max(axis=0))
        extents = ((lo[0], hi[0]), (lo[1], hi[1]), (lo[2], hi[2]))
        tol = float(np.max(hi - lo)) * 0.01
        from collections import Counter
        wall_code = max((c for c, n in Counter(ztypes).items() if c != 2),
                        key=lambda c: Counter(ztypes)[c], default=3)
        outer = []
        for k in range(1, len(ids) + 1):
            if ztypes[k - 1] != wall_code:
                continue
            frac_any = _frac_on_extents(_zone_face_centroids(f, k), extents, tol)
            if frac_any > 0.9:
                outer.append(int(ids[k - 1]))
    if len(outer) != 1:
        return {"ok": False,
                "error": (f"外表面大区识别到 {len(outer)} 个（期望 1）：{outer}。"
                          f"判据=wall 区且 90% 以上面质心落在（任意）域范围面上。")}
    outer_id = outer[0]

    # ---- Pass 1：Fluent sep + 写拆分网格 ----
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
    errs = [l.strip() for l in stext.splitlines()
            if re.match(r"^Error", l.strip())]
    if errs:
        return {"ok": False, "error": f"拆区会话报错: {errs[:3]}"}
    if not split_mesh.exists():
        return {"ok": False, "error": "拆区会话未产出网格文件"}

    # ---- 离线：分类拆后网格的 wall 区与 cell 区 ----
    with h5py.File(split_mesh, "r") as f:
        tv_text = None
        if "settings/Thread Variables" in f:
            tv_text = f["settings/Thread Variables"][0].decode("utf-8")
        ids2, ztypes2, names2, entries = _load_zone_table(f, tv_text)
        nzt = f["meshes/1/nodes/zoneTopology"]
        nmin = [int(v) for v in nzt["minId"][()]]
        nmax = [int(v) for v in nzt["maxId"][()]]
        lo = np.full(3, np.inf); hi = np.full(3, -np.inf)
        for j in range(len(nmin)):
            try:
                co = f[f"meshes/1/nodes/coords/{j+1}"][()]
            except KeyError:
                continue
            lo = np.minimum(lo, co.min(axis=0)); hi = np.maximum(hi, co.max(axis=0))
        extents = ((lo[0], hi[0]), (lo[1], hi[1]), (lo[2], hi[2]))
        roles: dict[str, list[int]] = {}
        skin_zones: list[int] = []
        for k in range(1, len(ids2) + 1):
            zid = ids2[k - 1]
            ent = entries.get(zid)
            if not ent or ent[0] != "wall":
                continue
            flags = _plane_of(_zone_face_centroids(f, k), extents, tol)
            on_plane = [p for p, fr in flags if fr > 0.95]
            if len(on_plane) == 1:
                roles.setdefault(on_plane[0], []).append(zid)
            else:
                skin_zones.append(zid)
        czt = f["meshes/1/cells/zoneTopology"]
        cids = [int(v) for v in czt["id"][()]]
        cnames = czt["name"][0].decode("utf-8").split(";")
        cmin = [int(v) for v in czt["minId"][()]]
        cmax = [int(v) for v in czt["maxId"][()]]
        cells_of = {cids[j]: (cmax[j] - cmin[j] + 1, cnames[j])
                    for j in range(len(cids))}

    need = ("x-", "x+", "y-", "y+", "z-", "z+")
    missing = [p for p in need if len(roles.get(p, [])) != 1]
    if missing:
        return {"ok": False,
                "error": (f"拆后边界区数量异常: {missing}；"
                          f"现有角色={ {k: [i for i in v] for k, v in roles.items()} }")}
    if len(skin_zones) != 1:
        return {"ok": False, "error": f"表皮区识别到 {len(skin_zones)} 个（期望 1）"}

    main_zid = max(cells_of, key=lambda z: cells_of[z][0])
    cell_fix = [{"zone": cells_of[main_zid][1], "type": "fluid"}]
    for zid, (n, nm) in sorted(cells_of.items()):
        if zid != main_zid:
            cell_fix.append({"zone": nm, "type": "solid"})

    return {"ok": True, "split_mesh": str(split_mesh),
            "inlet": roles["x-"][0], "outlet": roles["x+"][0],
            "symmetry": [roles[p][0] for p in ("y-", "y+", "z-", "z+")],
            "skin": skin_zones[0],
            "cell_fix": cell_fix, "outer_id": outer_id}
