#!/usr/bin/env python3
"""
Dynamic Island - volume + audio level bridge.

Runs in its own process on purpose: pycaw/comtypes initialises COM in a way
that conflicts with the WinRT apartment used by bridge.py, so they cannot live
in the same interpreter.

stdout: one JSON object per line
    {"type":"volume","level":0.62,"muted":false}
    {"type":"peak","level":0.37}
"""

import json
import sys
import time

import comtypes  # noqa: F401  (initialises COM before pycaw is imported)
from pycaw.pycaw import AudioUtilities, IAudioMeterInformation

VOLUME_POLL = 0.18
PEAK_POLL = 0.09


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def read_volume():
    endpoint = AudioUtilities.GetSpeakers().EndpointVolume
    return round(endpoint.GetMasterVolumeLevelScalar(), 4), bool(endpoint.GetMute())


def read_peak():
    peak = 0.0
    try:
        for session in AudioUtilities.GetAllSessions():
            if not session._ctl:
                continue
            try:
                meter = session._ctl.QueryInterface(IAudioMeterInformation)
                value = meter.GetPeakValue()
                if value > peak:
                    peak = value
            except Exception:
                continue
    except Exception:
        pass
    return round(peak, 3)


def main():
    try:
        last = None
        while True:
            level, muted = read_volume()
            if last is None or abs(level - last[0]) > 0.004 or muted != last[1]:
                emit({"type": "volume", "level": level, "muted": muted})
                last = (level, muted)
            time.sleep(VOLUME_POLL)

            emit({"type": "peak", "level": read_peak()})
            time.sleep(PEAK_POLL)
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # report, never crash silently
        emit({"type": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
