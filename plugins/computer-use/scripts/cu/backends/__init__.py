"""Backend selection.

``CU_BACKEND`` can force a specific backend, which is what the test suite and
the ``--demo`` path use::

    CU_BACKEND=fake     the deterministic virtual desktop (touches nothing)
    CU_BACKEND=windows  force the Windows backend (for diagnosing)
    CU_BACKEND=macos    force the macOS backend
    CU_BACKEND=linux    force the Linux backend
"""

import os
import sys

from .base import Backend, BackendError, UnsupportedAction

BACKEND_NAMES = ("fake", "windows", "macos", "linux")


def _platform_backend():
    if sys.platform.startswith("win"):
        from .windows import WindowsBackend

        return WindowsBackend()
    if sys.platform == "darwin":
        from .macos import MacBackend

        return MacBackend()
    from .linux import LinuxBackend

    return LinuxBackend()


def get_backend(name=None):
    requested = (name or os.environ.get("CU_BACKEND") or "").strip().lower()
    if requested in ("", "auto"):
        return _platform_backend()
    if requested == "fake":
        from .fake import FakeBackend

        return FakeBackend()
    if requested == "windows":
        from .windows import WindowsBackend

        return WindowsBackend()
    if requested == "macos":
        from .macos import MacBackend

        return MacBackend()
    if requested == "linux":
        from .linux import LinuxBackend

        return LinuxBackend()
    raise BackendError(
        "unknown CU_BACKEND %r; expected one of: %s" % (requested, ", ".join(BACKEND_NAMES))
    )


__all__ = [
    "Backend",
    "BackendError",
    "UnsupportedAction",
    "BACKEND_NAMES",
    "get_backend",
]
