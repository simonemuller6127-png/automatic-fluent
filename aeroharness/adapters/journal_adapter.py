# -*- coding: utf-8 -*-
"""JournalFluentAdapter —— 主执行器：fluent.exe -i journal 批处理（调研报告 6.0/6.2）。

mock 模式下用 tools/mock_fluent.py 顶替 fluent.exe，保证全链路可离线自测。
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from ..config import ROOT
from .base import AdapterResult, BaseFluentAdapter

MOCK_SCRIPT = ROOT / "tools" / "mock_fluent.py"

# v2XY → 发布版本：v222=2022R2, v231=2023R1, v232=2023R2, v241=2025R1 ...
def release_of(version_dir: str) -> str:
    m = version_dir.lower().lstrip("v")
    if len(m) >= 3 and m.isdigit():
        return f"20{m[:2]} R{m[2]}"
    return version_dir


def discover_fluent_exe(extra_roots: list[str] | None = None) -> Path | None:
    roots = [
        r"D:\Ansys-2023R1\ANSYS Inc",
        r"C:\Program Files\ANSYS Inc",
        r"D:\Program Files\ANSYS Inc",
        r"E:\Program Files\ANSYS Inc",
    ] + (extra_roots or [])
    best: tuple[int, Path] | None = None
    for root in roots:
        root_p = Path(root)
        if not root_p.exists():
            continue
        for vdir in sorted(root_p.glob("v*")):
            exe = vdir / "fluent" / "ntbin" / "win64" / "fluent.exe"
            if exe.exists():
                ver = vdir.name[1:] if vdir.name[1:].isdigit() else "0"
                if best is None or int(ver) > int(best[0]):
                    best = (ver, exe)
    return best[1] if best else None


def _kill_tree(pid: int) -> None:
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                           capture_output=True, timeout=20)
        except Exception:
            pass
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


class JournalFluentAdapter(BaseFluentAdapter):
    def execute(self, cfg: dict, run_dir: str, journal_path: str, attempt: int = 1) -> AdapterResult:
        run_dir_p = Path(run_dir)
        transcript = run_dir_p / "transcript.log"
        mode = cfg["fluent"]["mode"]
        timeout_s = float(cfg["fluent"]["timeout_s"])

        if mode == "mock":
            cmd = [sys.executable, str(MOCK_SCRIPT)]
        else:
            exe = cfg["fluent"].get("exe") or discover_fluent_exe()
            if not exe:
                raise RuntimeError(
                    "未找到 fluent.exe：请在配置 fluent.exe 指定路径，"
                    "或确认 ANSYS Inc 安装目录在常见位置（v*/fluent/ntbin/win64/fluent.exe）"
                )
            cmd = [str(exe)]

        dim = str(cfg["case"]["dim"]).lower()
        precision = str(cfg["case"].get("precision", "single")).lower()
        dim_tag = dim + ("dp" if precision == "double" else "")
        cmd += [dim_tag, f"-t{int(cfg['fluent']['parallel'])}", "-g",
                "-i", str(Path(journal_path).resolve())]
        cmd += list(cfg["fluent"].get("extra_args") or [])

        env = os.environ.copy()
        env["AERO_ATTEMPT"] = str(attempt)
        env.setdefault("PYTHONIOENCODING", "utf-8")

        t0 = time.time()
        timed_out = False
        with open(transcript, "w", encoding="utf-8", errors="replace") as tf:
            proc = subprocess.Popen(
                cmd, cwd=str(run_dir_p), stdout=tf, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,  # journal 未应答的 prompt 立即 EOF 报错，避免挂死
                env=env, text=True,
            )
            try:
                proc.wait(timeout=timeout_s)
                exit_code = proc.returncode
            except subprocess.TimeoutExpired:
                timed_out = True
                _kill_tree(proc.pid)
                try:
                    proc.wait(timeout=30)
                except Exception:
                    pass
                exit_code = proc.returncode
                tf.write(f"\n[AEROHARNESS] 超时 {timeout_s:.0f}s，进程树已被终止 (pid={proc.pid})\n")

        status = "ok" if (exit_code == 0 and not timed_out) else "failed"
        return AdapterResult(
            status=status, exit_code=exit_code, transcript_path=str(transcript),
            journal_path=str(journal_path), duration_s=time.time() - t0, timed_out=timed_out,
        )
