#!/bin/bash
# Open both scenarios in SUMO's own GUI, side by side.
#
# Speed is controlled natively: the "Delay (ms)" box in each window's toolbar.
#   0    = as fast as the machine allows
#   80   = the default set in gui-settings.xml
#   500  = slow enough to follow one vehicle
# Press the green arrow to run, the pause button to freeze, and the single-step
# button to advance one second. Mouse wheel zooms; right-drag pans.
set -e
export SUMO_HOME="${SUMO_HOME:-/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo}"
GUI="$SUMO_HOME/bin/sumo-gui"
cd "$(dirname "$0")"

W=${W:-950}; H=${H:-740}; D=${D:-80}

"$GUI" -c current.sumocfg  --window-size $W,$H --window-pos 0,60   --delay $D &
sleep 2
"$GUI" -c proposed.sumocfg --window-size $W,$H --window-pos $W,60  --delay $D &
wait
