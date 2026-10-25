#!/usr/bin/env python3
"""
Dynamic Island - media bridge.

Reads the Windows Global System Media Transport Controls (SMTC) session, which is
the same source of truth the OS uses for its own media flyout. Any app that shows
up in Windows' volume flyout (Spotify, Edge, Chrome, Groove, foobar2000, VLC...)
shows up here too.

Protocol
--------
stdout : one JSON object per line
stdin  : one command per line ("play", "pause", "next", "prev", "seek:<0-1>")
"""

import asyncio
import ctypes
import json
import os
import sys
import threading
import queue
import hashlib
import winreg
from ctypes import wintypes

from winrt import runtime as rt

rt.init_apartment(rt.MTA)

from winrt.windows.media.control import (  # noqa: E402
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PbStatus,
)
from winrt.windows.storage.streams import DataReader  # noqa: E402

POLL_SECONDS = 0.5
THUMB_DIR = os.path.join(os.environ.get("TEMP", "."), "dynamic-island-art")
os.makedirs(THUMB_DIR, exist_ok=True)

_cmds: "queue.Queue[str]" = queue.Queue()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _stdin_reader():
    for line in sys.stdin:
        line = line.strip()
        if line:
            _cmds.put(line)


async def read_thumb(ref, key):
    """Save album art to a cache file, return its file name."""
    stream = await ref.open_read_async()
    size = stream.size
    reader = DataReader(stream)
    await reader.load_async(size)
    buf = bytearray(size)
    reader.read_bytes(buf)
    raw = bytes(buf)
    digest = hashlib.sha1(raw).hexdigest()[:16]
    name = f"{digest}{sniff_ext(raw)}"
    path = os.path.join(THUMB_DIR, name)
    if not os.path.exists(path):
        with open(path, "wb") as fh:
            fh.write(raw)
    return name


def sniff_ext(raw):
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if raw[:2] == b"\xff\xd8":
        return ".jpg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    if raw[:2] == b"BM":
        return ".bmp"
    if raw[:4] == b"GIF8":
        return ".gif"
    return ".png"


def pick_session(manager, last_app):
    sessions = list(manager.get_sessions())
    if not sessions:
        return None

    current = manager.get_current_session()
    if current is not None:
        return current

    playing = [s for s in sessions if s.get_playback_info().playback_status == PbStatus.PLAYING]
    if playing:
        return playing[0]

    for s in sessions:
        if s.source_app_user_model_id == last_app:
            return s
    return sessions[0]


async def run():
    threading.Thread(target=_stdin_reader, daemon=True).start()

    try:
        manager = await Manager.request_async()
    except Exception as exc:  # pragma: no cover - environment dependent
        emit({"type": "error", "message": f"media manager unavailable: {exc}"})
        return

    last_state = None
    last_thumb_key = None
    last_thumb_name = None
    last_app = None
    last_devices = None
    last_system = None
    tick = 0

    while True:
        try:
            while not _cmds.empty():
                cmd = _cmds.get_nowait()
                await handle_command(manager, cmd)

            if tick % 3 == 0:
                devices = poll_devices()
                if devices != last_devices:
                    emit(devices)
                    last_devices = devices
            if tick % 9 == 0:
                system = poll_system()
                if system != last_system:
                    emit(system)
                    last_system = system
            tick += 1

            session = pick_session(manager, last_app)
            if session is None:
                state = {"type": "media", "active": False}
                if state != last_state:
                    emit(state)
                    last_state = state
                await asyncio.sleep(POLL_SECONDS)
                continue

            last_app = session.source_app_user_model_id
            props = await session.try_get_media_properties_async()
            info = session.get_playback_info()
            timeline = session.get_timeline_properties()

            status = {
                PbStatus.PLAYING: "playing",
                PbStatus.PAUSED: "paused",
                PbStatus.STOPPED: "stopped",
                PbStatus.CLOSED: "stopped",
                PbStatus.CHANGING: "changing",
                PbStatus.OPENED: "paused",
            }.get(info.playback_status, "paused")

            thumb_name = None
            key = (props.title, props.artist, props.album_title)
            if props.thumbnail is not None:
                if key != last_thumb_key:
                    try:
                        last_thumb_name = await read_thumb(props.thumbnail, key)
                        last_thumb_key = key
                    except Exception:
                        last_thumb_name = None
                thumb_name = last_thumb_name
            else:
                last_thumb_key = None
                last_thumb_name = None

            duration = timeline.end_time.total_seconds()
            position = timeline.position.total_seconds()
            if duration < 0:
                duration = 0
            if position < 0:
                position = 0

            state = {
                "type": "media",
                "active": True,
                "app": friendly_app(session.source_app_user_model_id),
                "title": props.title or "",
                "artist": props.artist or "",
                "album": props.album_title or "",
                "status": status,
                "position": round(position, 2),
                "duration": round(duration, 2),
                "thumb": thumb_name,
                "live": duration <= 1,
            }

            if state != last_state:
                emit(state)
                last_state = state

        except Exception as exc:  # keep the bridge alive no matter what
            try:
                emit({"type": "error", "message": str(exc)})
            except Exception:
                return

        await asyncio.sleep(POLL_SECONDS)


