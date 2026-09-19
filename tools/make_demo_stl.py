# -*- coding: utf-8 -*-
"""make_demo_stl —— 生成 3D 通道演示几何 STL（三个 solid = 三个命名区域）。

用途：给 Fluent Meshing watertight 工作流提供多区域 STL（solid 名 → 面区域名），
使 inlet/outlet/wall 在导入后即为独立面区域（M3 校准/管道演示几何）。
尺寸与 meshes/channel2d.msh 一致：x∈[0,0.1], y∈[0,0.01], z∈[0,0.01]（m）。

用法：python tools/make_demo_stl.py [out.stl]
"""
from __future__ import annotations

import sys
from pathlib import Path

LX, LY, LZ = 0.1, 0.01, 0.01


def tri(n, a, b, c):
    return (f"  facet normal {n[0]:.6e} {n[1]:.6e} {n[2]:.6e}\n"
            f"    outer loop\n"
            f"      vertex {a[0]:.6e} {a[1]:.6e} {a[2]:.6e}\n"
            f"      vertex {b[0]:.6e} {b[1]:.6e} {b[2]:.6e}\n"
            f"      vertex {c[0]:.6e} {c[1]:.6e} {c[2]:.6e}\n"
            f"    endloop\n"
            f"  endfacet\n")


def main(out: str) -> int:
    v = {
        "000": (0, 0, 0), "100": (LX, 0, 0), "010": (0, LY, 0), "110": (LX, LY, 0),
        "001": (0, 0, LZ), "101": (LX, 0, LZ), "011": (0, LY, LZ), "111": (LX, LY, LZ),
    }
    parts = []

    # inlet：x=0 面（2 三角形）
    s = "solid inlet\n"
    s += tri((-1, 0, 0), v["000"], v["001"], v["011"])
    s += tri((-1, 0, 0), v["000"], v["011"], v["010"])
    s += "endsolid inlet\n"
    parts.append(s)

    # outlet：x=LX 面
    s = "solid outlet\n"
    s += tri((1, 0, 0), v["100"], v["110"], v["111"])
    s += tri((1, 0, 0), v["100"], v["111"], v["101"])
    s += "endsolid outlet\n"
    parts.append(s)

    # wall：其余 4 面（y=0/y=LY/z=0/z=LZ）
    s = "solid wall\n"
    s += tri((0, -1, 0), v["000"], v["100"], v["101"])   # y=0
    s += tri((0, -1, 0), v["000"], v["101"], v["001"])
    s += tri((0, 1, 0), v["010"], v["011"], v["111"])    # y=LY
    s += tri((0, 1, 0), v["010"], v["111"], v["110"])
    s += tri((0, 0, -1), v["000"], v["010"], v["110"])   # z=0
    s += tri((0, 0, -1), v["000"], v["110"], v["100"])
    s += tri((0, 0, 1), v["001"], v["101"], v["111"])    # z=LZ
    s += tri((0, 0, 1), v["001"], v["111"], v["011"])
    s += "endsolid wall\n"
    parts.append(s)

    out_p = Path(out)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    out_p.write_text("".join(parts), encoding="utf-8")
    print(f"written {out_p}: 3 solids (inlet/outlet/wall), 12 triangles")
    return 0


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "meshes/channel_domain.stl"
    raise SystemExit(main(out))
