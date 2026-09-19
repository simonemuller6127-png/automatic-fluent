# -*- coding: utf-8 -*-
"""spaceclaim_box_domain.py —— M2 内层几何脚本（IronPython，SpaceClaim/SCDM 执行）。

执行方式（由 aeroharness/geometry.py 生成包装脚本调用，勿手工直接跑）：
  SpaceClaim.exe /RunScript=<生成的脚本> /ExitAfterScript=True

职责边界（6.8.3 铁律）：本脚本只做几何；参数由外层 CPython 写入 JSON，
路径已固化在生成的包装脚本里。日志自写文件，便于无头排错。

产物：domain.scdoc + geometry_manifest.json（named selections 自证清单，6.8.4 验证用）。
"""
import json
import sys
import traceback

# ---------------------------------------------------------------- 日志与参数
LOG = None
PARAMS = None


def log(msg):
    LOG.write(str(msg) + "\n")
    LOG.flush()


# ---------------------------------------------------------------- API 命名空间自适应
Api = None
for _ver in ("V22", "V21", "V20", "V19", "V18"):
    try:
        _m = __import__("SpaceClaim.Api." + _ver, fromlist=["*"])
        globals().update({k: getattr(_m, k) for k in dir(_m) if not k.startswith("_")})
        Api = _ver
        break
    except Exception:
        continue


def main():
    log("SpaceClaim geometry script start; Api=" + str(Api))
    if PARAMS is None:
        raise RuntimeError("参数 JSON 未注入")

    box = PARAMS["box"]
    ox, oy, oz = [float(v) for v in box["origin"]]
    sx, sy, sz = [float(v) for v in box["size"]]
    names = PARAMS.get("named_selections", {"inlet": "xmin", "outlet": "xmax", "wall": "rest"})
    import_cad = PARAMS.get("import_cad")

    doc = Document.ActiveDocument
    design = doc.MainPart

    # ---- 可选：导入外部 CAD（如飞机 x_t/stp），随后对其做包围盒域（E10 场景）----
    if import_cad:
        log("importing CAD: " + str(import_cad))
        DesignBody.Add(doc, import_cad)  # 占位：以本机录制宏校准导入命令

    # ---- 创建长方体计算域（origin 为角点，size 为三向尺寸）----
    mm = 0.001  # API 长度单位为米
    origin = Point.Create((ox) * mm, (oy) * mm, (oz) * mm)
    frame = Frame.Create(origin, Direction.Create(0, 0, 1), Direction.Create(1, 0, 0))
    log("creating box %.3f x %.3f x %.3f m" % (sx, sy, sz))
    body = BoxBody.Create(frame, sx * mm, sy * mm, sz * mm)

    faces = list(body.Faces)
    log("box faces: %d" % len(faces))

    def face_center(f):
        bb = f.Shape.BoundingBox
        c = bb.Center
        return c.X, c.Y, c.Z

    groups = {"inlet": [], "outlet": [], "wall": []}
    for f in faces:
        cx, cy, cz = face_center(f)
        if abs(cx - ox) < 1e-6:
            groups["inlet"].append(f)
        elif abs(cx - (ox + sx)) < 1e-6:
            groups["outlet"].append(f)
        else:
            groups["wall"].append(f)

    created = []
    for name in ("inlet", "outlet", "wall"):
        target = names.get(name, name)
        ns = NamedSelection.Create(target, "")
        for f in groups[name]:
            NamedSelection.Add(ns, f)
        created.append(target)
        log("named selection '%s': %d faces" % (target, len(groups[name])))

    doc.SaveAs(PARAMS["out_scdoc"])
    manifest = {
        "named_selections": created,
        "box_origin_m": [ox, oy, oz],
        "box_size_m": [sx, sy, sz],
        "api_version": Api,
        "ok": True,
    }
    with open(PARAMS["manifest"], "w") as fp:
        json.dump(manifest, fp, ensure_ascii=False, indent=2)
    log("saved: " + PARAMS["out_scdoc"])
    log("DONE")


try:
    sys_path_note = sys.version  # IronPython
    # 参数路径由生成的包装脚本注入：__PARAMS_JSON__
    import clr  # noqa
    PARAMS = json.load(open(r"__PARAMS_JSON__", "r", encoding="utf-8"))
    LOG = open(PARAMS["log"], "w", encoding="utf-8")
except Exception:
    LOG = LOG or open(r"__PARAMS_JSON__.log", "w")
    import traceback as _tb
    _tb.print_exc(file=LOG)
    raise

try:
    main()
except Exception:
    log("FATAL:")
    log(traceback.format_exc())
    raise
finally:
    LOG.close()
