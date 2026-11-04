"""Test suite for the computer-use plugin. Run with: python3 scripts/tests/run_all.py"""

import sys

# Importing the plugin would otherwise leave __pycache__ directories in
# the folder that gets packaged.
sys.dont_write_bytecode = True
