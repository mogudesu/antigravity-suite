#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Antigravity Native Sidecar Server for Wallpaper & Visual Theme Manager
"""

import os
import re
import hmac
import sys
import json
import time
import base64
import shutil
import atexit
import secrets
import tempfile
import threading
import subprocess
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

SIDE_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.abspath(os.path.join(SIDE_DIR, "..", ".."))
CONFIG_PATH = os.path.join(PLUGIN_DIR, "config", "config.json")
RUNTIME_PATH = os.path.join(PLUGIN_DIR, "config", "runtime.json")
LOCK_PATH = os.path.join(PLUGIN_DIR, "config", ".sidecar-lock.json")
TOKEN_PATH = os.path.join(PLUGIN_DIR, "config", ".sidecar-token")
PROMPTS_PATH = os.path.join(PLUGIN_DIR, "scripts", "prompts-custom.json")
SNAPSHOT_DIR = os.path.join(PLUGIN_DIR, "snapshots")
SCRIPTS_DIR = os.path.join(PLUGIN_DIR, "scripts")
APPLY_JS = os.path.join(SCRIPTS_DIR, "apply.js")
LIVE_JS = os.path.join(SCRIPTS_DIR, "live-daemon.js")
AUTOSTART_JS = os.path.join(SCRIPTS_DIR, "autostart.js")
RESTORE_JS = os.path.join(SCRIPTS_DIR, "restore.js")
UPDATE_JS = os.path.join(SCRIPTS_DIR, "update.js")
MCP_PROFILE_JS = os.path.join(SCRIPTS_DIR, "mcp-profile.js")
UPDATE_CFG_PATH = os.path.join(PLUGIN_DIR, "config", "update.json")
UPDATE_STATE_PATH = os.path.join(PLUGIN_DIR, "config", "update-state.json")
WALLPAPER_PATH = os.path.join(PLUGIN_DIR, "assets", "wallpaper.jpg")

LOOPBACK_HOST_RE = re.compile(r"^(?:127\.0\.0\.1|localhost)(?::\d+)?$", re.I)
LOOPBACK_ORIGIN_RE = re.compile(r"^https?://(?:127\.0\.0\.1|localhost)(?::\d+)?$", re.I)
SIDECAR_TOKEN = secrets.token_urlsafe(24)

HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_WALLPAPER_BYTES = 25 * 1024 * 1024

AGY_DIR = os.environ.get("ANTIGRAVITY_APP_DATA_DIR") or os.path.expanduser(r"~\.gemini\antigravity")
DEVTOOLS_PORT_FILE = os.path.join(os.environ.get("APPDATA") or os.path.expanduser(r"~\AppData\Roaming"), "Antigravity", "DevToolsActivePort")
NODE_EXE = r"C:\Program Files\nodejs\node.exe"
PLUGINS_DIR = os.path.expanduser(r"~\.gemini\config\plugins")
SKILLS_DIR = os.path.expanduser(r"~\.gemini\config\skills")
USER_SKILLS_DIR = os.path.expanduser(r"~\.gemini\skills")
IDE_SKILLS_DIR = os.path.expanduser(r"~\.gemini\antigravity-ide\skills")
BUILTIN_SKILLS_DIR = os.path.expanduser(r"~\.gemini\antigravity\builtin\skills")
MNEMON_PLUGIN = os.path.join(PLUGINS_DIR, "antigravity长期记忆-mogu")
MNEMON_CLI = os.path.join(MNEMON_PLUGIN, "scripts", "mnemon.mjs")
MNEMON_VAULT = os.path.expanduser(r"~\.gemini\memory\mnemon-vault")
MEMORY_MIRROR = os.path.expanduser(r"~\Documents\Antigravity-Memory-Backup")
COMPUTER_USE_PLUGIN = os.path.join(PLUGINS_DIR, "antigravity computer use-mogu")
CU_POLICY_PATH = os.path.expanduser(r"~\.gemini\memory\computer-use\policy.json")
BROWSER_BRIDGE_PLUGIN = os.path.join(PLUGINS_DIR, "antigravity-browser-bridge")
BROWSER_BRIDGE_PORT = 8767
LEGACY_I18N_DIR = os.path.expanduser(r"~\.gemini\antigravity\scratch\antigravity2.0-ChinesePlugin")
LEGACY_SHORTCUT = os.path.join(os.path.expanduser(r"~\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"), "AntigravityChinesePlugin.lnk")
LEGACY_BACKUP = os.path.join(LEGACY_I18N_DIR, "AntigravityChinesePlugin.lnk.retired")
BRAIN_DIR = os.path.join(AGY_DIR, "brain")
CASCADE_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")
TASK_ITEM_RE = re.compile(r"^\s*[-*]\s*`?\[([ xX/\-])\]`?\s+(.+?)\s*$")
_telemetry_lock = threading.Lock()
_telemetry_cache = {}

_live_lock = threading.Lock()
_live_process = None
_watch_state = {"last": 0, "available": False, "ran": 0, "lastRun": 0, "error": ""}
RUNTIME_PORT = [39290]

MEDIA_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
MEDIA_STREAM_CHUNK = 128 * 1024
MEDIA_EXT_MIMES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".ogv": "video/ogg",
}
_media_lock = threading.Lock()
_media_registry = {}

MEDIA_PLAYER_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    width: 100%;
    height: 100%;
    background: #06050d;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  video {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    background: #06050d;
    outline: none;
    display: block;
    cursor: pointer;
  }
</style>
</head>
<body>
<video id="v" preload="metadata" playsinline></video>
<script>
(() => {
  const LOOPBACK_RE = /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost)(?::\\d+)?$/i;
  const qs = new URLSearchParams(location.search);
  const channel = String(qs.get("channel") || "");
  const rawPo = String(qs.get("po") || "");
  let parentOrigin = LOOPBACK_RE.test(rawPo) ? rawPo : "";
  const v = document.getElementById("v");
  let suppressErrors = false;
  let loadSeq = 0;

  function post(type, extra) {
    if (!window.parent || window.parent === window || !parentOrigin) return;
    window.parent.postMessage(Object.assign({ type, channel, seq: loadSeq }, extra || {}), parentOrigin);
  }

  function snapshot(evName) {
    return {
      event: evName || "state",
      hasSrc: Boolean(v.getAttribute("src")),
      paused: Boolean(v.paused),
      autoplay: Boolean(v.autoplay),
      ended: Boolean(v.ended),
      seeking: Boolean(v.seeking),
      muted: Boolean(v.muted),
      volume: Number.isFinite(v.volume) ? v.volume : 1,
      playbackRate: Number.isFinite(v.playbackRate) ? v.playbackRate : 1,
      currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      videoWidth: Number(v.videoWidth || 0),
      videoHeight: Number(v.videoHeight || 0),
      readyState: Number(v.readyState || 0),
      networkState: Number(v.networkState || 0),
    };
  }

  function emitState(evName) {
    post("ag-mp-state", snapshot(evName));
  }

  v.addEventListener("click", () => {
    if (!v.getAttribute("src")) return;
    if (v.paused || v.ended) {
      Promise.resolve(v.play()).catch((err) => {
        post("ag-mp-error", { code: 0, message: String(err && err.message || err || "play blocked") });
      });
    } else {
      v.pause();
    }
  });

  for (const name of ["loadedmetadata", "loadeddata", "canplay", "play", "pause", "ended", "seeking", "seeked", "timeupdate", "ratechange", "volumechange"]) {
    v.addEventListener(name, () => emitState(name));
  }

  v.addEventListener("error", () => {
    if (suppressErrors || !v.getAttribute("src")) return;
    post("ag-mp-error", {
      code: v.error ? Number(v.error.code || 0) : 0,
      message: v.error ? String(v.error.message || "") : "",
    });
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (!LOOPBACK_RE.test(String(event.origin || ""))) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (channel && String(data.channel || "") !== channel) return;
    parentOrigin = event.origin;

    if (data.type === "ping") {
      post("ag-mp-ready", snapshot("ready"));
      return;
    }
    if (data.type === "load") {
      const rawSrc = String(data.src || "").trim();
      let safeSrc = "";
      try {
        const parsed = new URL(rawSrc, location.origin);
        if (parsed.origin === location.origin && parsed.pathname.startsWith("/media/")) {
          safeSrc = parsed.href;
        }
      } catch (_) {}
      if (!safeSrc) {
        post("ag-mp-error", { code: 4, message: "invalid same-origin media url" });
        return;
      }
      loadSeq += 1;
      suppressErrors = true;
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch (_) {}
      suppressErrors = false;
      v.autoplay = false;
      v.preload = "metadata";
      if (typeof data.muted === "boolean") v.muted = data.muted;
      if (typeof data.volume === "number" && Number.isFinite(data.volume)) {
        v.volume = Math.max(0, Math.min(1, data.volume));
      }
      if (typeof data.playbackRate === "number" && Number.isFinite(data.playbackRate) && data.playbackRate > 0) {
        v.playbackRate = data.playbackRate;
      }
      v.src = safeSrc;
      emitState("loadstart");
      return;
    }
    if (data.type === "clear") {
      loadSeq += 1;
      suppressErrors = true;
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch (_) {}
      suppressErrors = false;
      emitState("cleared");
      return;
    }
    if (data.type === "play") {
      if (!v.getAttribute("src")) return;
      Promise.resolve(v.play()).catch((err) => {
        post("ag-mp-error", { code: 0, message: String(err && err.message || err || "play blocked") });
      });
      return;
    }
    if (data.type === "pause") {
      v.pause();
      return;
    }
    if (data.type === "togglePlay") {
      if (!v.getAttribute("src")) return;
      if (v.paused || v.ended) {
        Promise.resolve(v.play()).catch((err) => {
          post("ag-mp-error", { code: 0, message: String(err && err.message || err || "play blocked") });
        });
      } else {
        v.pause();
      }
      return;
    }
    if (data.type === "seek") {
      const target = Number(data.time);
      if (Number.isFinite(target) && target >= 0) {
        v.currentTime = target;
        emitState("timeupdate");
      }
      return;
    }
    if (data.type === "setMuted") {
      v.muted = Boolean(data.muted);
      emitState("volumechange");
      return;
    }
    if (data.type === "setVolume") {
      const vol = Math.max(0, Math.min(1, Number(data.volume)));
      if (Number.isFinite(vol)) {
        v.volume = vol;
        if (vol > 0 && v.muted) v.muted = false;
        emitState("volumechange");
      }
      return;
    }
    if (data.type === "setRate") {
      const rate = Number(data.playbackRate ?? data.rate);
      if (Number.isFinite(rate) && rate > 0) {
        v.playbackRate = rate;
        emitState("ratechange");
      }
    }
  });

  if (parentOrigin) {
    post("ag-mp-ready", snapshot("ready"));
  }
})();
</script>
</body>
</html>
"""


