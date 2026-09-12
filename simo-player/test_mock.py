#!/usr/bin/env python3
"""Layer A tests for the simo-player mockup (BalagereTrafficSpec plan).

Runs with:  python3 test_mock.py -v        (from inside simo-player/)

Targets: data.js (generated artifact), the --export-mock extension of
sim/build_player.py, index.html statics, and — via the shared Node vm harness
in phase1/harness.js — the pure-logic head of app.js (file-chip classifier,
approve flow, engine frame-edge safety, placement scale clamp).

No SUMO dependency. Node (>=16, for atob) must be on PATH for harness tests.
"""
import base64
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data.js")
APP = os.path.join(HERE, "app.js")
INDEX = os.path.join(HERE, "index.html")
HARNESS = os.path.join(HERE, "phase1", "harness.js")
FIXDIR = os.path.join(HERE, "phase1")
GENERATOR = os.path.join(HERE, "..", "sim", "build_player.py")

EXPECTED_CONSTS = ["BALAGERE_CSS_STYLE", "LANES_PALETTE", "BALAGERE_GEOMETRY",
                   "OTHER_SIMS", "CATALOG"]
ANCHOR = (12.9517, 77.7894)          # plan: latlngAnchor
DEMAND_BALAGERE = 5743               # real peak demand (build_player note)
SILK_BOARD_ID = "silk-board-peak-baseline"  # only entry allowed an oversized zone


