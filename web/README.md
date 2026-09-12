# Balagere T Junction — traffic study

A staggered pair of T junctions in East Bangalore that passes about 6% of its
rush-hour traffic. This is the study of what can be done about it without
building anything, and the data behind it.

- `index.html` — the case study
- `data.html` — index of every file, with descriptions
- `networks/` — SUMO networks: as-is, plus the variants built for the study
- `demand/` — trip files (identical journeys, per-network edge names)
- `results/` — raw measurements; every figure is generated from these
- `scripts/` — Python that regenerates all of it

## Running locally

    node server.js        # http://localhost:3000

No dependencies.

## Rerunning the simulations

Needs Eclipse SUMO 1.27.1 and Python 3:

    export SUMO_HOME=/path/to/sumo
    python3 gen_demand.py
    python3 build_nets.py
    python3 run_batch.py
    python3 measure_current.py
    python3 build_casestudy.py

## A note on the data

The turning-movement counts are **estimates**, calibrated from IRC:106
benchmarks and Bangalore modal-split studies rather than surveyed at this
junction. They are sound for comparing options against each other — which is
what the study does — and are not a substitute for a traffic survey.
