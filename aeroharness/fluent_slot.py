# -*- coding: utf-8 -*-
"""FluentSlot —— 许可证并发锁（调研报告 6.7/6.8.5）。

所有执行入口统一走它：同一台机上同一时刻只放行一个 Fluent 实例。
实现：锁文件 O_CREAT|O_EXCL + PID 活性检测（僵尸锁自动接管）+ 轮询超时。
"""
from __future__ import annotations

import ctypes
import os
import time
from pathlib import Path


class SlotBusy(Exception):
    pass


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            k32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if handle:
                k32.CloseHandle(handle)
                return True
            return False
        except Exception:
            return True  # 检测不了就当活着，避免误抢
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


class FluentSlot:
    def __init__(self, lock_dir: str | os.PathLike, timeout_s: float = 3600.0,
                 poll_s: float = 2.0, stale_s: float = 600.0):
        self.lock_path = Path(lock_dir) / "fluent_slot.lock"
        self.timeout_s = float(timeout_s)
        self.poll_s = float(poll_s)
        self.stale_s = float(stale_s)
        self._acquired = False

    def _read_lock(self) -> tuple[int, float] | None:
        try:
            txt = self.lock_path.read_text(encoding="utf-8").strip()
            pid_s, ts_s = txt.split("|")
            return int(pid_s), float(ts_s)
        except Exception:
            return None

    def _try_create(self) -> bool:
        try:
            fd = os.open(str(self.lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(f"{os.getpid()}|{time.time()}")
            return True
        except FileExistsError:
            return False

    def acquire(self) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + self.timeout_s
        while True:
            if self._try_create():
                self._acquired = True
                return
            info = self._read_lock()
            if info is None:
                # 半写状态，短暂等待后重试
                time.sleep(0.2)
                continue
            pid, ts = info
            if not _pid_alive(pid) or (time.time() - ts) > self.stale_s:
                try:
                    self.lock_path.unlink()  # 僵尸锁接管
                except OSError:
                    pass
                continue
            if time.time() >= deadline:
                raise SlotBusy(
                    f"Fluent 许可锁被 PID={pid} 占用且超时 {self.timeout_s:.0f}s 未释放"
                    f"（lock={self.lock_path}）。如有残留锁可手动删除该文件。"
                )
            time.sleep(self.poll_s)

    def release(self) -> None:
        if self._acquired:
            try:
                self.lock_path.unlink()
            except OSError:
                pass
            self._acquired = False

    def __enter__(self) -> "FluentSlot":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()
