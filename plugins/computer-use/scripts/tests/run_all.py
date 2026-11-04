#!/usr/bin/env python3
"""Run the whole suite: python3 scripts/tests/run_all.py [module ...]"""

import importlib
import os
import sys
import time

sys.dont_write_bytecode = True

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

ORDER = [
    "test_policy",
    "test_protocol",
    "test_imaging",
    "test_tools",
    "test_overlay",
    "test_windows",
    "test_hook",
    "test_manifest",
    "test_robustness",
    "test_scenario",
]


def main(argv=None):
    requested = [name for name in (argv if argv is not None else sys.argv[1:]) if not name.startswith("-")]
    names = requested or ORDER
    started = time.time()
    passed = failed = 0
    failures = []
    for name in names:
        module = importlib.import_module("tests." + name if "." not in name else name)
        try:
            good, bad = module.run()
        except Exception as exc:  # noqa: BLE001 - a crashing module is a failure
            import traceback
            traceback.print_exc()
            good, bad = 0, 1
            failures.append("%s crashed: %r" % (name, exc))
        passed += good
        failed += bad
        if bad:
            failures.append(name)
    elapsed = time.time() - started
    print("-" * 58)
    print("%d check(s) passed, %d failed in %.1fs" % (passed, failed, elapsed))
    if failures:
        print("failing module(s): %s" % ", ".join(failures))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
