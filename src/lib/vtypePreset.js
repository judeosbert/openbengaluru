/* Indian road-behavior vTypes (plan: indian-driving-vtypes) — the pure
 * single source of truth for the mandated aggressive-driving block:
 *
 *   - injectAggressiveDriving(xml): EVERY .rou.xml our SUMO commands run
 *     carries the vType family. The car block is mandated verbatim; the
 *     20 behavior attrs are forced onto every existing <vType> (vClass /
 *     maxSpeed / length survive, so buses stay buses and the player's
 *     render classes survive); <vType id="DEFAULT_VEHTYPE"> covers
 *     typeless vehicles and must precede any vehicle reference, so the
 *     whole set is emitted right after the <routes ...> open tag.
 *     <vTypeDistribution> children are patched in place (never hoisted —
 *     the distribution semantics must survive). Idempotent.
 *   - buildPresetRoutesXml(): the contributor preset file — checked in
 *     byte-identical at presets/indian-roads.rou.xml and bundled as the
 *     third entry of the /api/export-net zip.
 *
 * Pure string -> string, no fs, no DOM globals (test/lib-purity.test.js).
 * Regex-based XML editing is deliberate: comment-stripped tag heads,
 * idempotency locks, and the real-SUMO smoke test are the guardrails. */

/* The 20 behavior attrs (the user's car block minus vClass, plus the
 * junction model), in emission order. Forced onto every vType; ours win
 * over any pre-existing value.
 *
 * tau must stay >= the pipeline step-length (pack_run runs SUMO with
 * --step-length 1): a sub-step tau turns every conflict into a collision
 * teleport, which drains jams and erases junction choke.
 *
 * The jm* attrs + impatience are the junction model: jmIgnoreFoeProb=1.0
 * pushes vehicles into a busy junction instead of politely waiting at the
 * stop line (jmTimegapMinor 5.0 -> 0.5 accepts tiny gaps on minor links,
 * impatience=1.0 drops courtesy). The junction still chokes — jam
 * teleports keep occurring — but nobody deadlocks waiting for cross
 * traffic to clear. */
export const BEHAVIOR_ATTRS = [
  ['carFollowModel', 'Krauss'],
  ['accel', '4.5'],
  ['decel', '6.0'],
  ['emergencyDecel', '9.0'],
  ['tau', '1.0'],
  ['sigma', '0.9'],
  ['laneChangeModel', 'LC2013'],
  ['lcSublane', '1.0'],
  ['latAlignment', 'arbitrary'],
  ['minGapLat', '0.2'],
  ['maxSpeedLat', '2.5'],
  ['lcStrategic', '0.5'],
  ['lcCooperative', '0.0'],
  ['lcSpeedGain', '9.0'],
  ['lcKeepRight', '0.0'],
  ['lcAssertive', '2.5'],
  ['lcPushy', '1.0'],
  ['jmIgnoreFoeProb', '1.0'],
  ['jmTimegapMinor', '0.5'],
  ['impatience', '1.0'],
];

/* The mandated car block: vClass first (snippet order), then the 20. */
export const CAR_VTYPE_ATTRS = [
  ['vClass', 'passenger'],
  ...BEHAVIOR_ATTRS,
];

export const PRESET_FILE_NAME = 'vtypes.rou.xml';

/* Preset family beyond the car: ids match the player render classes
 * (TYPES in tools/blgr_pack.js); auto rides vClass="taxi" so
 * VCLASS_TO_IDX maps it to the auto-rickshaw class. Physical params are
 * left to SUMO's vClass defaults. */
const PRESET_FAMILY = [
  ['motorcycle', 'motorcycle'],
  ['bus', 'bus'],
  ['truck', 'truck'],
  ['auto', 'taxi'],
];

const BEHAVIOR_KEYS = new Set(BEHAVIOR_ATTRS.map(([k]) => k));

/* Scan the tag that starts at s[start] === '<': XML comments may sit
 * between attributes (the contributor snippet does exactly that), so the
 * head is accumulated with comment spans removed. Returns the stripped
 * head (text between '<' and the closing '>', comments gone) plus the
 * index just after '>'. null when unterminated. */