APP_NAMES = {
    "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify": "Spotify",
    "MSEdge": "Edge",
    "Chrome": "Chrome",
    "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic": "Media Player",
    "Microsoft.ZuneMusic": "Media Player",
    "foobar2000": "foobar2000",
    "vlc": "VLC",
}

CALL_HINTS = [
    ("chrome", "Chrome"),
    ("msedge", "Edge"),
    ("firefox", "Firefox"),
    ("teams", "Teams"),
    ("zoom", "Zoom"),
    ("discord", "Discord"),
    ("slack", "Slack"),
    ("skype", "Skype"),
    ("whatsapp", "WhatsApp"),
    ("telegram", "Telegram"),
    ("spotify", "Spotify"),
    ("camera", "Camera"),
    ("screensketch", "Snipping Tool"),
    ("obs", "OBS"),
]

CONSENT_BASE = r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore"


def friendly_call_app(raw):
    low = raw.lower()
    for needle, label in CALL_HINTS:
        if needle in low:
            return label
    name = raw.split("\\")[-1]
    name = name.split("!")[0]
    if "_" in name:
        name = name.split("_")[0]
    if name.lower().endswith(".exe"):
        name = name[:-4]
    return name


def active_devices(kind):
    """Apps currently using the microphone or camera, straight from Windows."""
    found = []

    def walk(key_path, depth):
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path)
        except OSError:
            return
        with key:
            index = 0
            while True:
                try:
                    child = winreg.EnumKey(key, index)
                except OSError:
                    break
                index += 1
                sub = key_path + "\\" + child
                used = None
                try:
                    sub_key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub)
                    with sub_key:
                        start, _ = winreg.QueryValueEx(sub_key, "LastUsedTimeStart")
                        stop, _ = winreg.QueryValueEx(sub_key, "LastUsedTimeStop")
                    used = (int(start), int(stop))
                except OSError:
                    used = None

                if used and used[0] > 0 and used[1] == 0:
                    found.append(friendly_call_app(child))
                elif depth < 2:
                    walk(sub, depth + 1)

    walk(CONSENT_BASE + "\\" + kind, 0)
    return sorted(set(found))


def poll_devices():
    try:
        mic = active_devices("microphone")
        cam = active_devices("webcam")
    except Exception:
        mic, cam = [], []
    return {"type": "call", "mic": mic, "camera": cam}


# --- system state: Focus Assist, screen sharing, window focusing -----------

_user32 = ctypes.windll.user32
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _enum_proc(hwnd, _param):
    try:
        if not _user32.IsWindowVisible(hwnd):
            return True
        length = _user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        _user32.GetWindowTextW(hwnd, buf, length + 1)
        _WINDOWS.append((hwnd, buf.value))
    except Exception:
        pass
    return True