def node_bin():
    return shutil.which("node") or "node"


def no_window_flags():
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def mnemon_command(args, timeout=45):
    """Run the mnemon CLI as the single writer for the shared memory vault.

    The MCP server, hooks and this sidecar all point at the same data directory;
    routing writes through the CLI keeps revisions, mirroring, daily snapshots
    and the one-writer merge logic intact.
    """
    node = NODE_EXE if os.path.isfile(NODE_EXE) else node_bin()
    if not os.path.isfile(MNEMON_CLI):
        raise RuntimeError("mnemon CLI not installed")
    command = [node, MNEMON_CLI, *args, "--data-dir", MNEMON_VAULT, "--mirror-dir", MEMORY_MIRROR]
    process = subprocess.run(
        command,
        cwd=MNEMON_PLUGIN,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=no_window_flags(),
    )
    output = (process.stdout or "").strip()
    data = None
    try:
        data = json.loads(output)
    except Exception:
        data = None
    if process.returncode != 0:
        message = output or (process.stderr or "").strip() or f"mnemon exited {process.returncode}"
        raise RuntimeError(message[:2000])
    if data is None:
        raise RuntimeError((output or "mnemon returned no JSON")[:2000])
    return data


def run_node_json(script_path, args, timeout=35, label="helper"):
    node = NODE_EXE if os.path.isfile(NODE_EXE) else node_bin()
    if not os.path.isfile(script_path):
        raise RuntimeError(f"{label} not installed")
    process = subprocess.run(
        [node, script_path, *args],
        cwd=PLUGIN_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=no_window_flags(),
    )
    output = (process.stdout or "").strip()
    try:
        data = json.loads(output)
    except Exception:
        data = None
    if data is None:
        message = output or (process.stderr or "").strip() or f"{label} exited {process.returncode}"
        raise RuntimeError(message[:2000])
    if process.returncode != 0 and not data.get("error"):
        data["error"] = (process.stderr or output).strip()[:2000]
    return data


def update_command(args, timeout=45):
    """Run scripts/update.js and return its JSON result."""
    return run_node_json(UPDATE_JS, args, timeout=timeout, label="updater")


def mcp_profile_command(args, timeout=20):
    """Run scripts/mcp-profile.js and return its JSON result."""
    return run_node_json(MCP_PROFILE_JS, args, timeout=timeout, label="mcp-profile")