function scanTag(s, start) {
  let i = start + 1;
  let head = '<';
  while (i < s.length) {
    if (s.startsWith('<!--', i)) {
      const close = s.indexOf('-->', i + 4);
      if (close === -1) return null;
      i = close + 3;
      continue;
    }
    const ch = s[i];
    if (ch === '>') return { head, end: i + 1 };
    if (ch === '"' || ch === "'") {
      const q = s.indexOf(ch, i + 1);
      if (q === -1) return null;
      head += s.slice(i, q + 1);
      i = q + 1;
      continue;
    }
    head += ch;
    i += 1;
  }
  return null;
}

/* Attr pairs of a stripped tag head, order preserved:
 * '<vType id="x" a="b"/' -> [['id', 'x'], ['a', 'b']]. */
function parseAttrs(head) {
  const body = head.replace(/^<[^\s/>]*\s*/, '').replace(/\/\s*$/, '');
  const out = [];
  const re = /([:A-Za-z_][-\w.:]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(body))) out.push([m[1], m[2]]);
  return out;
}

/* Merged attr list for one vType: id first, then the kept original attrs
 * (relative order preserved; behavior keys dropped — ours win), then the
 * 17 behavior attrs in BEHAVIOR_ATTRS order. id="car" always carries
 * vClass="passenger" (the mandated block is verbatim). */
function mergedAttrs(id, rawAttrs) {
  const kept = [];
  for (const [k, v] of rawAttrs) {
    if (k === 'id' || BEHAVIOR_KEYS.has(k)) continue;
    if (id === 'car' && k === 'vClass') continue;   // forced below
    kept.push([k, v]);
  }
  const pre = id === 'car'
    ? [['id', id], ['vClass', 'passenger'], ...kept]
    : [['id', id], ...kept];
  return [...pre, ...BEHAVIOR_ATTRS];
}

/* Open-tag head for one merged vType: paired -> '>', else '/>'. */
function formatHead(id, rawAttrs, paired) {
  const attrs = mergedAttrs(id, rawAttrs || []);
  return '<vType ' + attrs.map(([k, v]) => k + '="' + v + '"').join(' ')
    + (paired ? '>' : '/>');
}

/* Emitted line for the top-level block: 4-space indent, one per line.
 * Paired vTypes keep their children verbatim. */
function formatVType(id, rawAttrs, inner) {
  const head = '    ' + formatHead(id, rawAttrs, inner != null);
  return inner == null ? head : head + inner + '</vType>';
}

/* Extend [start, end) to swallow the element's line: the leading indent
 * when the line opens with the element, plus the line terminator — LF,
 * CRLF or lone CR (netedit on Windows writes CRLF; leaving the \r behind
 * would break idempotency with stray blank lines). Removals leave no
 * empty lines behind, which is what keeps f(f(x)) byte-stable. */
function swallowLine(s, start, end) {
  const nl = s.lastIndexOf('\n', start - 1) + 1;
  if (/^[ \t]*$/.test(s.slice(nl, start))) start = nl;
  const term = /[ \t]*(?:\r\n|[\n\r])/gy;
  term.lastIndex = end;
  const m = term.exec(s);
  if (m) end = m.index + m[0].length;
  return [start, end];
}

/* Patch every .rou.xml with the mandated aggressive-driving vTypes.
 * Total: no <routes> open tag -> input returned unchanged (SUMO rejects
 * invalid files with its own error; the injector stays a no-op). */
