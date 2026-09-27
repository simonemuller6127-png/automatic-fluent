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

        # ---- 识别两面区：c1 存在非零单元索引 ----
        two_sided: list[int] = []  # zone id
        rows_of: dict[int, int] = {}
        for k in range(1, n_rows + 1):
            zid = int(ids[k - 1])
            c1 = f[f"meshes/1/faces/c1/{k}"][()]
            if (c1 != 0).any():
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
