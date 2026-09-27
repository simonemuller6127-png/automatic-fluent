# -*- coding: utf-8 -*-
"""cleanup_runs —— runs/ 目录磁盘卫生工具（2026-09-27，70GB 事故后立规）。

run 目录的三大垃圾源（均为真机实证）：
  1. FM_LAPTOP-*/ 目录        —— TGrid CAD 转换器的工作缓存（.sf/.pmdb/.tgf/中间h5），
                                 每次网格运行自动重建。失控时单个 .sf 可达 1.7GB。
  2. *.sf                     —— 尺寸场背景网格。单位 bug 时代（0.02mm 细分）单个 1.7GB；
                                 修复后同几何 0.05s 生成、KB 级，旧文件全是化石。
  3. *.trn                    —— Fluent 自动 transcript，与 transcript.log 内容重复。
另：selftest_*/ 目录每次自测全部重新生成，可随时删。

用法：
  python tools/cleanup_runs.py                 # 预览（dry-run，只报告不动手）
  python tools/cleanup_runs.py --apply         # 真删
  python tools/cleanup_runs.py --apply --max-age-days 7   # 只删 7 天前的
  python tools/cleanup_runs.py --keep diag_wf  # 额外保护某目录（逗号分隔）

永不触碰：summary.json / results.csv / failpack/ / transcript.log / mesh.jou /
domain_meta.json / build_domain.log / *.step / *.msh.h5（网格产物）。
"""
from __future__ import annotations

import argparse
import shutil
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "runs"

# 目录名前缀：整个目录可删
DIR_PREFIXES = ("FM_", "selftest_")
# 文件后缀：可删（全 runs 范围）
FILE_SUFFIXES = (".sf", ".trn")
# 永久保护（任何模式下不动）
PROTECT_NAMES = {"summary.json", "results.csv", "transcript.log", "mesh.jou",
                 "domain_meta.json", "build_domain.log", "forces.lis", "result.ok"}
PROTECT_SUFFIXES = (".step", ".msh.h5", ".jou", ".json", ".csv", ".md", ".py")


def human(n: float) -> str:
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return f"{n:,.1f} {u}"
        n /= 1024
    return f"{n:,.1f} TB"


def dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())


def main() -> int:
    ap = argparse.ArgumentParser(description="runs/ 磁盘卫生（默认 dry-run）")
    ap.add_argument("--apply", action="store_true", help="真删（默认只报告）")
    ap.add_argument("--max-age-days", type=float, default=0.0,
                    help="只处理 N 天前修改的条目（0 = 不限）")
    ap.add_argument("--keep", type=str, default="",
                    help="额外保护的目录名（逗号分隔，支持前缀匹配）")
    args = ap.parse_args()
    extra_keep = tuple(s for s in args.keep.split(",") if s)
    cutoff = time.time() - args.max_age_days * 86400 if args.max_age_days > 0 else None

    if not RUNS.exists():
        print("runs/ 不存在")
        return 0

    targets: list[Path] = []
    total = 0
    for p in sorted(RUNS.iterdir()):
        age_ok = cutoff is None or p.stat().st_mtime < cutoff
        if p.is_dir() and (p.name.startswith(DIR_PREFIXES) or
                           any(p.name.startswith(k) for k in extra_keep)):
            if age_ok:
                targets.append(p)
        elif p.is_file() and p.suffix.lower() in FILE_SUFFIXES and age_ok:
            if p.name not in PROTECT_NAMES and not p.name.endswith(PROTECT_SUFFIXES):
                targets.append(p)
        # 子目录里的垃圾文件（如 <run>/FM_*/ 的 .sf 与 *.trn）
        if p.is_dir() and not p.name.startswith(DIR_PREFIXES):
            for sub in p.rglob("*"):
                if sub.is_file():
                    if sub.suffix.lower() in FILE_SUFFIXES and sub.name not in PROTECT_NAMES:
                        if cutoff is None or sub.stat().st_mtime < cutoff:
                            targets.append(sub)

    # 去重 + 排除被保护父目录里的文件
    seen: set[Path] = set()
    plan: list[tuple[Path, int]] = []
    for t in targets:
        if t in seen or any(t.name == k or t.name.startswith(k) for k in ("summary",)):
            continue
        if t.suffix.lower() in PROTECT_SUFFIXES and t.is_file():
            continue
        seen.add(t)
        sz = dir_size(t) if t.is_dir() else t.stat().st_size
        plan.append((t, sz))
        total += sz

    if not plan:
        print("没有可清理的垃圾。")
        return 0
    for t, sz in sorted(plan, key=lambda x: -x[1]):
        print(f"  {human(sz):>12}  {t.relative_to(RUNS)}")
    print(f"\n合计 {human(total)} / {len(plan)} 项  模式={'APPLY' if args.apply else 'DRY-RUN'}")

    if args.apply:
        freed = 0
        for t, _ in plan:
            try:
                if t.is_dir():
                    shutil.rmtree(t)
                else:
                    t.unlink()
                freed += 1
            except OSError as exc:
                print(f"  跳过 {t}: {exc}")
        print(f"已清理 {freed} 项")
    else:
        print("（预览模式，加 --apply 才会真删）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
