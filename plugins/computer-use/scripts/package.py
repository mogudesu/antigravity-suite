#!/usr/bin/env python3
"""Build the distributable plugin zip from an explicit, reproducible file list.

    python3 scripts/package.py [target.zip]

Every file under the plugin root is included except bytecode and editor
leftovers, so a stale ``__pycache__`` can never end up in a release. Scripts are
stored executable, data files are not.
"""

import os
import stat
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_TARGET = os.path.join(os.path.dirname(ROOT), "computer-use-plugin-v1.1.0.zip")
SKIP_DIRS = {"__pycache__", ".git", ".pytest_cache", "node_modules", ".idea", ".vscode"}
SKIP_SUFFIX = (".pyc", ".pyo", ".pyd", ".DS_Store", ".swp", ".orig", ".rej")
EXECUTABLE = (".py", ".sh")
TOP_LEVEL = "computer-use"
FIXED_TIME = (1980, 1, 1, 0, 0, 0)  # reproducible archives


def collect(root=None):
    """Relative paths of everything that belongs in the package."""
    root = root or ROOT
    found = []
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name not in SKIP_DIRS)
        for name in sorted(files):
            if name.endswith(SKIP_SUFFIX):
                continue
            found.append(os.path.relpath(os.path.join(base, name), root))
    return found


def mode_for(relative):
    return 0o755 if relative.endswith(EXECUTABLE) else 0o644


def build(target=None, root=None):
    root = root or ROOT
    target = target or DEFAULT_TARGET
    files = collect(root)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for relative in files:
            entry = zipfile.ZipInfo(
                "%s/%s" % (TOP_LEVEL, relative.replace(os.sep, "/")), date_time=FIXED_TIME
            )
            entry.external_attr = (mode_for(relative) | stat.S_IFREG) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            with open(os.path.join(root, relative), "rb") as handle:
                archive.writestr(entry, handle.read())
    return target, files


def main(argv=None):
    argv = list(argv if argv is not None else sys.argv[1:])
    target = argv[0] if argv else DEFAULT_TARGET
    target, files = build(target)
    size = os.path.getsize(target)
    print("packaged %d file(s) into %s (%.1f KB)" % (len(files), target, size / 1024.0))
    for relative in files:
        print("  %s %s" % (oct(mode_for(relative))[2:], relative))
    return 0


if __name__ == "__main__":
    sys.exit(main())
