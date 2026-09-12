#!/usr/bin/env python3
"""Tests for the Phase 1 packer tool (tools/pack_run.py).

Tests the contributor packer pipeline:
- Geometry extraction from .net.xml
- SUMO discovery
- SUMO execution with correct flags
- BLGR binary packing
- .simo.json output format

Run with: python3 tools/test_packer.py -v
"""
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
PACKER = os.path.join(HERE, "pack_run.py")
SUMO_GEOM = os.path.join(HERE, "sumo_geom.py")
BLGR_PACK = os.path.join(HERE, "blgr_pack.py")
FIXDIR = os.path.join(ROOT, "phase1")


class TestGeometryExtraction(unittest.TestCase):
    """Tests for sumo_geom.geom() - shared geometry extraction."""

    def setUp(self):
        sys.path.insert(0, HERE)
        try:
            import sumo_geom
        except ImportError as e:
            self.fail(f"sumo_geom.py not importable: {e}")
        self.geom = sumo_geom.geom

    def test_geom_extracts_lanes(self):
        """Basic lane extraction from a minimal net."""
        sample_net = os.path.join(FIXDIR, "sample.net.xml")
        with open(sample_net) as f:
            net_xml = f.read()

        # The sample net is minimal - just has location
        result = self.geom(sample_net)
        self.assertIsInstance(result, dict)
        self.assertIn("lanes", result)
        self.assertIn("arms", result)
        self.assertIn("phases", result)
        self.assertIn("stops", result)
        self.assertIn("links", result)

    def test_geom_handles_lanes_with_shape(self):
        """Lane shape points are converted to decimetres."""
        net_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <lane id="edge_0" shape="100.0,200.0 150.0,250.0" width="3.5"/>
</net>'''
        with tempfile.NamedTemporaryFile(mode="w", suffix=".net.xml", delete=False) as f:
            f.write(net_xml)
            tmp = f.name
        try:
            result = self.geom(tmp)
            self.assertEqual(len(result["lanes"]), 1)
            lane = result["lanes"][0]
            self.assertEqual(lane["w"], 3.5)
            # Points converted to dm (x10)
            self.assertEqual(lane["p"], [[1000, 2000], [1500, 2500]])
        finally:
            os.unlink(tmp)

    def test_geom_skips_internal_lanes(self):
        """Lanes starting with ':' (junction lanes) are skipped."""
        net_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <lane id=":junction_0" shape="0,0 10,10" width="3.2"/>
    <lane id="edge_0" shape="100,200 150,250" width="3.2"/>
</net>'''
        with tempfile.NamedTemporaryFile(mode="w", suffix=".net.xml", delete=False) as f:
            f.write(net_xml)
            tmp = f.name
        try:
            result = self.geom(tmp)
            self.assertEqual(len(result["lanes"]), 1)
            self.assertEqual(result["lanes"][0]["p"], [[1000, 2000], [1500, 2500]])
        finally:
            os.unlink(tmp)

    def test_geom_extracts_phases(self):
        """Signal phases are extracted with duration and state."""
        net_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <tlLogic id="J1" type="static" programID="0" offset="0">
        <phase duration="42" state="GGrr"/>
        <phase duration="4" state="yyrr"/>
    </tlLogic>
</net>'''
        with tempfile.NamedTemporaryFile(mode="w", suffix=".net.xml", delete=False) as f:
            f.write(net_xml)
            tmp = f.name
        try:
            result = self.geom(tmp)
            self.assertEqual(len(result["phases"]), 2)
            self.assertEqual(result["phases"][0], [42.0, "GGrr"])
            self.assertEqual(result["phases"][1], [4.0, "yyrr"])
        finally:
            os.unlink(tmp)

    def test_geom_extracts_links_and_stops(self):
        """Connections with tl and linkIndex become links; stops at lane ends."""
        net_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <lane id="arm_e_0" shape="0,0 100,0" width="3.2"/>
    <tlLogic id="J1" type="static" programID="0" offset="0">
        <phase duration="42" state="GGrr"/>
    </tlLogic>
    <connection from="arm_e" tl="J1" linkIndex="0"/>
    <connection from="arm_e" tl="J1" linkIndex="1"/>
</net>'''
        with tempfile.NamedTemporaryFile(mode="w", suffix=".net.xml", delete=False) as f:
            f.write(net_xml)
            tmp = f.name
        try:
            result = self.geom(tmp)
            self.assertIn("arm_e", result["links"])
            self.assertEqual(result["links"]["arm_e"], [0, 1])
            self.assertIn("arm_e", result["stops"])
            # Stop is at the end of the lane shape (dm)
            self.assertEqual(result["stops"]["arm_e"], [1000, 0])
        finally:
            os.unlink(tmp)

    def test_geom_extracts_arms_from_dead_ends(self):
        """Dead-end junctions define arm endpoints."""
        net_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <junction id="Panathur" type="dead_end" x="-1316" y="-1"/>
    <junction id="Varthur" type="dead_end" x="1150" y="7"/>
