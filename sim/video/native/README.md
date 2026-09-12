# Watch it in SUMO itself

    ./watch.sh

Opens both scenarios in SUMO's own GUI, side by side — TODAY on the left,
PROPOSED on the right, same 5,743 trips and the same seed in both.

## Speed control (native)

Each window's toolbar has a **Delay (ms)** box. That is the animation speed:

| Delay | Effect |
|-------|--------|
| `0`   | as fast as the machine allows |
| `80`  | default here |
| `500` | slow enough to follow a single vehicle |

Other native controls: green arrow runs, pause freezes, the step button
advances one second, the mouse wheel zooms, right-drag pans. Right-click any
vehicle to track or inspect it.

## Useful view settings

In each window: **View → Vehicles → Color by → speed** shows the same
red/amber/green reading as the rendered video. **View → Show → Junction
shape** and turning arrows help to see the give-way conflicts on the left.

## Overrides

    W=1200 H=900 D=200 ./watch.sh      # window size and starting delay
