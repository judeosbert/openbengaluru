/* Area export helpers. Ported verbatim from the app.js pure head. */

/* ------------------------------------------------------ area export helpers
 * Contributors download the real OSM road network for a bbox, then run the
 * generated convert.sh (which auto-finds netconvert) to get a SUMO .net.xml.
 * bbox = [minLat, minLng, maxLat, maxLng]; both helpers are pure head so the
 * vm harness can test them. */
export function osmApiUrl(bbox) {
  const b = bbox.map((v) => +(+v).toFixed(6));
  return 'https://www.openstreetmap.org/api/0.6/map?bbox='
    + b[1] + ',' + b[0] + ',' + b[3] + ',' + b[2];   // minLng,minLat,maxLng,maxLat
}

/* Bash script the contributor runs: netconvert from EclipseSUMO / $SUMO_HOME /
 * PATH. Produces <name>.net.xml next to the downloaded .osm.xml. */
export function convertScript(bbox, name) {
  const nm = (name || 'area').replace(/[^a-z0-9-]+/g, '-');
  const B = bbox.map((v) => +(+v).toFixed(6));
  return '#!/bin/bash\n'
    + '# Export area [' + B.join(', ') + '] to a SUMO net. Run next to the\n'
    + '# downloaded ' + nm + '.osm.xml. netconvert auto-detects.\n'
    + '# netconvert keeps <location origBoundary> — the app uses it to auto-position.\n'
    + 'set -e\n'
    + 'NC=""\n'
    + 'for c in "$SUMO_HOME/bin/netconvert" \\\n'
    + '  "/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo/bin/netconvert" \\\n'
    + '  "$(command -v netconvert)"; do\n'
    + '  [ -x "$c" ] && NC="$c" && break\n'
    + 'done\n'
    + '[ -z "$NC" ] && { echo "netconvert not found — set SUMO_HOME"; exit 1; }\n'
    + 'OSM="' + nm + '.osm.xml"\n'
    + '[ -f "$OSM" ] || { echo "$OSM missing — download it from the app first"; exit 1; }\n'
    + '"$NC" --osm-files "$OSM" --output-file ' + nm + '.net.xml \\\n'
    + '  --geometry.remove --junctions.join --roundabouts.guess \\\n'
    + '  --tls.guess --tls.join --junctions.corner-detail 5\n'
    + '# carry the export zoom into the net (line 2) so the app can auto-snap\n'
    + 'ZOOM=$(grep -o \'simo:zoom=[0-9]*\' "$OSM" | head -1 | cut -d= -f2)\n'
    + 'if [ -n "$ZOOM" ]; then\n'
    + '  awk -v z="$ZOOM" \'NR==1{print; print "<!-- simo:zoom=" z " -->"; next}1\' '
    + nm + '.net.xml > ' + nm + '.net.xml.tmp && mv ' + nm + '.net.xml.tmp ' + nm + '.net.xml\n'
    + 'fi\n'
    + 'echo "wrote ' + nm + '.net.xml — upload it in the Submit wizard"\n';
}