def read_data_consts(path):
    """data.js authoring contract: every top-level definition is ONE line of the
    form `const NAME = <valid JSON>;` so this python layer can json.loads it."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"data.js missing: {path}")
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^const\s+([A-Z0-9_]+)\s*=\s*(.*);\s*$", line)
            if m:
                out[m.group(1)] = json.loads(m.group(2))
    return out


def decode_stats(b64, nframes):
    raw = base64.b64decode(b64)
    if len(raw) != nframes * 5 * 2:
        raise ValueError(f"stats blob {len(raw)} bytes != {nframes}*5*2")
    vals = struct.unpack("<%dH" % (nframes * 5), raw)
    return [vals[i * 5:(i + 1) * 5] for i in range(nframes)]


def segs_cross(a, b, c, d):
    """Strict crossing test (shared endpoints / collinear touches ignored)."""
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    d1, d2 = orient(c, d, a), orient(c, d, b)
    d3, d4 = orient(a, b, c), orient(a, b, d)
    return (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0) and \
        d1 != 0 and d2 != 0 and d3 != 0 and d4 != 0


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.D = read_data_consts(DATA)
        except Exception as e:          # red phase: artifact missing/unreadable
            cls.D = e

    def consts(self):
        if not isinstance(getattr(self, "D"), dict):
            self.fail(f"data.js not readable: {self.D}")
        missing = [c for c in EXPECTED_CONSTS if c not in self.D]
        if missing:
            self.fail(f"data.js missing top-level consts: {missing}")
        return self.D

    def app_src(self):
        if not os.path.exists(APP):
            self.fail(f"app.js missing: {APP}")
        with open(APP, encoding="utf-8") as fh:
            return fh.read()

    def harness(self, *args):
        """Run the shared Node vm harness; any non-zero exit fails the test with
        the harness's own reason (e.g. 'missing file: app.js')."""
        if not os.path.exists(HARNESS):
            self.fail(f"harness missing: {HARNESS}")
        p = subprocess.run(["node", HARNESS, *args],
                           capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            self.fail(f"harness {' '.join(args)} rc={p.returncode}: "
                      f"{p.stderr.strip()[:600]}")
        return json.loads(p.stdout)


# 1 ---------------------------------------------------------------------------
class TestCatalogStructure(Base):
    def test_01_catalog_structure(self):
        D = self.consts()
        cat = D["CATALOG"]
        self.assertEqual(len(cat), 9, f"catalog must hold 9 sims, got {len(cat)}")
        for e in cat:
            for k in ("id", "title", "author", "anchor", "rotation", "demand",
                      "peakServed", "zonePoly", "addedAt", "scenarios", "nFrames"):
                self.assertIn(k, e, f"{e.get('id')}: missing key {k}")
            self.assertIsInstance(e["anchor"], list)
            lat, lng = e["anchor"]
            self.assertTrue(12.5 < lat < 13.3 and 77.3 < lng < 78.1,
                            f"{e['id']}: anchor {e['anchor']} outside Bangalore")
            self.assertIsInstance(e["zonePoly"], list)
            self.assertGreaterEqual(len(e["zonePoly"]), 3)
            self.assertIsInstance(e["scenarios"], dict)
            self.assertGreaterEqual(len(e["scenarios"]), 1)
            for skey, sc in e["scenarios"].items():
                self.assertIn("lanes", sc, f"{e['id']}/{skey}: no lanes")
                self.assertGreater(len(sc["lanes"]), 0,
                                   f"{e['id']}/{skey}: lanes empty")
                for lane in sc["lanes"]:
                    self.assertIn("p", lane)
                    self.assertIn("w", lane)
                    self.assertGreaterEqual(len(lane["p"]), 2)
                    self.assertGreater(lane["w"], 0)


# 2 ---------------------------------------------------------------------------
class TestGeometryAnchor(Base):
    def test_02_geometry_anchor_presence(self):
        D = self.consts()
        g = D["BALAGERE_GEOMETRY"]
        self.assertIn("latlngAnchor", g)
        self.assertIn("rotation", g)
        self.assertIsInstance(g["rotation"], (int, float))
        lat, lng = g["latlngAnchor"]
        self.assertAlmostEqual(lat, ANCHOR[0], delta=0.01)
        self.assertAlmostEqual(lng, ANCHOR[1], delta=0.01)
        scen = g["scenarios"]
        self.assertIn("today", scen)
        self.assertIn("proposed", scen)
        self.assertTrue(any(len(s.get("phases", [])) > 0
                            for s in scen.values()),
                        "at least one scenario must carry phases")


# 3 ---------------------------------------------------------------------------
class TestPhaseCycle(Base):
    def test_03_phase_cycle_sums(self):
        D = self.consts()
        pro = D["BALAGERE_GEOMETRY"]["scenarios"]["proposed"]
        phases = pro["phases"]
        self.assertGreater(len(phases), 0)
        cyc = sum(float(p[0]) for p in phases)
        self.assertGreater(cyc, 0)
        self.assertLessEqual(cyc, 180, f"phase cycle {cyc}s exceeds 180s")
        states = [p[1] for p in phases]
        self.assertTrue(all(len(st) == len(states[0]) for st in states),
                        "phase state strings differ in length")
        chars = {ch for st in states for ch in st}
        self.assertLessEqual(chars, set("Ggyr"),
                             f"unexpected signal states: {chars}")
        self.assertIn("G", chars)
        self.assertIn("y", chars)
        links = pro["links"]
        self.assertGreater(len(links), 0, "proposed must have controlled links")
        max_idx = max(i for idxs in links.values() for i in idxs)
        self.assertGreater(len(states[0]), max_idx,
                           f"state len {len(states[0])} <= max linkIndex {max_idx}")
        # today's give-way junction has no signal logic
        self.assertEqual(len(D["BALAGERE_GEOMETRY"]["scenarios"]["today"]
                             ["phases"]), 0)


# 4 ---------------------------------------------------------------------------
class TestStreamsDeterministic(Base):
    def test_04_streams_deterministic(self):
        if not os.path.exists(DATA):
            self.fail(f"data.js missing: {DATA}")
        if not os.path.exists(GENERATOR):
            self.fail(f"generator missing: {GENERATOR}")
        with tempfile.TemporaryDirectory() as td:
            outs = [os.path.join(td, "a.js"), os.path.join(td, "b.js")]
            for out in outs:
                p = subprocess.run(
                    [sys.executable, GENERATOR, "--export-mock", out],
                    capture_output=True, text=True, timeout=600)
                self.assertEqual(p.returncode, 0,
                                 f"generator failed: {p.stderr.strip()[:400]}")
                self.assertTrue(os.path.exists(out),
                                "generator produced no output — "
                                "is --export-mock implemented?")
            with open(outs[0], "rb") as fh:
                b1 = fh.read()
            with open(outs[1], "rb") as fh:
                b2 = fh.read()
        self.assertEqual(b1, b2, "re-running --export-mock is not byte-stable")
        with open(DATA, "rb") as fh:
            committed = fh.read()
        self.assertEqual(committed, b1,
                         "committed data.js differs from a fresh --export-mock run")


# 5 ---------------------------------------------------------------------------
class TestStats(Base):
    def test_05_stats_monotone(self):
        D = self.consts()
        for e in D["CATALOG"]:
            nf = e["nFrames"]
            for skey, sc in e["scenarios"].items():
                self.assertIn("stats", sc, f"{e['id']}/{skey}: no stats blob")
                rows = decode_stats(sc["stats"], nf)
                through = [r[0] for r in rows]
                self.assertTrue(all(a <= b for a, b in zip(through, through[1:])),
                                f"{e['id']}/{skey}: through not non-decreasing")
                flat = [v for r in rows for v in r]
                self.assertTrue(all(isinstance(v, int) and 0 <= v <= 65535
                                    for v in flat))
                qmax = max(r[3] for r in rows)
                self.assertLess(qmax, e["demand"],
                                f"{e['id']}/{skey}: queued {qmax} !< demand "
                                f"{e['demand']}")


# 6 ---------------------------------------------------------------------------
class TestZones(Base):
    def test_06_zones_plausible(self):
        D = self.consts()
        others = D["OTHER_SIMS"]
        self.assertEqual(len(others), 8, f"need 8 fake sims, got {len(others)}")
        for e in others:
            poly = e["zonePoly"]
            self.assertGreaterEqual(len(poly), 3, f"{e['id']}: zone < 3 pts")
            for lat, lng in poly:
                self.assertTrue(12.80 <= lat <= 13.05,
                                f"{e['id']}: lat {lat} out of range")
                self.assertTrue(77.50 <= lng <= 77.85,
                                f"{e['id']}: lng {lng} out of range")
            area = 0.5 * abs(sum(
                poly[i][1] * poly[(i + 1) % len(poly)][0]
                - poly[(i + 1) % len(poly)][1] * poly[i][0]
                for i in range(len(poly))))
            self.assertGreater(area, 0, f"{e['id']}: degenerate zone polygon")
            pts = [(lng, lat) for lat, lng in poly]
            n = len(pts)
            for i in range(n):
                for j in range(i + 1, n):
                    if j == i + 1 or (i == 0 and j == n - 1):
                        continue    # adjacent edges share a vertex
                    if segs_cross(pts[i], pts[(i + 1) % n],
                                  pts[j], pts[(j + 1) % n]):
                        self.fail(f"{e['id']}: zone self-intersects at "
                                  f"edges {i},{j}")
            if e["id"] != SILK_BOARD_ID:
                dlat = max(p[0] for p in poly) - min(p[0] for p in poly)
                dlng = max(p[1] for p in poly) - min(p[1] for p in poly)
                self.assertLess(dlat, 0.0006,
                                f"{e['id']}: zone {dlat * 111e3:.0f} m tall "
                                "(> ~60 m safety bound)")
                self.assertLess(dlng, 0.0006,
                                f"{e['id']}: zone {dlng * 108e3:.0f} m wide "
                                "(> ~60 m safety bound)")


# 7 ---------------------------------------------------------------------------
class TestBundlePlaceholder(Base):
    def test_07_bundle_placeholder_roundtrip(self):
        fixtures = ["sample.rou.xml", "sample.net.xml", "sample.sumocfg",
                    "notes.txt"]
        for f in fixtures:
            self.assertTrue(os.path.exists(os.path.join(FIXDIR, f)),
                            f"phase1 fixture missing: {f}")
        pairs = [[f, os.path.getsize(os.path.join(FIXDIR, f))]
                 for f in fixtures]
        pairs.append(["UPPER.ROU.XML", 12])      # case-insensitive extension
        out = self.harness("chips", json.dumps(pairs))
        self.assertEqual(len(out), len(pairs))
        kinds = [(r or {}).get("kind") for r in out]
        self.assertEqual(kinds, ["routes", "network", "config", None, "routes"],
                         f"classifier results: {kinds}")
        for r in out[:3]:
            self.assertGreater(r.get("size", 0), 0)
            self.assertIn("name", r)


# 8 ---------------------------------------------------------------------------
class TestApproveFlow(Base):
    def test_08_approve_flow(self):
        draft = {
            "username": "test.rider",
            "files": [{"name": "x.rou.xml", "size": 10, "kind": "routes"}],
            "latlng": [12.9601, 77.7502],
            "rotation": 5,
            "title": "Harness Test Junction",
            "desc": "approve-flow fixture",
            "simMeta": {"demand": 1200, "peakServed": 640, "nFrames": 900,
                        "scenarios": {"today": {
                            "title": "TODAY", "sub": "fixture",
                            "lanes": [{"p": [[0, 0], [500, 0]], "w": 3.2}],
                            "phases": []}}},
        }
        out = self.harness("approve", json.dumps(draft))
        self.assertEqual(out["after"], out["before"] + 1,
                         "catalog did not grow by exactly 1")
        self.assertTrue(out["origUnmutated"],
                        "approveDraft mutated the previous catalog array")
        self.assertEqual(out["view"], "submissions")
        self.assertTrue(out["draftCleared"], "draftSub not cleared")
        self.assertEqual(out["lastAuthor"], "test.rider")
        self.assertEqual(out["lastTitle"], "Harness Test Junction")
        self.assertEqual(out["lastAnchor"], [12.9601, 77.7502])
        self.assertEqual(out["activeSimId"], out["lastId"],
                         "active panel must focus the new entry")
        self.assertTrue(out["lastScenariosHaveLanes"],
                        "approved entry must carry scenario lanes")


# 9 ---------------------------------------------------------------------------
class TestABToggle(Base):
    def test_09_ab_toggle_shape(self):
        D = self.consts()
        bal = D["CATALOG"][0]
        keys = set(bal["scenarios"].keys())
        self.assertLessEqual(keys, {"today", "proposed"})
        self.assertEqual(keys, {"today", "proposed"},
                         "Balagere must carry both scenarios")
        spath = os.path.join(HERE, "streams", "balagere-t-junction.js")
        with open(spath, encoding="utf-8") as fh:
            spayload = json.loads(re.match(
                r"^window\.__simoStreamCallback\('[^']+',\s*(\{.*\})\);\s*$",
                fh.read(), re.S).group(1))
        self.assertEqual(set(spayload["scenarios"].keys()),
                         {"today", "proposed"})
        for e in D["OTHER_SIMS"]:
            self.assertLessEqual(set(e["scenarios"].keys()),
                                 {"today", "proposed"},
                                 f"{e['id']}: bad scenario keys")
        src = self.app_src()
        self.assertRegex(src, r"SimScenarioToggle",
                         "app.js must expose a SimScenarioToggle component")
        self.assertRegex(src, r"activeScenario")


# 10 --------------------------------------------------------------------------
class TestHtml(Base):
    def test_10_html_opens(self):
        if not os.path.exists(INDEX):
            self.fail(f"index.html missing: {INDEX}")
        h = open(INDEX, encoding="utf-8").read()
        self.assertNotIn('type="module"', h)
        self.assertNotIn("type='module'", h)
        self.assertRegex(h, r'leaflet@1\.9\.4/dist/leaflet\.css')
        self.assertRegex(h, r'leaflet@1\.9\.4/dist/leaflet\.js')
        self.assertRegex(h, r'react@18[^"]*/umd/react\.production\.min\.js')
        self.assertRegex(h, r'react-dom@18[^"]*/umd/react-dom\.production\.min\.js')
        self.assertRegex(h, r'babel[^"]*standalone[^"]*\.min\.js')
        self.assertIn('<div id="root">', h)
        self.assertRegex(h, r'<script[^>]*src="data\.js"')
        m = re.search(r'<script[^>]*type="text/babel"[^>]*src="app\.js"', h)
        self.assertIsNotNone(m, 'app.js must load as type="text/babel"')
        self.assertLess(h.index('src="data.js"'), h.index('src="app.js"'),
                        "data.js must load before app.js")


# 11 --------------------------------------------------------------------------
class TestOverlayZeroFrame(Base):
    def test_11_overlay_zero_frame_safe(self):
        out = self.harness("interp_edge")
        self.assertEqual(out["t0"], 0, "frame 0 is empty in the real stream")
        self.assertGreater(out["tNF"], 0, "frame NF-1 must yield vehicles")
        self.assertGreater(out["tNFfrac"], 0, "t=NF-0.1 must interpolate safely")
        self.assertGreater(out["tOver"], 0, "t>NF-1 must clamp, not crash")
        self.assertEqual(out["tNeg"], 0, "negative t must clamp to frame 0")


# 12 --------------------------------------------------------------------------
class TestMinScale(Base):
    def test_12_min_scale_keeps_road_visible(self):
        out = self.harness("scale", "12.9517", "10")
        px_m = out["pxPerMetre"]
        self.assertGreater(3.0 * px_m, 4,
                           f"at zoom 10 a 3.0 m lane draws {3.0 * px_m:.2f}px "
                           "(must stay > 4px via the LATM min-scale clamp)")
        hi = self.harness("scale", "12.9517", "18")
        self.assertGreaterEqual(hi["pxPerMetre"], px_m,
                                "scale must not shrink when zooming in")


if __name__ == "__main__":
    unittest.main()