def update_status():
    pkg = {}
    try:
        with open(os.path.join(PLUGIN_DIR, "plugin.json"), "r", encoding="utf-8") as f:
            pkg = json.load(f)
    except Exception:
        pkg = {}
    cfg = {}
    try:
        with open(UPDATE_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    state = {}
    try:
        with open(UPDATE_STATE_PATH, "r", encoding="utf-8") as f:
            state = json.load(f)
    except Exception:
        state = {}
    configured = bool(cfg.get("repo") or cfg.get("manifestUrl"))
    return {
        "ok": True,
        "current": str(pkg.get("version") or ""),
        "configured": configured,
        **state,
    }


def write_memory_runtime(payload):
    values = {}
    for key in ("persona", "user", "memory"):
        value = payload.get(key) if isinstance(payload, dict) else None
        if isinstance(value, str):
            values[key] = value[:240000]
    if not values:
        return {"written": []}
    handle, temp_path = tempfile.mkstemp(prefix="mnemon-runtime-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as temp:
            json.dump(values, temp, ensure_ascii=False)
        return mnemon_command(["runtime-write-json", "--file", temp_path])
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def memory_candidates(status="pending"):
    return mnemon_command(["candidates", "--status", status])


CANDIDATE_ID_RE = re.compile(r"^cand_[0-9a-fA-F]{4,64}$")


def load_config():
    default_cfg = {
        "enabled": True,
        "language": "zh-CN",
        "deepI18n": True,
        "translateAlerts": True,
        "runningRadar": True,
        "hideRadarWhenIdle": False,
        "quickCopyButton": True,
        "cursorParticles": True,
        "questChime": False,
        "telemetryBar": True,
        "telemetryShowCost": True,
        "taskProgressBar": True,
        "quickGoalPill": False,
        "ambientClock": False,
        "rightReadingEnabled": True,
        "rightReadingBg": "#140f29",
        "rightReadingOpacity": 0.94,
        "rightReadingFontSize": 14,
        "videoPreviewEnabled": True,
        "opacity": 0.72,
        "blur": 24,
        "darkTint": 0.42,
        "focusX": 50,
        "focusY": 26,
        "autoPalette": True,
        "promptSticky": False,
        "fontPreset": "editorial-luxe",
        "fontScale": 1.0,
        "starEffectMode": "orbit-meteor",
        "starIntensity": 0.85,
        "meteorFrequency": 0.6,
        "palette": {},
        "wallpaperPath": "assets/wallpaper.jpg"
    }
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                default_cfg.update(loaded)
        except Exception:
            pass
    return default_cfg


def save_config(cfg):
    try:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        os.replace(tmp, CONFIG_PATH)
        return True
    except Exception as error:
        print("[WallpaperSidecar] Save config failed:", error, flush=True)
        return False


def write_runtime_port(port):
    try:
        os.makedirs(os.path.dirname(RUNTIME_PATH), exist_ok=True)
        atomic_write_text(RUNTIME_PATH, json.dumps({"port": port, "updatedAt": int(time.time())}))
    except Exception:
        pass


def write_sidecar_token(token):
    try:
        os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
        atomic_write_text(TOKEN_PATH, token + "\n")
        try:
            os.chmod(TOKEN_PATH, 0o600)
        except Exception:
            pass
    except Exception:
        pass


def pid_alive(pid):
    # os.kill(pid, 0) terminates the target on Windows, so ask kernel32 instead.
    if not pid or int(pid) <= 0:
        return False
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259
    except Exception:
        return True


def claim_lock(port):
    try:
        os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
        atomic_write_text(LOCK_PATH, json.dumps({
            "pid": os.getpid(),
            "port": port,
            "claimedAt": int(time.time()),
        }))
    except Exception:
        pass


def lock_owner():
    try:
        with open(LOCK_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return int(data.get("pid") or 0)
    except Exception:
        return 0


def lock_guard():
    """Windows lets every instance bind the same port, so ownership is decided by the lock file:
    the newest sidecar wins and any older one retires itself instead of stacking watchdogs."""
    while True:
        time.sleep(15)
        try:
            owner = lock_owner()
            if owner == os.getpid():
                continue
            if owner and not pid_alive(owner):
                claim_lock(RUNTIME_PORT[0])
                continue
            stop_live_daemon()
            os._exit(0)
        except Exception:
            return


def clamp_number(value, low, high, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def sanitize_palette(value):
    if not isinstance(value, dict):
        return {}
    result = {}
    for key in ("dark", "highlight", "accent", "cool"):
        color = value.get(key)
        if isinstance(color, str) and HEX_RE.match(color.strip()):
            result[key] = color.strip()
    return result


def merge_config(cfg, payload):
    if not isinstance(payload, dict):
        return cfg
    if payload.get("language") in ("zh-CN", "en"):
        cfg["language"] = payload["language"]
    for key in ("deepI18n", "translateAlerts", "runningRadar", "hideRadarWhenIdle", "quickCopyButton", "cursorParticles", "questChime",
                "telemetryBar", "telemetryShowCost", "taskProgressBar", "quickGoalPill", "ambientClock",
                "rightReadingEnabled", "videoPreviewEnabled"):
        if key in payload:
            cfg[key] = bool(payload[key])
    if isinstance(payload.get("rightReadingBg"), str) and HEX_RE.match(payload["rightReadingBg"].strip()):
        cfg["rightReadingBg"] = payload["rightReadingBg"].strip()
    if "rightReadingOpacity" in payload:
        cfg["rightReadingOpacity"] = clamp_number(payload["rightReadingOpacity"], 0.4, 1.0, cfg.get("rightReadingOpacity", 0.94))
    if "rightReadingFontSize" in payload:
        cfg["rightReadingFontSize"] = clamp_number(payload["rightReadingFontSize"], 12.0, 20.0, cfg.get("rightReadingFontSize", 14))
    if "opacity" in payload:
        cfg["opacity"] = clamp_number(payload["opacity"], 0.0, 1.0, cfg.get("opacity", 0.72))
    if "blur" in payload:
        cfg["blur"] = clamp_number(payload["blur"], 0.0, 60.0, cfg.get("blur", 24))
    if "darkTint" in payload:
        cfg["darkTint"] = clamp_number(payload["darkTint"], 0.0, 0.95, cfg.get("darkTint", 0.42))
    if "focusX" in payload:
        cfg["focusX"] = clamp_number(payload["focusX"], 0.0, 100.0, cfg.get("focusX", 50))
    if "focusY" in payload:
        cfg["focusY"] = clamp_number(payload["focusY"], 0.0, 100.0, cfg.get("focusY", 26))
    if "enabled" in payload:
        cfg["enabled"] = bool(payload["enabled"])
    if "autoPalette" in payload:
        cfg["autoPalette"] = bool(payload["autoPalette"])
    if "promptSticky" in payload:
        cfg["promptSticky"] = bool(payload["promptSticky"])
    if payload.get("fontPreset") in ("editorial-luxe", "modern-silk", "literary-serif", "starry-game"):
        cfg["fontPreset"] = payload["fontPreset"]
    if "fontScale" in payload:
        cfg["fontScale"] = clamp_number(payload["fontScale"], 0.85, 1.15, cfg.get("fontScale", 1.0))
    if payload.get("starEffectMode") in ("orbit-meteor", "meteor-stars", "minimal", "off"):
        cfg["starEffectMode"] = payload["starEffectMode"]
    if "starIntensity" in payload:
        cfg["starIntensity"] = clamp_number(payload["starIntensity"], 0.0, 1.0, cfg.get("starIntensity", 0.85))
    if "meteorFrequency" in payload:
        cfg["meteorFrequency"] = clamp_number(payload["meteorFrequency"], 0.0, 1.0, cfg.get("meteorFrequency", 0.6))
    if "palette" in payload:
        palette = sanitize_palette(payload["palette"])
        if palette:
            cfg["palette"] = palette
    if isinstance(payload.get("wallpaperPath"), str) and payload["wallpaperPath"].strip():
        cfg["wallpaperPath"] = payload["wallpaperPath"].strip()
    return cfg


def live_payload(cfg):
    return {
        "language": cfg.get("language", "zh-CN"),
        "deepI18n": bool(cfg.get("deepI18n", True)),
        "translateAlerts": bool(cfg.get("translateAlerts", True)),
        "runningRadar": bool(cfg.get("runningRadar", True)),
        "hideRadarWhenIdle": bool(cfg.get("hideRadarWhenIdle", False)),
        "quickCopyButton": bool(cfg.get("quickCopyButton", True)),
        "cursorParticles": bool(cfg.get("cursorParticles", True)),
        "questChime": bool(cfg.get("questChime", False)),
        "telemetryBar": bool(cfg.get("telemetryBar", True)),
        "telemetryShowCost": bool(cfg.get("telemetryShowCost", True)),
        "taskProgressBar": bool(cfg.get("taskProgressBar", True)),
        "quickGoalPill": bool(cfg.get("quickGoalPill", False)),
        "ambientClock": bool(cfg.get("ambientClock", False)),
        "rightReadingEnabled": bool(cfg.get("rightReadingEnabled", True)),
        "rightReadingBg": cfg.get("rightReadingBg", "#140f29") if HEX_RE.match(str(cfg.get("rightReadingBg", ""))) else "#140f29",
        "rightReadingOpacity": clamp_number(cfg.get("rightReadingOpacity", 0.94), 0.4, 1.0, 0.94),
        "rightReadingFontSize": clamp_number(cfg.get("rightReadingFontSize", 14), 12.0, 20.0, 14),
        "videoPreviewEnabled": bool(cfg.get("videoPreviewEnabled", True)),
        "opacity": cfg.get("opacity", 0.72),
        "blur": cfg.get("blur", 24),
        "darkTint": cfg.get("darkTint", 0.42),
        "focusX": cfg.get("focusX", 50),
        "focusY": cfg.get("focusY", 26),
        "promptSticky": bool(cfg.get("promptSticky", False)),
        "fontPreset": cfg.get("fontPreset", "editorial-luxe"),
        "fontScale": cfg.get("fontScale", 1.0),
        "starEffectMode": cfg.get("starEffectMode", "orbit-meteor"),
        "starIntensity": cfg.get("starIntensity", 0.85),
        "meteorFrequency": cfg.get("meteorFrequency", 0.6),
        "palette": cfg.get("palette") or {}
    }


def ensure_live_daemon():
    global _live_process
    if _live_process and _live_process.poll() is None:
        return _live_process
    try:
        _live_process = subprocess.Popen(
            [node_bin(), LIVE_JS],
            cwd=PLUGIN_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            creationflags=no_window_flags(),
        )
        print("[WallpaperSidecar] Live bridge started", flush=True)
    except Exception as error:
        print("[WallpaperSidecar] Live bridge error:", error, flush=True)
        _live_process = None
    return _live_process


def push_live(cfg):
    payload = live_payload(cfg)
    with _live_lock:
        process = ensure_live_daemon()
        if not process or not process.stdin:
            return False
        try:
            process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            process.stdin.flush()
            return True
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
            globals()["_live_process"] = None
            process = ensure_live_daemon()
            if not process or not process.stdin:
                return False
            try:
                process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                process.stdin.flush()
                return True
            except Exception:
                return False


def stop_live_daemon():
    global _live_process
    process = _live_process
    _live_process = None
    if not process:
        return
    try:
        if process.stdin:
            process.stdin.close()
    except Exception:
        pass
    try:
        process.terminate()
    except Exception:
        pass


def trigger_apply():
    try:
        subprocess.run(
            [node_bin(), APPLY_JS],
            cwd=PLUGIN_DIR,
            timeout=35,
            creationflags=no_window_flags(),
        )
    except Exception as error:
        print("[WallpaperSidecar] Apply error:", error, flush=True)


def trigger_restore():
    try:
        subprocess.run(
            [node_bin(), RESTORE_JS],
            cwd=PLUGIN_DIR,
            timeout=8,
            creationflags=no_window_flags(),
        )
    except Exception as error:
        print("[WallpaperSidecar] Restore error:", error, flush=True)


def trigger_autostart():
    """Apply the theme once after the app/hub is ready.

    The previous SessionStart hook used a relative path and stopped working
    after an app update changed the hook working directory. The sidecar is
    started by the app on every launch, so it is a stable startup anchor.
    """
    try:
        if not load_config().get("enabled", True):
            return
        subprocess.Popen(
            [node_bin(), AUTOSTART_JS],
            cwd=PLUGIN_DIR,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=no_window_flags(),
        )
        print("[WallpaperSidecar] Autostart injector launched", flush=True)
    except Exception as error:
        print("[WallpaperSidecar] Autostart error:", error, flush=True)


def delayed_autostart():
    time.sleep(3)
    trigger_autostart()


def devtools_page_available():
    try:
        with open(DEVTOOLS_PORT_FILE, "r", encoding="utf-8") as f:
            port = int(str(f.readline()).strip())
        _watch_state["port"] = port
        _watch_state["portFile"] = DEVTOOLS_PORT_FILE
        req = urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=1.5)
        targets = json.loads(req.read().decode("utf-8", "replace"))
        return any(
            item.get("type") == "page" and str(item.get("url", "")).startswith("https://127.0.0.1:")
            for item in (targets if isinstance(targets, list) else [])
        )
    except Exception as error:
        _watch_state["error"] = repr(error)
        return False


def theme_watchdog():
    """应用重启/更新后，自动把已启用的主题重新注入新窗口。

    20s 是有意的：重载后若等到 120s 才注入，用户会看到一段没有壁纸的裸界面。
    每轮成本只是 autostart.js 里一次极廉价的探测（主题已装就立刻退出），真正造成
    卡顿的是过去十几个泄漏实例各自跑这个循环，那已由 .sidecar-lock.json 单实例锁解决。
    """
    while True:
        time.sleep(20)
        _watch_state["last"] = time.time()
        try:
            if load_config().get("enabled", True) is False:
                _watch_state["available"] = False
                continue
            _watch_state["available"] = devtools_page_available()
            if not _watch_state["available"]:
                continue
            _watch_state["ran"] += 1
            _watch_state["lastRun"] = time.time()
            subprocess.run(
                [node_bin(), AUTOSTART_JS],
                cwd=PLUGIN_DIR,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=45,
                creationflags=no_window_flags(),
            )
            _watch_state["error"] = ""
        except Exception as error:
            _watch_state["error"] = str(error)


def wallpaper_file():
    cfg = load_config()
    configured = cfg.get("wallpaperPath") or ""
    if configured:
        full = configured if os.path.isabs(configured) else os.path.join(PLUGIN_DIR, configured)
        if os.path.exists(full):
            return full
    for ext in ("webp", "png", "jpg", "jpeg"):
        custom = os.path.join(PLUGIN_DIR, "assets", f"custom-wallpaper.{ext}")
        if os.path.exists(custom):
            return custom
    return WALLPAPER_PATH if os.path.exists(WALLPAPER_PATH) else None


def content_type_for(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".png":
        return "image/png"
    if ext == ".webp":
        return "image/webp"
    if ext == ".gif":
        return "image/gif"
    return "image/jpeg"


def load_prompts():
    if not os.path.exists(PROMPTS_PATH):
        return []
    try:
        with open(PROMPTS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("prompts"), list):
            return data["prompts"]
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []


def save_prompts(prompts):
    cleaned = []
    for index, item in enumerate(prompts[:500]):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:80]
        prompt = str(item.get("prompt") or "").strip()
        if not title or not prompt:
            continue
        cleaned.append({
            "id": str(item.get("id") or f"custom-{int(time.time() * 1000)}-{index}")[:80],
            "title": title,
            "prompt": prompt[:20000],
        })
    os.makedirs(os.path.dirname(PROMPTS_PATH), exist_ok=True)
    tmp = PROMPTS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, indent=2, ensure_ascii=False)
    os.replace(tmp, PROMPTS_PATH)
    return cleaned


def safe_snapshot_name(title):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    slug = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", str(title or ""), flags=re.UNICODE).strip("-")[:48]
    if not slug:
        slug = "branch"
    name = f"{stamp}-{slug}.md"
    candidate = os.path.join(SNAPSHOT_DIR, name)
    counter = 2
    while os.path.exists(candidate):
        name = f"{stamp}-{slug}-{counter}.md"
        candidate = os.path.join(SNAPSHOT_DIR, name)
        counter += 1
    return candidate


def read_text_capped(path, limit=240000):
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read(limit)
    except Exception:
        return ""


def atomic_write_text(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = path + ".tmp-" + str(os.getpid())
    with open(temp_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, path)


def memory_status():
    runtime_dir = os.path.join(MNEMON_VAULT, "runtime")
    runtime = {}
    for name in ("PERSONA.md", "USER.md", "MEMORY.md"):
        file_path = os.path.join(runtime_dir, name)
        exists = os.path.isfile(file_path)
        runtime[name] = {
            "exists": exists,
            "size": os.path.getsize(file_path) if exists else 0,
            "updated": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(file_path))) if exists else None,
        }
    snapshots_dir = os.path.join(MNEMON_VAULT, "snapshots")
    snapshots = sorted(
        [name for name in os.listdir(snapshots_dir) if name.endswith(".json.gz")],
        reverse=True
    ) if os.path.isdir(snapshots_dir) else []
    return {
        "vault": MNEMON_VAULT,
        "mirror": MEMORY_MIRROR,
        "vaultExists": os.path.isdir(MNEMON_VAULT),
        "mirrorExists": os.path.isdir(MEMORY_MIRROR),
        "runtime": runtime,
        "snapshots": snapshots[:8],
        "snapshotCount": len(snapshots),
    }


def memory_items():
    items = []
    spaces_dir = os.path.join(MNEMON_VAULT, "spaces")
    if os.path.isdir(spaces_dir):
        for space in sorted(os.listdir(spaces_dir)):
            path = os.path.join(spaces_dir, space, "memories.jsonl")
            if not os.path.isfile(path):
                continue
            for line in read_text_capped(path).splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except Exception:
                    continue
                if isinstance(item, dict):
                    item["space"] = space
                    items.append(item)
    items.sort(key=lambda item: item.get("updatedAt") or item.get("createdAt") or "", reverse=True)
    return items[:80]


def control_status():
    policy = None
    if os.path.isfile(CU_POLICY_PATH):
        try:
            with open(CU_POLICY_PATH, "r", encoding="utf-8") as handle:
                policy = json.load(handle)
        except Exception:
            policy = None
    bridge = None
    bridge_error = None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{BROWSER_BRIDGE_PORT}/status", timeout=0.8) as response:
            bridge = json.loads(response.read().decode("utf-8", errors="replace"))
    except Exception as error:
        bridge_error = str(error)
    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    return {
        "computerUse": {
            "path": COMPUTER_USE_PLUGIN,
            "installed": os.path.isfile(os.path.join(COMPUTER_USE_PLUGIN, "plugin.json")),
            "policyPath": CU_POLICY_PATH,
            "policy": policy,
        },
        "browserBridge": {
            "path": BROWSER_BRIDGE_PLUGIN,
            "installed": os.path.isfile(os.path.join(BROWSER_BRIDGE_PLUGIN, "plugin.json")),
            "port": BROWSER_BRIDGE_PORT,
            "status": bridge,
            "error": bridge_error,
            "extensionPath": os.path.join(BROWSER_BRIDGE_PLUGIN, "extension"),
            "edge": edge,
            "edgeExists": os.path.isfile(edge),
            "chrome": chrome,
            "chromeExists": os.path.isfile(chrome),
        },
    }


_legacy_cache = {"at": 0.0, "data": []}


def legacy_processes(force=False):
    # Get-CimInstance costs ~2s, and the panel calls this on every open.
    now = time.time()
    if not force and now - _legacy_cache["at"] < 60:
        return list(_legacy_cache["data"])
    script = (
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "
        "'injector_zh\\.py|antigravity2\\.0-ChinesePlugin' } | "
        "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8,
            creationflags=no_window_flags(),
        )
        raw = (completed.stdout or "").strip()
        if not raw:
            return []
        data = json.loads(raw)
        if isinstance(data, dict):
            data = [data]
    except Exception:
        return []
    result = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = str(item.get("Name") or "").lower()
        if name in ("powershell.exe", "pwsh.exe", "cmd.exe", "wmic.exe"):
            continue
        command = str(item.get("CommandLine") or "")
        if not re.search(r"injector_zh\.py|antigravity2\.0-ChinesePlugin", command, re.I):
            continue
        try:
            pid = int(item.get("ProcessId") or 0)
        except Exception:
            pid = 0
        if pid > 0:
            result.append({"pid": pid, "name": name, "command": command})
    _legacy_cache["at"] = now
    _legacy_cache["data"] = list(result)
    return result


def legacy_status():
    processes = legacy_processes()
    return {
        "ok": True,
        "active": bool(processes),
        "processes": processes,
        "shortcut": LEGACY_SHORTCUT,
        "shortcutExists": os.path.isfile(LEGACY_SHORTCUT),
        "backup": LEGACY_BACKUP,
        "backupExists": os.path.isfile(LEGACY_BACKUP),
        "engine": "native-sidecar",
    }


def legacy_retire():
    processes = legacy_processes(force=True)
    retired = []
    for item in processes:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(item["pid"]), "/T", "/F"],
                capture_output=True, timeout=6, creationflags=no_window_flags(),
            )
            retired.append(item)
        except Exception:
            pass
    shortcut_moved = False
    if os.path.isfile(LEGACY_SHORTCUT):
        try:
            os.makedirs(LEGACY_I18N_DIR, exist_ok=True)
            shutil.move(LEGACY_SHORTCUT, LEGACY_BACKUP)
            shortcut_moved = True
        except Exception:
            pass
    _legacy_cache["at"] = 0.0
    status = legacy_status()
    status.update({"retired": retired, "shortcutMoved": shortcut_moved})
    return status


