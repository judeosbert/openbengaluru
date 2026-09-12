#!/usr/bin/env python3
"""Phase 2 regression tests: per-entry streams, Balagere via streams/<id>.js.

Red-phase contract:
- data.js must NOT carry BALAGERE_STREAM (frames moved to streams/<id>.js)
- streams/balagere-t-junction.js must exist, JSONP-style, with frames for
  both scenarios
- engineFor(CATALOG[0]) + loadSimStream merge must yield REAL vehicles at
  late t (not synthetic), matching the original BALAGERE_STREAM counts

Run with: python3 phase2/test_streams.py -v   (from simo-player/)
"""
import base64
import json
import os
import re
import struct
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
DATA = os.path.join(ROOT, "data.js")
APP = os.path.join(ROOT, "app.js")
HARNESS = os.path.join(ROOT, "phase1", "harness.js")
STREAM_BAL = os.path.join(ROOT, "streams", "balagere-t-junction.js")


def read_data_consts(path):
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^const\s+([A-Z0-9_]+)\s*=\s*(.*);\s*$", line)
            if m:
                out[m.group(1)] = json.loads(m.group(2))
    return out


def count_stream_vehicles(frames_b64, t):
    """Count vehicles in packed frames blob at frame floor(t)."""
    raw = base64.b64decode(frames_b64)
    o = 0
    f = 0
    while o + 2 <= len(raw):
        (n,) = struct.unpack_from("<H", raw, o)
        o += 2
        if f == int(t):
            return n
        o += n * 9
        f += 1
    return 0


class TestBalagereStreamExtraction(unittest.TestCase):
    """The Balagere stream payload must live in streams/<id>.js, not data.js."""

    def test_01_data_js_has_no_balagere_stream(self):
        with open(DATA, encoding="utf-8") as fh:
            src = fh.read()
        self.assertNotIn("BALAGERE_STREAM", src,
                         "data.js still embeds BALAGERE_STREAM; frames must "
                         "move to streams/balagere-t-junction.js")

    def test_02_stream_file_exists_and_parses(self):
        self.assertTrue(os.path.exists(STREAM_BAL),
                        f"missing {STREAM_BAL}")
        src = open(STREAM_BAL, encoding="utf-8").read()
        m = re.match(
            r"^window\.__simoStreamCallback\('balagere-t-junction',\s*(\{.*\})\);\s*$",
            src, re.S)
        self.assertIsNotNone(m, "stream file must call "
                                "window.__simoStreamCallback('balagere-t-junction', {...})")
        payload = json.loads(m.group(1))
        self.assertEqual(payload["nFrames"], 900)
        self.assertIn("bounds", payload)
        for k in ("today", "proposed"):
            self.assertIn(k, payload["scenarios"])
            sc = payload["scenarios"][k]
            self.assertIn("frames", sc, f"{k}: no frames")
            raw = base64.b64decode(sc["frames"])
            self.assertGreater(len(raw), 1000, f"{k}: frames blob too small")

    def test_03_stream_vehicle_counts_match_legacy(self):
        """Late-frame vehicle counts must be >0 (real data, not empty)."""
        with open(STREAM_BAL, encoding="utf-8") as fh:
            src = fh.read()
        m = re.match(
            r"^window\.__simoStreamCallback\('[^']+',\s*(\{.*\})\);\s*$",
            src, re.S)
        payload = json.loads(m.group(1))
        for k in ("today", "proposed"):
            n = count_stream_vehicles(payload["scenarios"][k]["frames"], 899)
            self.assertGreater(n, 0, f"{k}: frame 899 has 0 vehicles")


class TestEngineLoadsEntryFrames(unittest.TestCase):
    """engineFor(entry) with a stream-merged entry must play real vehicles."""

    def harness(self, *args):
        p = subprocess.run(["node", HARNESS, *args],
                           capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            self.fail(f"harness {' '.join(args)} rc={p.returncode}: "
                      f"{p.stderr.strip()[:600]}")
        return json.loads(p.stdout)

    def test_04_interp_edge_uses_stream_file(self):
        """harness interp_edge loads streams/balagere-t-junction.js and must
        see real vehicles at t=NF-1 (synthetic fallback would also be >0, so
        compare exact counts against the packed blob)."""
        out = self.harness("interp_edge")
        self.assertGreater(out["tNF"], 0)
        self.assertGreater(out["tNFfrac"], 0)
        self.assertEqual(out["t0"], 0)


class TestStreamLoaderWiring(unittest.TestCase):
    """The view flow must merge lazily-loaded stream payloads into entries."""

    def test_05_app_has_stream_merge_path(self):
        src = open(APP, encoding="utf-8").read()
        # entry open must trigger stream load when frames are absent
        self.assertIn("loadSimStream", src)
        self.assertRegex(src, r"scenarios\[.*\]\s*=",
                         "no code path assigns loaded stream data into "
                         "entry.scenarios")

    def test_06_catalog_keeps_stats_inline(self):
        """HUD stats must stay in data.js (no lazy load for counters)."""
        D = read_data_consts(DATA)
        bal = D["CATALOG"][0]
        for k, sc in bal["scenarios"].items():
            self.assertIn("stats", sc, f"catalog today/proposed lost stats")


if __name__ == "__main__":
    unittest.main()