_CALLBACK = WNDENUMPROC(_enum_proc)
_WINDOWS = []


def visible_windows():
    del _WINDOWS[:]
    try:
        _user32.EnumWindows(_CALLBACK, 0)
    except Exception:
        pass
    return list(_WINDOWS)


def focus_window(needle):
    """Bring the first window whose title matches to the front."""
    low = needle.lower()
    if not low:
        return False
    for hwnd, title in visible_windows():
        if low in title.lower():
            _user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            _user32.SetForegroundWindow(hwnd)
            return True
    return False


def focus_assist_on():
    """True while Focus Assist / Do Not Disturb is hiding notifications."""
    state = ctypes.c_int(0)
    try:
        hr = ctypes.windll.shell32.SHQueryUserNotificationState(ctypes.byref(state))
    except Exception:
        return False
    # 2 = QUNS_BUSY, 6 = QUNS_QUIET_TIME (the two "do not disturb" states)
    return hr == 0 and state.value in (2, 6)


SHARE_WORDS = (
    "is sharing",
    "sharing your screen",
    "sharing your entire screen",
    "screen share",
    "screen sharing",
    "is presenting",
    " - recording",
    "recording -",
)

SHARE_APPS = (
    ("obs", "OBS"),
    ("zoom", "Zoom"),
    ("teams", "Teams"),
    ("meet", "Google Meet"),
    ("discord", "Discord"),
    ("skype", "Skype"),
    ("slack", "Slack"),
    ("webex", "Webex"),
    ("chrome", "Chrome"),
    ("edge", "Edge"),
    ("firefox", "Firefox"),
)


def screen_sharing():
    """Best effort: Windows publishes no 'is my screen being captured' flag."""
    for _hwnd, title in visible_windows():
        low = title.lower()
        if not any(word in low for word in SHARE_WORDS):
            continue
        app = None
        for needle, label in SHARE_APPS:
            if needle in low:
                app = label
                break
        return {"app": app or "Screen"}
    return None


def poll_system():
    try:
        sharing = screen_sharing()
    except Exception:
        sharing = None
    try:
        focus = focus_assist_on()
    except Exception:
        focus = False
    return {"type": "system", "focus": focus, "sharing": sharing}


def friendly_app(app_id):
    if not app_id:
        return "Unknown"
    if app_id in APP_NAMES:
        return APP_NAMES[app_id]
    if "!" in app_id:
        return app_id.split("!")[-1]
    tail = app_id.split("\\")[-1]
    if tail.lower().endswith(".exe"):
        tail = tail[:-4]
    return tail.capitalize() if tail.islower() else tail


async def handle_command(manager, cmd):
    # Window focusing does not need a media session, so it comes first.
    if cmd.startswith("focus:"):
        try:
            focus_window(cmd.split(":", 1)[1])
        except Exception:
            pass
        return

    session = manager.get_current_session()
    if session is None:
        return
    try:
        if cmd == "play":
            await session.try_play_async()
        elif cmd == "pause":
            await session.try_pause_async()
        elif cmd == "toggle":
            status = session.get_playback_info().playback_status
            if status == PbStatus.PLAYING:
                await session.try_pause_async()
            else:
                await session.try_play_async()
        elif cmd == "next":
            await session.try_skip_next_async()
        elif cmd == "prev":
            await session.try_skip_previous_async()
        elif cmd.startswith("seek:"):
            fraction = max(0.0, min(1.0, float(cmd.split(":", 1)[1])))
            timeline = session.get_timeline_properties()
            total = timeline.end_time.total_seconds()
            if total > 0:
                target = timeline.start_time.total_seconds() + total * fraction
                await session.try_change_playback_position_async(
                    __import__("datetime").timedelta(seconds=target)
                )
    except Exception:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