def resolve_plugin_dir(plugin_id):
    ident = str(plugin_id or "").strip()
    if not ident:
        return None
    direct = os.path.join(PLUGINS_DIR, ident)
    if os.path.isdir(direct) and os.path.isfile(os.path.join(direct, "plugin.json")):
        return direct
    try:
        for entry in os.listdir(PLUGINS_DIR):
            candidate = os.path.join(PLUGINS_DIR, entry)
            manifest = os.path.join(candidate, "plugin.json")
            if not os.path.isdir(candidate) or not os.path.isfile(manifest):
                continue
            try:
                with open(manifest, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if str(data.get("name", "")).strip() == ident:
                    return candidate
            except Exception:
                continue
    except Exception:
        return None
    return None


def resolve_skill_path(name, raw_path):
    if raw_path:
        target = os.path.abspath(str(raw_path))
        roots = [os.path.abspath(SKILLS_DIR), os.path.abspath(USER_SKILLS_DIR), os.path.abspath(IDE_SKILLS_DIR), os.path.abspath(BUILTIN_SKILLS_DIR), os.path.abspath(PLUGINS_DIR)]
        if any(target == root or target.startswith(root + os.sep) for root in roots):
            return target if os.path.exists(target) else None
    wanted = str(name or "").strip().lstrip("/").lower()
    if not wanted:
        return None
    roots = [SKILLS_DIR, USER_SKILLS_DIR, IDE_SKILLS_DIR, BUILTIN_SKILLS_DIR]
    try:
        roots.extend(
            os.path.join(PLUGINS_DIR, entry, "skills")
            for entry in os.listdir(PLUGINS_DIR)
            if os.path.isdir(os.path.join(PLUGINS_DIR, entry, "skills"))
        )
    except Exception:
        pass
    for root in roots:
        if not os.path.isdir(root):
            continue
        for entry in os.listdir(root):
            folder = os.path.join(root, entry)
            if not os.path.isdir(folder):
                continue
            if entry.lower() == wanted or entry.lower().replace(" ", "-") == wanted.replace(" ", "-"):
                return folder
    return None


def open_in_explorer(target):
    try:
        if os.path.isdir(target):
            subprocess.Popen(["explorer.exe", target], creationflags=no_window_flags())
            return True
        if os.path.isfile(target):
            subprocess.Popen(["explorer.exe", "/select,", target], creationflags=no_window_flags())
            return True
    except Exception:
        pass
    return False


def open_media_with_default_app(target):
    try:
        if not os.path.isfile(target):
            return False, "文件不存在"
        if sys.platform.startswith("win") or os.name == "nt":
            os.startfile(target)
            return True, None
        opener = "open" if sys.platform == "darwin" else "xdg-open"
        subprocess.Popen([opener, target], creationflags=no_window_flags())
        return True, None
    except Exception as error:
        return False, str(error)


def normalize_local_media_path(raw_input):
    text = str(raw_input or "").strip()
    if len(text) >= 2 and ((text[0] == '"' and text[-1] == '"') or (text[0] == "'" and text[-1] == "'")):
        text = text[1:-1].strip()
    if not text:
        return False, (400, "缺少本地视频路径")

    if text.lower().startswith("file://"):
        parsed = urllib.parse.urlparse(text)
        decoded_path = urllib.parse.unquote(parsed.path or "")
        netloc = urllib.parse.unquote(parsed.netloc or "")
        if netloc and netloc.lower() != "localhost":
            text = f"//{netloc}{decoded_path}"
        else:
            if re.match(r"^/[A-Za-z]:", decoded_path):
                decoded_path = decoded_path[1:]
            text = decoded_path

    abs_path = os.path.abspath(os.path.normpath(text))
    if os.path.isdir(abs_path):
        return False, (400, "路径指向文件夹而非视频文件")
    if not os.path.exists(abs_path) or not os.path.isfile(abs_path):
        return False, (404, f"本地文件不存在: {os.path.basename(abs_path) or abs_path}")

    ext = os.path.splitext(abs_path)[1].lower()
    mime = MEDIA_EXT_MIMES.get(ext)
    if not mime:
        return False, (400, f"不支持的本地视频格式: {ext or '无扩展名'}")

    try:
        with open(abs_path, "rb") as handle:
            size = os.fstat(handle.fileno()).st_size
    except PermissionError:
        return False, (403, f"没有权限读取文件: {os.path.basename(abs_path)}")
    except OSError as error:
        return False, (400, f"无法读取本地文件: {error}")

    return True, {
        "path": abs_path,
        "name": os.path.basename(abs_path),
        "ext": ext,
        "mime": mime,
        "size": int(size),
    }


def register_media_file(raw_input):
    ok, result = normalize_local_media_path(raw_input)
    if not ok:
        return False, result
    media_id = secrets.token_urlsafe(24)
    now = time.time()
    entry = dict(result, id=media_id, createdAt=now, lastAccessAt=now)
    with _media_lock:
        if len(_media_registry) >= 1024:
            oldest = sorted(_media_registry.items(), key=lambda kv: kv[1].get("lastAccessAt", 0))[:256]
            for old_id, _ in oldest:
                _media_registry.pop(old_id, None)
        _media_registry[media_id] = entry
    return True, entry


def get_media_entry(media_id):
    if not isinstance(media_id, str) or not MEDIA_ID_RE.match(media_id):
        return None
    with _media_lock:
        entry = _media_registry.get(media_id)
        if entry is not None:
            entry["lastAccessAt"] = time.time()
            return dict(entry)
    return None


def close_media_entry(media_id):
    if not isinstance(media_id, str) or not MEDIA_ID_RE.match(media_id):
        return None
    with _media_lock:
        return _media_registry.pop(media_id, None)


def parse_single_byte_range(range_header, total_size):
    if not range_header:
        return "none", None
    raw = str(range_header).strip()
    match = re.match(r"^bytes\s*=\s*(.+)$", raw, flags=re.I)
    if not match:
        return "invalid", None
    spec = match.group(1).strip()
    if "," in spec or not spec:
        return "invalid", None
    parts = re.match(r"^(\d*)-(\d*)$", spec)
    if not parts:
        return "invalid", None
    start_str, end_str = parts.group(1), parts.group(2)
    if not start_str and not end_str:
        return "invalid", None
    if total_size <= 0:
        return "unsatisfiable", None
    if not start_str:
        suffix_len = int(end_str)
        if suffix_len <= 0:
            return "unsatisfiable", None
        start = max(0, total_size - suffix_len)
        end = total_size - 1
    elif not end_str:
        start = int(start_str)
        if start >= total_size:
            return "unsatisfiable", None
        end = total_size - 1
    else:
        start = int(start_str)
        end = int(end_str)
        if start > end or start >= total_size:
            return "unsatisfiable", None
        end = min(end, total_size - 1)
    return "range", (start, end)


def _to_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def telemetry_rates(model):
    name = str(model or "").lower()
    if "claude" in name:
        return {"input": 3.0, "cache": 0.30, "output": 15.0}
    if "gpt" in name or "openai" in name:
        return {"input": 2.5, "cache": 1.25, "output": 10.0}
    return {"input": 1.25, "cache": 0.31, "output": 10.0}


def telemetry_context_limit(model):
    name = str(model or "").lower()
    if "claude" in name:
        return 200000
    return 256000


def parse_task_markdown(text):
    items = []
    doing = 0
    todo = 0
    done = 0
    for line in str(text or "").splitlines():
        match = TASK_ITEM_RE.match(line)
        if not match:
            continue
        mark, label = match.group(1), match.group(2).strip()
        if not label:
            continue
        if mark in ("x", "X"):
            state = "done"
            done += 1
        elif mark == "/":
            state = "doing"
            doing += 1
        elif mark == "-":
            continue
        else:
            state = "todo"
            todo += 1
        items.append({"text": label[:240], "state": state})
    return {
        "exists": bool(items),
        "doing": doing,
        "todo": todo,
        "done": done,
        "total": len(items),
        "items": items[:20],
    }


def telemetry_tasks(cascade_id):
    if not CASCADE_RE.match(str(cascade_id or "")):
        return {"exists": False, "doing": 0, "todo": 0, "done": 0, "total": 0, "items": []}
    path = os.path.join(BRAIN_DIR, cascade_id, "task.md")
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return parse_task_markdown(f.read(512 * 1024))
    except Exception:
        return {"exists": False, "doing": 0, "todo": 0, "done": 0, "total": 0, "items": []}


def telemetry_transcript_stats(cascade_id):
    if not CASCADE_RE.match(str(cascade_id or "")):
        return None
    path = os.path.join(BRAIN_DIR, cascade_id, ".system_generated", "logs", "transcript.jsonl")
    try:
        stat = os.stat(path)
    except Exception:
        return None
    signature = (stat.st_mtime_ns, stat.st_size)
    with _telemetry_lock:
        cached = _telemetry_cache.get(path)
        if cached and cached.get("signature") == signature:
            return cached.get("stats")

    turns = 0
    steps = 0
    input_tokens = 0
    cache_tokens = 0
    output_tokens = 0
    tool_calls = 0
    last_context_used = 0
    last_updated = ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                kind = row.get("type")
                if kind == "CHECKPOINT":
                    continue
                steps += 1
                step_index = _to_int(row.get("step_index"))
                if step_index >= steps:
                    steps = step_index + 1
                if kind == "USER_INPUT":
                    turns += 1
                calls = row.get("tool_calls")
                if isinstance(calls, list):
                    tool_calls += len(calls)
                input_tokens += _to_int(row.get("input_tokens"))
                cache_tokens += _to_int(row.get("cache_read_tokens"))
                output_tokens += _to_int(row.get("output_tokens"))
                if kind == "PLANNER_RESPONSE":
                    last_context_used = _to_int(row.get("input_tokens")) + _to_int(row.get("cache_read_tokens"))
                created = row.get("created_at")
                if isinstance(created, str) and created:
                    last_updated = created
    except Exception:
        return None

    total_tokens = input_tokens + cache_tokens + output_tokens
    cache_hit = (cache_tokens / (input_tokens + cache_tokens) * 100.0) if (input_tokens + cache_tokens) else 0.0
    stats = {
        "turns": turns,
        "steps": steps,
        "tokens": {
            "input": input_tokens,
            "cacheRead": cache_tokens,
            "output": output_tokens,
            "total": total_tokens,
            "cacheHitRate": round(cache_hit, 1),
        },
        "toolCalls": tool_calls,
        "contextUsed": last_context_used,
        "updatedAt": last_updated,
        "transcriptSize": stat.st_size,
    }
    with _telemetry_lock:
        _telemetry_cache[path] = {"signature": signature, "stats": stats}
    return stats


def telemetry_session(cascade_id, model=""):
    tasks = telemetry_tasks(cascade_id)
    stats = telemetry_transcript_stats(cascade_id)
    if not stats:
        return {
            "ok": False,
            "error": "transcript not found",
            "id": cascade_id,
            "tasks": tasks,
            "source": "unavailable",
        }
    rates = telemetry_rates(model)
    cache_saved = stats["tokens"]["cacheRead"] * max(0.0, rates["input"] - rates["cache"]) / 1_000_000.0
    estimated_cost = (
        stats["tokens"]["input"] * rates["input"]
        + stats["tokens"]["cacheRead"] * rates["cache"]
        + stats["tokens"]["output"] * rates["output"]
    ) / 1_000_000.0
    limit = telemetry_context_limit(model)
    used = stats["contextUsed"]
    result = {
        "ok": True,
        "id": cascade_id,
        "source": "transcript",
        "turns": stats["turns"],
        "steps": stats["steps"],
        "tokens": stats["tokens"],
        "toolCalls": stats["toolCalls"],
        "context": {
            "used": used,
            "max": limit,
            "percent": round((used / limit * 100.0) if limit else 0.0, 1),
        },
        "cost": {
            "estimated": True,
            "total": round(estimated_cost, 4),
            "cacheSaved": round(cache_saved, 4),
            "currency": "USD",
        },
        "tasks": tasks,
        "updatedAt": stats["updatedAt"],
        "transcriptSize": stats["transcriptSize"],
    }
    return result


class WallpaperHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def _validated_origin(self):
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            return ""
        return origin if LOOPBACK_ORIGIN_RE.match(origin) else None

    def _check_loopback_origin_and_host(self):
        host = (self.headers.get("Host") or "").strip()
        if host and not LOOPBACK_HOST_RE.match(host):
            self._json_raw(403, {"ok": False, "error": "forbidden host"}, with_cors=False)
            return False
        if self._validated_origin() is None:
            self._json_raw(403, {"ok": False, "error": "forbidden origin"}, with_cors=False)
            return False
        return True

    def _require_token(self):
        provided = (self.headers.get("X-Starlight-Token") or "").strip()
        if not provided:
            auth = (self.headers.get("Authorization") or "").strip()
            if auth.lower().startswith("bearer "):
                provided = auth[7:].strip()
        if not provided or not hmac.compare_digest(provided, SIDECAR_TOKEN):
            self._json(403, {"ok": False, "error": "invalid or missing sidecar token"})
            return False
        return True

    def _has_media_token(self, query_string):
        provided = (self.headers.get("X-Starlight-Token") or "").strip()
        if not provided:
            auth = (self.headers.get("Authorization") or "").strip()
            if auth.lower().startswith("bearer "):
                provided = auth[7:].strip()
        if not provided and query_string:
            qs = urllib.parse.parse_qs(query_string, keep_blank_values=False)
            for key in ("st", "mediaToken", "token"):
                vals = qs.get(key) or []
                candidate = str(vals[0] or "").strip() if vals else ""
                if candidate:
                    provided = candidate
                    break
        return bool(provided) and hmac.compare_digest(provided, SIDECAR_TOKEN)

    def _cors(self):
        origin = self._validated_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Starlight-Token, Authorization, Range")
            self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _consume_remaining_body(self):
        if self.command not in ("POST", "PUT", "PATCH") or getattr(self, "_body_consumed", False):
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0:
            self._body_consumed = True
            return
        if length <= 65536:
            try:
                self.rfile.read(length)
                self._body_consumed = True
                return
            except Exception:
                pass
        self.close_connection = True

    def _json_raw(self, status, payload, with_cors=True):
        self._consume_remaining_body()
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        if with_cors:
            self._cors()
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, status, payload):
        self._json_raw(status, payload, with_cors=True)

    def _bytes(self, status, data, content_type, cache="no-store", extra_headers=None):
        self.send_response(status)
        self._cors()
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra_headers:
            for key, val in extra_headers.items():
                self.send_header(key, val)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _read_json(self, limit=MAX_JSON_BYTES):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0:
            self._body_consumed = True
            return {}
        if length > limit:
            self.close_connection = True
            return {}
        raw = self.rfile.read(length)
        self._body_consumed = True
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _serve_media(self, media_id, query_string, head_only=False):
        if not self._has_media_token(query_string):
            self._json(403, {"ok": False, "error": "invalid or missing media token"})
            return
        entry = get_media_entry(media_id)
        if not entry:
            self._json(404, {"ok": False, "error": "media handle not found or closed"})
            return
        file_path = entry["path"]
        if not os.path.isfile(file_path):
            self._json(404, {"ok": False, "error": "media file missing on disk"})
            return
        try:
            with open(file_path, "rb") as fh:
                total_size = os.fstat(fh.fileno()).st_size
                range_status, byte_range = parse_single_byte_range(self.headers.get("Range"), total_size)
                if range_status in ("invalid", "unsatisfiable"):
                    self.send_response(416)
                    self._cors()
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Range", f"bytes */{total_size}")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return

                if range_status == "range":
                    start, end = byte_range
                    length = end - start + 1
                    status_code = 206
                else:
                    start = 0
                    end = max(0, total_size - 1)
                    length = total_size
                    status_code = 200

                self.send_response(status_code)
                self._cors()
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Type", entry["mime"])
                self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{urllib.parse.quote(entry['name'])}")
                if status_code == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{total_size}")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(length))
                self.end_headers()

                if head_only or length <= 0:
                    return

                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(MEDIA_STREAM_CHUNK, remaining))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                        break
                    remaining -= len(chunk)
        except PermissionError:
            self._json(403, {"ok": False, "error": "permission denied reading media file"})
        except OSError as error:
            self._json(500, {"ok": False, "error": f"media read error: {error}"})

    def do_OPTIONS(self):
        if not self._check_loopback_origin_and_host():
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _serve_media_player(self):
        csp = (
            "default-src 'none'; "
            "script-src 'unsafe-inline'; "
            "style-src 'unsafe-inline'; "
            "media-src 'self'; "
            "frame-ancestors 'self' https://127.0.0.1:* http://127.0.0.1:* https://localhost:* http://localhost:*"
        )
        self._bytes(
            200,
            MEDIA_PLAYER_HTML.encode("utf-8"),
            "text/html; charset=utf-8",
            extra_headers={"Content-Security-Policy": csp},
        )

    def do_HEAD(self):
        if not self._check_loopback_origin_and_host():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/media-player.html":
            self._serve_media_player()
            return
        if path.startswith("/media/"):
            media_id = urllib.parse.unquote(path[len("/media/"):]).strip("/")
            self._serve_media(media_id, parsed.query, head_only=True)
            return
        if path == "/api/health":
            self._json(200, {"ok": True})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_GET(self):
        if not self._check_loopback_origin_and_host():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/media-player.html":
            self._serve_media_player()
            return

        if path.startswith("/media/"):
            media_id = urllib.parse.unquote(path[len("/media/"):]).strip("/")
            self._serve_media(media_id, parsed.query, head_only=False)
            return

        if path in ("/", "/ui.html"):
            ui_path = os.path.join(SIDE_DIR, "ui.html")
            if os.path.exists(ui_path):
                with open(ui_path, "r", encoding="utf-8", errors="replace") as f:
                    html = f.read()
                boot_script = (
                    f"<script>window.__AG_STARLIGHT_TOKEN__ = {json.dumps(SIDECAR_TOKEN)};"
                    f"window.__AG_SIDECAR_PORT = {int(RUNTIME_PORT[0])};</script>"
                )
                if "<script>" in html:
                    html = html.replace("<script>", boot_script + "\n  <script>", 1)
                elif "</head>" in html:
                    html = html.replace("</head>", boot_script + "\n</head>", 1)
                else:
                    html = boot_script + html
                csp = "frame-ancestors 'self' https://127.0.0.1:* http://127.0.0.1:* https://localhost:* http://localhost:*"
                self._bytes(
                    200,
                    html.encode("utf-8"),
                    "text/html; charset=utf-8",
                    extra_headers={"Content-Security-Policy": csp},
                )
                return

        if path in ("/wallpaper", "/wallpaper.jpg"):
            target = wallpaper_file()
            if target:
                try:
                    with open(target, "rb") as f:
                        self._bytes(200, f.read(), content_type_for(target))
                    return
                except Exception:
                    pass

        if path == "/api/health":
            self._json(200, {"ok": True, "port": self.server.server_address[1]})
            return

        if path.startswith("/api/"):
            if not self._require_token():
                return

        if path == "/api/config":
            self._json(200, load_config())
            return

        if path == "/api/mcp-profiles":
            try:
                self._json(200, mcp_profile_command(["list"]))
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})
            return

        if path == "/api/prompts":
            self._json(200, {"prompts": load_prompts()})
            return

        if path == "/api/catalog":
            try:
                out = subprocess.check_output(
                    [node_bin(), APPLY_JS, "--catalog-json"],
                    cwd=PLUGIN_DIR,
                    timeout=8,
                    creationflags=no_window_flags(),
                )
                data = json.loads(out.decode("utf-8", errors="replace") or "{}")
                self._json(200, {"ok": True, "plugins": data.get("plugins", []), "skills": data.get("skills", [])})
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})
            return

        if path.startswith("/api/snapshot/"):
            name = urllib.parse.unquote(path[len("/api/snapshot/"):])
            if not name or "/" in name or "\\" in name or ".." in name:
                self._json(400, {"ok": False, "error": "invalid snapshot name"})
                return
            target = os.path.join(SNAPSHOT_DIR, name)
            if os.path.exists(target):
                with open(target, "rb") as f:
                    self._bytes(200, f.read(), "text/markdown; charset=utf-8")
                return
            self._json(404, {"ok": False, "error": "snapshot not found"})
            return

        if path == "/api/memory/status":
            self._json(200, memory_status())
            return

        if path == "/api/memory/runtime":
            runtime_dir = os.path.join(MNEMON_VAULT, "runtime")
            self._json(200, {
                "persona": read_text_capped(os.path.join(runtime_dir, "PERSONA.md")),
                "user": read_text_capped(os.path.join(runtime_dir, "USER.md")),
                "memory": read_text_capped(os.path.join(runtime_dir, "MEMORY.md")),
                "status": memory_status(),
            })
            return

        if path == "/api/memory/items":
            self._json(200, {"items": memory_items()})
            return

        if path == "/api/memory/candidates":
            query = urllib.parse.parse_qs(parsed.query or "")
            status = (query.get("status") or ["pending"])[0]
            if status not in ("pending", "adopted", "rejected"):
                self._json(400, {"ok": False, "error": "invalid status"})
                return
            try:
                self._json(200, memory_candidates(status))
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})
            return

        if path == "/api/control/status":
            self._json(200, control_status())
            return

        if path == "/api/i18n/legacy-status":
            self._json(200, legacy_status())
            return

        if path == "/api/telemetry/session":
            query = urllib.parse.parse_qs(parsed.query or "")
            cascade_id = (query.get("id") or [""])[0]
            model = (query.get("model") or [""])[0]
            if not CASCADE_RE.match(cascade_id or ""):
                self._json(400, {"ok": False, "error": "invalid cascade id"})
                return
            self._json(200, telemetry_session(cascade_id, model))
            return

        if path == "/api/update/status":
            self._json(200, update_status())
            return

        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        self._body_consumed = False
        if not self._check_loopback_origin_and_host():
            return
        if not self._require_token():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/config":
            payload = self._read_json()
            cfg = merge_config(load_config(), payload)
            save_config(cfg)
            push_live(cfg)
            self._json(200, {"ok": True, "config": cfg})
            return

        if path == "/api/live":
            payload = self._read_json()
            cfg = merge_config(load_config(), payload)
            push_live(cfg)
            self._json(200, {"ok": True})
            return

        if path == "/api/open-resource":
            payload = self._read_json()
            kind = str(payload.get("kind") or "").strip().lower()
            if kind == "plugin":
                target = resolve_plugin_dir(payload.get("id") or payload.get("slug"))
            elif kind == "skill":
                target = resolve_skill_path(payload.get("name"), payload.get("path"))
            else:
                target = None
            if not target:
                self._json(404, {"ok": False, "error": "未找到本地位置"})
                return
            if not open_in_explorer(target):
                self._json(500, {"ok": False, "error": "无法打开资源管理器", "path": target})
                return
            self._json(200, {"ok": True, "path": target})
            return

        if path == "/api/update/check":
            try:
                data = update_command(["check"], timeout=35)
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})
                return
            self._json(200, data)
            return

        if path == "/api/update/apply":
            try:
                data = update_command(["apply"], timeout=600)
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})
                return
            self._json(200, data)
            return

        if path == "/api/i18n/legacy-retire":
            self._json(200, legacy_retire())
            return

        if path == "/api/apply":
            cfg = load_config()
            cfg["enabled"] = True
            save_config(cfg)
            threading.Thread(target=trigger_apply, daemon=True).start()
            self._json(200, {"ok": True})
            return

        if path == "/api/media/register":
            payload = self._read_json()
            raw_target = payload.get("path") if isinstance(payload, dict) else None
            if not raw_target and isinstance(payload, dict):
                raw_target = payload.get("uri")
            ok, result = register_media_file(raw_target)
            if not ok:
                status_code, err_msg = result
                self._json(status_code, {"ok": False, "error": err_msg})
                return
            self._json(200, {
                "ok": True,
                "id": result["id"],
                "name": result["name"],
                "path": result["path"],
                "ext": result["ext"],
                "mime": result["mime"],
                "size": result["size"],
                "url": f"/media/{result['id']}",
                "streamUrl": f"/media/{result['id']}?token={urllib.parse.quote(SIDECAR_TOKEN, safe='')}",
                "tokenRequired": True,
            })
            return

        media_action_match = re.match(r"^/api/media/([^/]+)/(open|reveal|close)$", path)
        if media_action_match:
            media_id = urllib.parse.unquote(media_action_match.group(1)).strip()
            action = media_action_match.group(2)
            if action == "close":
                existed = close_media_entry(media_id)
                self._json(200, {"ok": True, "id": media_id, "closed": bool(existed)})
                return
            entry = get_media_entry(media_id)
            if not entry:
                self._json(404, {"ok": False, "error": "media handle not found or closed"})
                return
            if not os.path.isfile(entry["path"]):
                self._json(404, {"ok": False, "error": "media file missing on disk"})
                return
            if action == "open":
                opened, err = open_media_with_default_app(entry["path"])
                if not opened:
                    self._json(500, {"ok": False, "error": err or "unable to launch system player"})
                    return
                self._json(200, {"ok": True, "id": media_id, "path": entry["path"]})
                return
            if action == "reveal":
                if not open_in_explorer(entry["path"]):
                    self._json(500, {"ok": False, "error": "unable to open file in explorer"})
                    return
                self._json(200, {"ok": True, "id": media_id, "path": entry["path"]})
                return

        if path == "/api/restore":
            cfg = load_config()
            cfg["enabled"] = False
            save_config(cfg)
            threading.Thread(target=trigger_restore, daemon=True).start()
            self._json(200, {"ok": True})
            return

        if path == "/api/memory/runtime":
            payload = self._read_json()
            if not isinstance(payload, dict) or not any(isinstance(payload.get(key), str) for key in ("persona", "user", "memory")):
                self._json(400, {"ok": False, "error": "需要 persona / user / memory 中的至少一个字符串"})
                return
            try:
                result = write_memory_runtime(payload)
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})
                return
            self._json(200, {"ok": True, "written": result.get("written", []), "status": memory_status()})
            return

        if path == "/api/memory/candidates":
            payload = self._read_json()
            candidate_id = str(payload.get("id") or "").strip()
            action = str(payload.get("action") or "").strip().lower()
            if not CANDIDATE_ID_RE.match(candidate_id):
                self._json(400, {"ok": False, "error": "invalid candidate id"})
                return
            if action not in ("adopt", "reject"):
                self._json(400, {"ok": False, "error": "action must be adopt or reject"})
                return
            space = str(payload.get("space") or "default").strip()
            space = re.sub(r"[^\w\-]+", "-", space, flags=re.UNICODE).strip("-")[:60] or "default"
            args = ["candidate-adopt", candidate_id, "--space", space] if action == "adopt" else ["candidate-reject", candidate_id]
            try:
                result = mnemon_command(args)
                remaining = memory_candidates("pending")
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})
                return
            self._json(200, {
                "ok": True,
                "action": action,
                "result": result,
                "candidates": remaining,
                "status": memory_status(),
            })
            return

        if path == "/api/memory/backup":
            node = NODE_EXE if os.path.isfile(NODE_EXE) else node_bin()
            if not os.path.isfile(MNEMON_CLI):
                self._json(500, {"ok": False, "error": "mnemon CLI not installed"})
                return
            try:
                subprocess.Popen(
                    [node, MNEMON_CLI, "mirror", "--data-dir", MNEMON_VAULT, "--mirror-dir", MEMORY_MIRROR],
                    cwd=MNEMON_PLUGIN,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=no_window_flags(),
                )
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})
                return
            self._json(200, {"ok": True, "accepted": True, "status": memory_status()})
            return

        if path == "/api/prompts":
            payload = self._read_json()
            prompts = payload.get("prompts") if isinstance(payload, dict) else payload
            if not isinstance(prompts, list):
                self._json(400, {"ok": False, "error": "prompts must be an array"})
                return
            saved = save_prompts(prompts)
            self._json(200, {"ok": True, "prompts": saved})
            return

        if path == "/api/wallpaper":
            payload = self._read_json(limit=32 * 1024 * 1024)
            data_url = payload.get("dataUrl") if isinstance(payload, dict) else None
            if not isinstance(data_url, str) or "," not in data_url:
                self._json(400, {"ok": False, "error": "missing dataUrl"})
                return
            header, encoded = data_url.split(",", 1)
            mime = "image/jpeg"
            if "image/png" in header:
                mime = "image/png"
            elif "image/webp" in header:
                mime = "image/webp"
            try:
                raw = base64.b64decode(encoded, validate=True)
            except Exception:
                self._json(400, {"ok": False, "error": "invalid base64"})
                return
            if not raw or len(raw) > MAX_WALLPAPER_BYTES:
                self._json(413, {"ok": False, "error": "image too large"})
                return
            ext = {"image/png": "png", "image/webp": "webp"}.get(mime, "jpg")
            assets_dir = os.path.join(PLUGIN_DIR, "assets")
            os.makedirs(assets_dir, exist_ok=True)
            for old_ext in ("jpg", "jpeg", "png", "webp"):
                old_file = os.path.join(assets_dir, f"custom-wallpaper.{old_ext}")
                if old_ext != ext and os.path.exists(old_file):
                    try:
                        os.unlink(old_file)
                    except Exception:
                        pass
            target = os.path.join(assets_dir, f"custom-wallpaper.{ext}")
            with open(target, "wb") as f:
                f.write(raw)
            cfg = load_config()
            cfg["wallpaperPath"] = f"assets/custom-wallpaper.{ext}"
            save_config(cfg)
            threading.Thread(target=trigger_apply, daemon=True).start()
            self._json(200, {"ok": True, "path": cfg["wallpaperPath"], "url": "/wallpaper"})
            return

        if path == "/api/mcp-profiles":
            payload = self._read_json()
            action = str(payload.get("action") or "").strip().lower()
            try:
                if action == "apply":
                    profile = str(payload.get("profile") or "").strip()
                    if not profile:
                        self._json(400, {"ok": False, "error": "missing profile"})
                        return
                    self._json(200, mcp_profile_command(["apply", profile]))
                    return
                if action == "toggle":
                    domain_id = str(payload.get("id") or "").strip()
                    enabled = bool(payload.get("enabled"))
                    if not domain_id:
                        self._json(400, {"ok": False, "error": "missing id"})
                        return
                    self._json(200, mcp_profile_command(["toggle", domain_id, "on" if enabled else "off"]))
                    return
                self._json(400, {"ok": False, "error": "unknown action"})
                return
            except Exception as error:
                self._json(500, {"ok": False, "error": str(error)})
                return

        if path == "/api/snapshot":
            payload = self._read_json(limit=4 * 1024 * 1024)
            markdown = payload.get("markdown") if isinstance(payload, dict) else None
            if not isinstance(markdown, str) or not markdown.strip():
                self._json(400, {"ok": False, "error": "empty markdown"})
                return
            if len(markdown.encode("utf-8")) > 3 * 1024 * 1024:
                self._json(413, {"ok": False, "error": "snapshot too large"})
                return
            os.makedirs(SNAPSHOT_DIR, exist_ok=True)
            target = safe_snapshot_name(payload.get("title"))
            with open(target, "w", encoding="utf-8") as f:
                f.write(markdown)
            name = os.path.basename(target)
            self._json(200, {
                "ok": True,
                "name": name,
                "path": target,
                "url": "/api/snapshot/" + urllib.parse.quote(name),
            })
            return

        self._json(404, {"ok": False, "error": "not found"})


def main():
    port_env = os.environ.get("ANTIGRAVITY_SIDECAR_WEB_PORT") or os.environ.get("PORT")
    port = int(port_env) if port_env else 39290
    RUNTIME_PORT[0] = port
    write_sidecar_token(SIDECAR_TOKEN)
    server = ThreadingHTTPServer(("127.0.0.1", port), WallpaperHandler)
    actual_port = server.server_address[1]
    RUNTIME_PORT[0] = actual_port
    server.daemon_threads = True
    write_runtime_port(actual_port)
    claim_lock(actual_port)
    print(f"[WallpaperSidecar] Ready on http://127.0.0.1:{actual_port}", flush=True)
    threading.Thread(target=delayed_autostart, daemon=True).start()
    threading.Thread(target=theme_watchdog, daemon=True).start()
    threading.Thread(target=lock_guard, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_live_daemon()


atexit.register(stop_live_daemon)

if __name__ == "__main__":
    main()