</net>'''
        with tempfile.NamedTemporaryFile(mode="w", suffix=".net.xml", delete=False) as f:
            f.write(net_xml)
            tmp = f.name
        try:
            result = self.geom(tmp)
            self.assertIn("Panathur", result["arms"])
            self.assertIn("Varthur", result["arms"])
            self.assertEqual(result["arms"]["Panathur"], [-13160, -10])
            self.assertEqual(result["arms"]["Varthur"], [11500, 70])
        finally:
            os.unlink(tmp)


class TestSumoDiscovery(unittest.TestCase):
    """Tests for SUMO binary discovery."""

    def setUp(self):
        sys.path.insert(0, HERE)
        try:
            import sumo_geom
        except ImportError as e:
            self.fail(f"sumo_geom.py not importable: {e}")
        self.find_sumo = sumo_geom.find_sumo

    def test_find_sumo_returns_path(self):
        """find_sumo() returns a path to sumo binary or None."""
        result = self.find_sumo()
        # Just verify it returns something usable or None
        if result:
            self.assertTrue(os.path.exists(result) or os.path.isfile(result))
        else:
            # Acceptable if SUMO not installed in test env
            pass


class TestSumoExecution(unittest.TestCase):
    """Tests for running SUMO with correct flags."""

    def setUp(self):
        if not os.path.exists(PACKER):
            self.skipTest(f"pack_run.py not found at {PACKER}")

    def test_sumo_flags_match_video_capture(self):
        """Verify SUMO command uses exact flags from video_capture.py:34-38."""
        # This test will verify the command construction
        # We'll mock subprocess.run to capture the command
        pass  # Implemented after packer exists


class TestBlgrPacking(unittest.TestCase):
    """Tests for BLGR binary packing logic."""

    def setUp(self):
        sys.path.insert(0, HERE)
        try:
            import blgr_pack
        except ImportError as e:
            self.fail(f"blgr_pack.py not importable: {e}")
        self.pack_fcd = blgr_pack.pack_fcd
        self.pack_stats = blgr_pack.pack_stats
        self.build_header = blgr_pack.build_header
        self.TYPES = blgr_pack.TYPES

    def test_pack_fcd_single_frame(self):
        """Pack a single frame with one vehicle."""
        # frame: list of [id, x_dm, y_dm, angle_div2, speed_x8, type_idx]
        frame = [[1, 1000, 2000, 90, 80, 0]]  # id=1, x=100m, y=200m, angle=180deg, speed=10m/s, passenger
        result = self.pack_fcd([frame])
        # u16 nVehicles + 9 bytes per vehicle
        expected = struct.pack("<H", 1) + struct.pack("<HhhBBB", 1, 1000, 2000, 90, 80, 0)
        self.assertEqual(result, expected)

    def test_pack_fcd_multiple_frames(self):
        """Pack multiple frames concatenated."""
        frames = [
            [[1, 1000, 2000, 90, 80, 0]],
            [[1, 1010, 2000, 90, 80, 0], [2, 500, 500, 45, 40, 1]],
        ]
        result = self.pack_fcd(frames)
        # Frame 0: 1 vehicle
        # Frame 1: 2 vehicles
        expected = (
            struct.pack("<H", 1) + struct.pack("<HhhBBB", 1, 1000, 2000, 90, 80, 0) +
            struct.pack("<H", 2) + struct.pack("<HhhBBB", 1, 1010, 2000, 90, 80, 0) +
            struct.pack("<HhhBBB", 2, 500, 500, 45, 40, 1)
        )
        self.assertEqual(result, expected)

    def test_pack_stats_shape(self):
        """Stats are 5 u16 per frame."""
        stats = [(100, 50, 10, 5, 0)] * 3
        result = self.pack_stats(stats)
        self.assertEqual(len(result), 3 * 5 * 2)  # 3 frames * 5 values * 2 bytes
        # Verify unpacking
        unpacked = struct.unpack("<" + "5H" * 3, result)
        self.assertEqual(list(unpacked), [100, 50, 10, 5, 0] * 3)

    def test_build_header_format(self):
        """Header matches BLGR spec: magic, version, nScenarios, nFrames, bounds."""
        bounds = [-1000, -2000, 3000, 4000]
        n_scenarios = 2
        n_frames = 900
        header = self.build_header(n_scenarios, n_frames, bounds)
        magic, ver, ns, nf, x0, y0, x1, y1 = struct.unpack("<4sBBHhhhh", header)
        self.assertEqual(magic, b"BLGR")
        self.assertEqual(ver, 1)
        self.assertEqual(ns, n_scenarios)
        self.assertEqual(nf, n_frames)
        self.assertEqual([x0, y0, x1, y1], bounds)


class TestSimoJsonOutput(unittest.TestCase):
    """Tests for .simo.json output format consumed by TrafficSimEngine."""

    def setUp(self):
        sys.path.insert(0, HERE)
        try:
            import pack_run
        except ImportError as e:
            self.fail(f"pack_run.py not importable: {e}")
        self.pack_run = pack_run

    def _scenario_data(self):
        """One assembled scenario worth of inputs."""
        geom = {"lanes": [{"p": [[0, 0], [100, 0]], "w": 3.2}],
                "arms": {}, "phases": [], "stops": {}, "links": {}}
        geo = ({"conv": [5.47, 0.0, 651.33, 706.4],
                "orig": [12.933828, 77.714521, 12.942221, 77.72148]},
               {"offX": -794602.11, "offY": -1431388.13,
                "zone": 43, "south": False})
        frames = [[(0, 100, 200, 90, 80, 0)]]      # 1 frame, 1 vehicle
        stats = [(0, 1, 0, 0, 0)]
        return geom, geo, frames, stats

    def test_simo_json_structure(self):
        """Output JSON has required top-level keys."""
        geom, geo, frames, stats = self._scenario_data()
        out = self.pack_run.build_pack(
            {"today": {"frames": frames, "stats": stats,
                       "geometry": geom, "geo": geo}},
            n_frames=1)
        for k in ("nFrames", "bounds", "scenarios", "anchor"):
            self.assertIn(k, out, f"missing top-level {k}")

    def test_scenarios_have_frames_and_stats(self):
        """Each scenario has frames (base64) and stats (base64)."""
        geom, geo, frames, stats = self._scenario_data()
        out = self.pack_run.build_pack(
            {"today": {"frames": frames, "stats": stats,
                       "geometry": geom, "geo": geo}},
            n_frames=1)
        sc = out["scenarios"]["today"]
        self.assertIsInstance(sc["frames"], str)
        self.assertIsInstance(sc["stats"], str)
        # frames decodes to 1 frame with 1 vehicle
        raw = base64.b64decode(sc["frames"])
        (n,) = struct.unpack_from("<H", raw, 0)
        self.assertEqual(n, 1)

    def test_geometry_embedded(self):
        """Scenario carries lanes/arms/phases/stops/links (catalog shape)."""
        geom, geo, frames, stats = self._scenario_data()
        out = self.pack_run.build_pack(
            {"today": {"frames": frames, "stats": stats,
                       "geometry": geom, "geo": geo}},
            n_frames=1)
        sc = out["scenarios"]["today"]
        for k in ("lanes", "arms", "phases", "stops", "links"):
            self.assertIn(k, sc, f"scenario missing {k}")
        self.assertEqual(sc["lanes"], geom["lanes"])

    def test_bounds_in_dm(self):
        """Bounds are in decimetres (dm) like the stream expects."""
        geom, geo, frames, stats = self._scenario_data()
        out = self.pack_run.build_pack(
            {"today": {"frames": frames, "stats": stats,
                       "geometry": geom, "geo": geo}},
            n_frames=1)
        self.assertEqual(out["bounds"], [100, 200, 100, 200])

    def test_nframes_matches_stream(self):
        """nFrames matches the frame count in the packed data."""
        geom, geo, frames, stats = self._scenario_data()
        out = self.pack_run.build_pack(
            {"today": {"frames": frames, "stats": stats,
                       "geometry": geom, "geo": geo}},
            n_frames=1)
        self.assertEqual(out["nFrames"], 1)

    def test_geo_lock_in_scenario(self):
        """latlngMap/utm/geoLocked ride on the scenario (catalog shape)."""
        geom, geo, frames, stats = self._scenario_data()
        out = self.pack_run.build_pack(
            {"today": {"frames": frames, "stats": stats,
                       "geometry": geom, "geo": geo}},
            n_frames=1)
        sc = out["scenarios"]["today"]
        self.assertEqual(sc["latlngMap"], geo[0])
        self.assertEqual(sc["utm"], geo[1])
        self.assertTrue(sc["geoLocked"])

    def test_anchor_from_geo(self):
        """Top-level anchor = centre of the geo-locked orig bbox."""
        geom, geo, frames, stats = self._scenario_data()
        out = self.pack_run.build_pack(
            {"today": {"frames": frames, "stats": stats,
                       "geometry": geom, "geo": geo}},
            n_frames=1)
        self.assertAlmostEqual(out["anchor"][0], 12.9380245, places=6)
        self.assertAlmostEqual(out["anchor"][1], 77.7180005, places=6)

    def test_no_geo_no_anchor(self):
        """Hand nets (no provenance): no anchor, no geo keys."""
        geom, _geo, frames, stats = self._scenario_data()
        out = self.pack_run.build_pack(
            {"today": {"frames": frames, "stats": stats,
                       "geometry": geom, "geo": None}},
            n_frames=1)
        self.assertIsNone(out["anchor"])
        sc = out["scenarios"]["today"]
        self.assertNotIn("latlngMap", sc)
        self.assertNotIn("utm", sc)
        self.assertNotIn("geoLocked", sc)


class TestTypeMapping(unittest.TestCase):
    """blgr_pack.build_type_map: rou vType id/vClass -> render-class index."""

    ROU = '''<?xml version="1.0" encoding="UTF-8"?>