export function injectAggressiveDriving(xml) {
  /* comment ranges — nothing inside them is ever patched */
  const commentRanges = [];
  const CRE = /<!--[\s\S]*?-->/g;
  let cm;
  while ((cm = CRE.exec(xml))) {
    commentRanges.push([cm.index, cm.index + cm[0].length]);
  }
  const inComment = (i) =>
    commentRanges.some(([a, b]) => i >= a && i < b);

  const ROUTES_RE = /<routes\b[^>]*>/g;
  let routes = null;
  let rm;
  while ((rm = ROUTES_RE.exec(xml))) {
    if (!inComment(rm.index)) { routes = rm; break; }
  }
  if (!routes) return xml;
  const routesEnd = routes.index + routes[0].length;

  /* <vTypeDistribution> bodies: children are patched IN PLACE, never
   * hoisted (the distribution semantics must survive). */
  const distRanges = [];
  const DRE = /<vTypeDistribution\b[^>]*>/g;
  let dm;
  while ((dm = DRE.exec(xml))) {
    if (inComment(dm.index) || /\/>$/.test(dm[0])) continue;
    const close = xml.indexOf('</vTypeDistribution>',
      dm.index + dm[0].length);
    if (close === -1) continue;
    distRanges.push([dm.index + dm[0].length, close]);
  }
  const inDist = (i) => distRanges.some(([a, b]) => i > a && i < b);

  /* Every <vType> element (\b excludes <vTypeDistribution>): paired form
   * keeps children (only ever <param/>); id-less tags stay untouched. */
  const elements = [];
  const VT_RE = /<vType\b/g;
  let vm;
  while ((vm = VT_RE.exec(xml))) {
    if (inComment(vm.index)) continue;
    const scanned = scanTag(xml, vm.index);
    if (!scanned) continue;
    const attrs = parseAttrs(scanned.head);
    const idAttr = attrs.find(([k]) => k === 'id');
    if (!idAttr || !idAttr[1]) continue;
    const selfClose = /\/\s*$/.test(scanned.head);
    let end = scanned.end;
    let inner = null;
    if (!selfClose) {
      const closeIdx = xml.indexOf('</vType>', scanned.end);
      if (closeIdx !== -1) {
        inner = xml.slice(scanned.end, closeIdx);
        end = closeIdx + '</vType>'.length;
      }
    }
    elements.push({
      start: vm.index, headEnd: scanned.end, end, inner, attrs,
      id: idAttr[1], dist: inDist(vm.index),
    });
  }

  const edits = [];

  /* in-distribution children: patch the head in place, keep children */
  for (const el of elements) {
    if (!el.dist) continue;
    edits.push({ start: el.start, end: el.headEnd,
      text: formatHead(el.id, el.attrs, el.inner != null) });
  }

  /* top-level vTypes: removed here, re-emitted after the <routes> open
   * tag — DEFAULT_VEHTYPE first, car second, the rest in source order */
  const topLevel = elements.filter((el) => !el.dist);
  for (const el of topLevel) {
    const [rs, re] = swallowLine(xml, el.start, el.end);
    edits.push({ start: rs, end: re, text: '' });
  }

  const byId = new Map(topLevel.map((el) => [el.id, el]));
  const lines = [formatVType('DEFAULT_VEHTYPE',
    byId.get('DEFAULT_VEHTYPE') && byId.get('DEFAULT_VEHTYPE').attrs,
    byId.get('DEFAULT_VEHTYPE') && byId.get('DEFAULT_VEHTYPE').inner)];
  lines.push(formatVType('car',
    byId.get('car') && byId.get('car').attrs,
    byId.get('car') && byId.get('car').inner));
  for (const el of topLevel) {
    if (el.id === 'DEFAULT_VEHTYPE' || el.id === 'car') continue;
    lines.push(formatVType(el.id, el.attrs, el.inner));
  }
  /* the re-emitted block uses the file's own line endings — a CRLF demand
   * stays pure CRLF, which keeps the block byte-stable across re-passes */
  const eol = xml.includes('\r\n') ? '\r\n' : '\n';
  edits.push({ start: routesEnd, end: routesEnd,
    text: eol + lines.join(eol) });

  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) continue;
    out += xml.slice(pos, e.start) + e.text;
    pos = Math.max(pos, e.end);
  }
  out += xml.slice(pos);
  return out;
}

/* The contributor preset file. Built with the SAME emit format as
 * injectAggressiveDriving, so injection is an identity over it and the
 * checked-in presets/indian-roads.rou.xml is byte-identical (parity
 * test-locked). */
export function buildPresetRoutesXml() {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Indian road-behavior vTypes: paste-ready aggressive-driving demand.',
    '     Paste the <vType> lines at the top of your demand .rou.xml, or pass',
    '     this file as the FIRST -r file: sumo -n net -r vtypes.rou.xml,demand.rou.xml -->',
    '<routes>',
  ];
  lines.push(formatVType('DEFAULT_VEHTYPE', []));
  lines.push(formatVType('car', [['vClass', 'passenger']]));
  for (const [id, vClass] of PRESET_FAMILY) {
    lines.push(formatVType(id, [['vClass', vClass]]));
  }
  lines.push('</routes>');
  return lines.join('\n') + '\n';
}
