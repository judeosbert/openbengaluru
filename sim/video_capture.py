#!/usr/bin/env python3
"""Run both scenarios headless and record per-vehicle positions each second.

sumo-gui screenshots proved unreliable here (an occluded window reads back black
on macOS, and the TraCI handshake is flaky), so nothing is rendered by SUMO. We
take floating-car data -- every vehicle's position, angle and speed per second --
and draw the frames ourselves. Deterministic, headless, and stylable.
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SUMO_HOME = "/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo"
SUMO = os.path.join(SUMO_HOME, "bin", "sumo")
OUT = os.path.join(HERE, "video")
END = 900          # seconds of simulation to record

SCEN = {
    "current": dict(
        net=os.path.join(HERE, "..", "networks", "BELAGERE.net.xml"),
        rou=os.path.join(HERE, "demand-peak-baseline.rou.xml"),
        title="TODAY",
        sub="no signal · two give-way U-turns"),
    "proposed": dict(
        net=os.path.join(HERE, "nets", "R2-paint180.net.xml"),
        rou=os.path.join(HERE, "demand-peak-nouturn.rou.xml"),
        title="PROPOSED",
        sub="U-turns banned · signalised · two 3.0 m lanes"),
}


def run(tag, s):
    fcd = os.path.join(OUT, f"{tag}-fcd.xml")
    summ = os.path.join(OUT, f"{tag}-sum.xml")
    cmd = [SUMO, "-n", s["net"], "-r", s["rou"],
           "--fcd-output", fcd, "--fcd-output.geo", "false",
           "--summary-output", summ,
           "--seed", "42", "--step-length", "1",
           "--time-to-teleport", "300", "--max-depart-delay", "1800",
           "-e", str(END), "--no-step-log", "--no-warnings"]
    p = subprocess.run(cmd, capture_output=True, text=True,
                       env=dict(os.environ, SUMO_HOME=SUMO_HOME))
    if p.returncode != 0:
        print(f"  {tag} FAILED:\n{(p.stderr or p.stdout)[-800:]}")
        return False
    print(f"  {tag}: fcd {os.path.getsize(fcd)/1e6:.1f} MB, "
          f"summary {os.path.getsize(summ)/1e3:.0f} KB")
    return True


if __name__ == "__main__":
    ok = all(run(t, s) for t, s in SCEN.items())
    sys.exit(0 if ok else 1)