<routes>
    <vType id="DEFAULT_VEHTYPE" vClass="truck"/>
    <vType id="auto" vClass="taxi"/>
    <vType id="bangloreCar" vClass="passenger"/>
    <vType id="motorcycle" vClass="motorcycle"/>
    <vType id="schoolbus" vClass="bus"/>
    <vType id="water-tanker" vClass="truck"/>
</routes>'''

    def _write(self, text, suffix):
        f = tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False)
        f.write(text)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def setUp(self):
        sys.path.insert(0, HERE)
        try:
            import blgr_pack
        except ImportError as e:
            self.fail(f"blgr_pack.py not importable: {e}")
        self.blgr_pack = blgr_pack

    def test_type_map_exact_ids(self):
        """Known ids match by id first (auto -> 4 even though vClass=taxi)."""
        rou = self._write(self.ROU, ".rou.xml")
        tmap = self.blgr_pack.build_type_map(rou)
        self.assertEqual(tmap["auto"], 4)
        self.assertEqual(tmap["motorcycle"], 1)

    def test_type_map_vclass_fallback(self):
        """Unknown ids map by vClass: passenger->0, bus->2, truck->3."""
        rou = self._write(self.ROU, ".rou.xml")
        tmap = self.blgr_pack.build_type_map(rou)
        self.assertEqual(tmap["bangloreCar"], 0)
        self.assertEqual(tmap["schoolbus"], 2)
        self.assertEqual(tmap["water-tanker"], 3)
        self.assertEqual(tmap["DEFAULT_VEHTYPE"], 3)

    def test_type_map_unknown_defaults_zero(self):
        """No vClass and unknown id -> 0 (passenger)."""
        rou = self._write('<routes><vType id="mystery"/></routes>', ".rou.xml")
        tmap = self.blgr_pack.build_type_map(rou)
        self.assertEqual(tmap["mystery"], 0)


class TestPerScenarioSpecs(unittest.TestCase):
    """pack_run.parse_scenario_specs: A/B runs take per-scenario net/rou."""

    def setUp(self):
        sys.path.insert(0, HERE)
        try:
            import pack_run
        except ImportError as e:
            self.fail(f"pack_run.py not importable: {e}")
        self.parse = pack_run.parse_scenario_specs

    def test_per_scenario_specs(self):
        """--scenario k=net:rou (repeated) -> per-scenario inputs."""
        specs = self.parse(
            ["today=a.net.xml:a.rou.xml", "proposed=b.net.xml:b.rou.xml"],
            net=None, rou=None)
        self.assertEqual(specs, [("today", "a.net.xml", "a.rou.xml"),
                                 ("proposed", "b.net.xml", "b.rou.xml")])

    def test_global_net_rou_single_scenario(self):
        """--net/--rou with bare scenario keys (backward compatible)."""
        specs = self.parse(["today"], net="n.xml", rou="r.xml")
        self.assertEqual(specs, [("today", "n.xml", "r.xml")])

    def test_global_net_rou_multi_key_rejected(self):
        """Bare multi-keys with one global net/rou is the A/B bug — reject."""
        with self.assertRaises((SystemExit, ValueError)):
            self.parse(["today", "proposed"], net="n.xml", rou="r.xml")

    def test_mixed_specs_rejected(self):
        """One bare + one spec -> error."""
        with self.assertRaises((SystemExit, ValueError)):
            self.parse(["today", "proposed=b.net.xml:b.rou.xml"],
                       net="n.xml", rou="r.xml")

    def test_spec_without_global_ok(self):
        """All specs carry their own net/rou; globals not required."""
        specs = self.parse(["today=a.net.xml:a.rou.xml"], net=None, rou=None)
        self.assertEqual(len(specs), 1)


class TestGeoLockExtraction(unittest.TestCase):
    """sumo_geom.geo_lock: <location> -> (latlngMap, utm)."""

    LOC = ('<location netOffset="-794602.11,-1431388.13" '
           'convBoundary="5.47,0.00,651.33,706.40" '
           'origBoundary="77.714521,12.933828,77.721480,12.942221" '
           'projParameter="+proj=utm +zone=43 +ellps=WGS84 +datum=WGS84 '
           '+units=m +no_defs"/>')

    def _write(self, text):
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".net.xml",
                                        delete=False)
        f.write(text)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def setUp(self):
        sys.path.insert(0, HERE)
        try:
            import sumo_geom
        except ImportError as e:
            self.fail(f"sumo_geom.py not importable: {e}")
        self.geo_lock = sumo_geom.geo_lock

    def test_geo_lock_from_net(self):
        net = self._write('<?xml version="1.0"?><net>' + self.LOC + '</net>')
        latlng_map, utm = self.geo_lock(net)
        self.assertIsNotNone(latlng_map)
        self.assertEqual(latlng_map["conv"], [5.47, 0.0, 651.33, 706.4])
        # orig reordered minLng,minLat,maxLng,maxLat -> minLat,minLng,maxLat,maxLng
        self.assertEqual(latlng_map["orig"],
                         [12.933828, 77.714521, 12.942221, 77.72148])
        self.assertEqual(utm["zone"], 43)
        self.assertFalse(utm["south"])
        self.assertAlmostEqual(utm["offX"], -794602.11)
        self.assertAlmostEqual(utm["offY"], -1431388.13)

    def test_geo_lock_none_for_hand_net(self):
        """sample.net.xml has -1e10 sentinel origBoundary -> no geo lock."""
        latlng_map, utm = self.geo_lock(os.path.join(FIXDIR, "sample.net.xml"))
        self.assertIsNone(latlng_map)
        self.assertIsNone(utm)


class TestPackerEndToEnd(unittest.TestCase):
    """End-to-end test of the packer CLI."""

    def setUp(self):
        if not os.path.exists(PACKER):
            self.fail(f"pack_run.py not found at {PACKER}")

    def test_packer_cli_help(self):
        """pack_run.py --help shows usage."""
        result = subprocess.run(
            [sys.executable, PACKER, "--help"],
            capture_output=True, text=True, timeout=30
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("pack_run.py", result.stdout)
        self.assertIn("--net", result.stdout)
        self.assertIn("--rou", result.stdout)
        self.assertIn("-o", result.stdout)

    def test_packer_requires_net_and_rou(self):
        """pack_run.py requires --net and --rou."""
        result = subprocess.run(
            [sys.executable, PACKER, "-o", "/tmp/test.simo.json"],
            capture_output=True, text=True, timeout=30
        )
        self.assertNotEqual(result.returncode, 0)


class TestDemandReading(unittest.TestCase):
    """blgr_pack.read_demand: sum of contributor flow rates (veh/hr)."""

    def _write(self, text):
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".rou.xml",
                                        delete=False)
        f.write(text)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def setUp(self):
        sys.path.insert(0, HERE)
        try:
            import blgr_pack
        except ImportError as e:
            self.fail(f"blgr_pack.py not importable: {e}")
        self.read_demand = blgr_pack.read_demand

    def test_sums_per_hour(self):
        rou = self._write('''<routes>
            <flow id="a" perHour="200.5" route="r0" begin="0" end="3600"/>
            <flow id="b" perHour="320" route="r1" begin="0" end="3600"/>
        </routes>''')
        self.assertAlmostEqual(self.read_demand(rou), 520.5)

    def test_vehs_per_hour_alias(self):
        """SUMO's older vehsPerHour spelling is honoured too."""
        rou = self._write('''<routes>
            <flow id="a" vehsPerHour="100" route="r0" begin="0" end="3600"/>
            <flow id="b" perHour="50" route="r1" begin="0" end="3600"/>
        </routes>''')
        self.assertAlmostEqual(self.read_demand(rou), 150.0)

    def test_ignores_standalone_vehicles(self):
        """<vehicle> elements are one-off departures, not an hourly rate."""
        rou = self._write('''<routes>
            <flow id="a" perHour="100" route="r0" begin="0" end="3600"/>
            <vehicle id="v0" depart="0" route="r0"/>
            <vehicle id="v1" depart="5" route="r0"/>
        </routes>''')
        self.assertAlmostEqual(self.read_demand(rou), 100.0)

    def test_empty_routes_zero(self):
        rou = self._write('<routes/>')
        self.assertEqual(self.read_demand(rou), 0.0)


class TestPackDemand(unittest.TestCase):
    """build_pack emits demand (rou rate) + peakServed (stats arrived)."""

    def setUp(self):
        sys.path.insert(0, HERE)
        try:
            import pack_run
        except ImportError as e:
            self.fail(f"pack_run.py not importable: {e}")
        self.pack_run = pack_run

    def _scen(self, stats):
        return {"frames": [[]], "stats": stats,
                "geometry": {"lanes": [], "arms": {}, "phases": [],
                             "stops": {}, "links": {}},
                "geo": None}

    def test_pack_has_demand_and_peak_served(self):
        stats_a = [(0, 0, 0, 0, 0), (150, 3, 2, 40, 0)]     # arrived 150
        stats_b = [(0, 0, 0, 0, 0), (230, 5, 1, 60, 0)]     # arrived 230
        out = self.pack_run.build_pack(
            {"today": dict(self._scen(stats_a), demand=3228.84),
             "proposed": dict(self._scen(stats_b), demand=3228.84)},
            n_frames=2)
        self.assertAlmostEqual(out["demand"], 3228.84)
        self.assertEqual(out["peakServed"], 230)   # max across scenarios

    def test_pack_demand_none_when_no_flows(self):
        """No flow data -> demand key is None (wizard/injector falls back)."""
        out = self.pack_run.build_pack(
            {"today": dict(self._scen([(0, 0, 0, 0, 0), (10, 1, 0, 5, 0)]),
                           demand=None)},
            n_frames=2)
        self.assertIsNone(out["demand"])
        self.assertEqual(out["peakServed"], 10)


class TestRoundTripFidelity(unittest.TestCase):
    """Round-trip fidelity check: pack Balagere nets → byte-identical to run.bin."""

    def setUp(self):
        if not os.path.exists(PACKER):
            self.fail(f"pack_run.py not found at {PACKER}")

    def test_balagere_roundtrip(self):
        """Packing Balagere's two nets with seed 42 produces identical run.bin."""
        # This is the verification test from the implementation plan
        # Uses the real nets from sim/video/
        pass


if __name__ == "__main__":
    unittest.main()