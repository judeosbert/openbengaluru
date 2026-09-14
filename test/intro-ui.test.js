/* Intro gate → split reveal → circle reveal: the UI wiring contract, pinned
 * as text (the vitest env is node, no jsdom — same style as
 * test/signin-gate.test.js pins the sign-in gate and test/theme.test.js
 * evaluates EXTRA_CSS).
 *
 * Behavior contract (user request):
 *   1. First visit: the intro (the landing design, restyled to the app's
 *      Paper tokens) covers the site while everything loads behind it.
 *      Its CTA ("Open Bengaluru") does NOT open a popup — it marks the
 *      lifecycle flag, the intro splits vertically down the middle (left
 *      half slides left, right half slides right), and the site is
 *      revealed by a circle expanding from the center through the
 *      widening gap.
 *   2. Repeat visits: intro skipped entirely; the site stays clipped at
 *      circle(0%) until the window load event fires, then blooms open
 *      from the center — smooth load instead of a pop-in.
 *
 * Phase 1: every pin below fails against the current tree — IntroShell.js
 * does not exist and main.js still mounts <App/> bare. Phase 2 implements
 * to these exact idioms; do not re-litigate them.
 *
 * Theme-contract notes (test/theme.test.js owns EXTRA_CSS parsing):
 *   - intro CSS uses NEW selector tails (.intro-*, .app-reveal) so the
 *     last-rule-per-tail pins for .mark/.viewtoggle/.userbox/.sheet/...
 *     keep reading their base rules;
 *   - NEVER add a bare `button{...}` rule (the bare-button last rule must
 *     keep var(--body)+var(--r-sm)) — the CTA is class-styled (.intro-cta);
 *   - no rgba(0,0,0 / #E50914 literals — tokens only (theme.test.js scans
 *     all of EXTRA_CSS).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

/* EXTRA_CSS is a single-quoted JS string-concat expression in main.js —
 * evaluate it as-is (same extraction as test/theme.test.js). */
const MAIN = read('src', 'main.js');
const EXTRA = (() => {
  const start = MAIN.indexOf("const EXTRA_CSS = ''");
  expect(start, 'main.js must define EXTRA_CSS as a string concat')
    .toBeGreaterThanOrEqual(0);
  const end = MAIN.indexOf('const __simoStyle', start);
  expect(end, 'EXTRA_CSS expression must be terminated before use').toBeGreaterThan(0);
  const expr = MAIN.slice(MAIN.indexOf('=', start) + 1, MAIN.lastIndexOf(';', end));
  return new Function('return (' + expr + ');')();
})();

/* body of the LAST declaration block whose selector ends with the given
 * selector fragment (cascade winner) — same helper as test/theme.test.js. */
function lastRule(css, selSrc) {
  const re = new RegExp('(?:^|[\\n}])[^{}]*?' + selSrc + '\\s*\\{([^}]*)\\}', 'g');
  let m, last = null;
  while ((m = re.exec(css)) !== null) last = m[1];
  return last;
}

function expectRule(css, selSrc, label) {
  const r = lastRule(css, selSrc);
  expect(r, `${label}: no rule for ${selSrc} found`).not.toBeNull();
  return r;
}

/* exact selector match (no ancestors) — needed when a descendant/hover
 * rule shares the tail and would win lastRule */
function exactRule(css, selSrc) {
  const re = new RegExp('(?:^|[\\n}])' + selSrc + '\\s*\\{([^}]*)\\}');
  const m = re.exec(css);
  return m ? m[1] : null;
}

describe('IntroShell component (src/components/IntroShell.js)', () => {
  it('imports the pure intro head and wires the real storage seam', () => {
    const s = read('src', 'components', 'IntroShell.js');
    expect(s, 'IntroShell must import the pure storage seam')
      .toMatch(/import \{ hasSeenIntro, markIntroSeen \} from '\.\.\/lib\/intro\.js'/);
    /* the only place the browser global is touched: the lazy mount check */
    expect(s, 'seen decision must read the real localStorage via the seam')
      .toMatch(/useState\(\(\) => hasSeenIntro\(window\.localStorage\)\)/);
    expect(s, 'the CTA must mark the lifecycle flag through the seam')
      .toMatch(/markIntroSeen\(window\.localStorage\)/);
  });

  it('timing constants pace the split and the circle reveal', () => {
    const s = read('src', 'components', 'IntroShell.js');
    expect(s, 'split duration constant').toMatch(/const INTRO_SPLIT_MS = \d+/);
    expect(s, 'circle-start delay constant')
      .toMatch(/const INTRO_REVEAL_DELAY_MS = \d+/);
    expect(s, 'circle duration constant').toMatch(/const INTRO_CIRCLE_MS = \d+/);
  });

  it('the CTA splits the intro and reveals the site — no popup', () => {
    const s = read('src', 'components', 'IntroShell.js');
    const start = s.indexOf('const enterSandbox');
    expect(start, 'enterSandbox handler not found').toBeGreaterThanOrEqual(0);
    const enter = s.slice(start);
    expect(enter, 'CTA must mark the intro seen (once per lifecycle)')
      .toMatch(/markIntroSeen\(window\.localStorage\)/);
    expect(enter, 'CTA must start the split (halves slide apart)')
      .toMatch(/setOut\(true\)/);
    expect(enter,
      'the circle reveal must be delayed so the center gap opens first')
      .toMatch(/setTimeout\(\(\) => startReveal\(\), INTRO_REVEAL_DELAY_MS\)/);
    expect(enter, 'the intro overlay must unmount after the split finishes')
      .toMatch(/setTimeout\(\(\) => setGone\(true\), INTRO_SPLIT_MS\)/);
    /* the landing concept's modal is gone — the CTA reveals the site */
    expect(s, 'no popup: the explore modal must not exist in the intro')
      .not.toMatch(/openPromptModal/);
  });

  it('repeat visits: reveal waits for the window load, then blooms open', () => {
    const s = read('src', 'components', 'IntroShell.js');
    expect(s, 'reveal must wait for full load (readyState complete fast-path)')
      .toMatch(/document\.readyState === 'complete'/);
    expect(s, 'reveal must start on the window load event')
      .toMatch(/addEventListener\('load', startReveal/);
    const reveal = s.slice(s.indexOf('const startReveal'));
    expect(reveal, 'startReveal must open the circle')
      .toMatch(/setOpen\(true\)/);
    expect(reveal, 'startReveal must drop the clip after the circle finishes')
      .toMatch(/setTimeout\(\(\) => setSettled\(true\), INTRO_CIRCLE_MS\)/);
  });

  it('renders the site inside .app-reveal and the intro as two halves', () => {
    const s = read('src', 'components', 'IntroShell.js');
    expect(s, 'the site wrapper must carry the clip states')
      .toMatch(/className: 'app-reveal' \+ \(open \? ' open' : ''\) \+ \(settled \? ' settled' : ''\)/);
    expect(s, 'intro skipped for repeat visitors')
      .toMatch(/!seen \? h\('div', \{ className: 'intro-root'/);
    expect(s, 'left half').toMatch(/className: 'intro-half intro-half-l'/);
    expect(s, 'right half').toMatch(/className: 'intro-half intro-half-r'/);
    /* one pane component rendered once per half — together the two
     * full-viewport panes tile the design seamlessly */
    expect((s.match(/h\(IntroPane/g) || []).length,
      'one pane per half').toBeGreaterThanOrEqual(2);
  });

  it('intro content: landing headline + chapter tag + CTA label', () => {
    const s = read('src', 'components', 'IntroShell.js');
    expect(s, 'headline').toMatch(/What would you change\?/);
    expect(s, 'chapter tag').toMatch(/Chapter 1: Traffic/);
    expect(s, 'CTA label').toMatch(/Open Bengaluru/);
    expect(s, 'CTA class').toMatch(/className: 'intro-cta'/);
  });

  it('both CTA halves hover as one — shared hover class on the root', () => {
    const s = read('src', 'components', 'IntroShell.js');
    expect(s, 'shared hover state lives in IntroShell')
      .toMatch(/const \[hover, setHover\] = React\.useState\(false\)/);
    expect(s, 'the shared hover class must ride the intro root')
      .toMatch(/className: 'intro-root' \+ \(out \? ' intro-out' : ''\) \+ \(hover \? ' intro-hover' : ''\)/);
    expect((s.match(/onHover: setHover/g) || []).length,
      'both panes must feed the shared hover state').toBeGreaterThanOrEqual(2);
    const cta = s.slice(s.indexOf("className: 'intro-cta'"));
    expect(cta, 'pointer enter must raise the shared hover')
      .toMatch(/onMouseEnter: \(\) => onHover\(true\)/);
    expect(cta, 'pointer leave must lower the shared hover')
      .toMatch(/onMouseLeave: \(\) => onHover\(false\)/);
  });

  it('intro carries the OpenBengaluru wordmark header', () => {
    const s = read('src', 'components', 'IntroShell.js');
    expect(s, 'the wordmark').toMatch(/'OpenBengaluru'/);
    expect(s, 'wordmark element').toMatch(/className: 'intro-brand'/);
  });

  it('canvas street-network backdrop cleans up after itself', () => {
    const s = read('src', 'components', 'IntroShell.js');
    expect(s, 'canvas backdrop must be drawn').toMatch(/getContext\('2d'\)/);
    expect(s, 'backdrop animation loop').toMatch(/requestAnimationFrame\(/);
    expect(s, 'animation loop must cancel on unmount')
      .toMatch(/cancelAnimationFrame\(/);
  });
});

describe('main.js mounts IntroShell around App', () => {
  it('IntroShell wraps App at the createRoot render', () => {
    expect(MAIN, 'main.js must import IntroShell')
      .toMatch(/import \{ IntroShell \} from '\.\/components\/IntroShell\.js'/);
    expect(MAIN, 'App must render inside IntroShell (site wrapper + intro sibling)')
      .toMatch(/ReactDOM\.createRoot\(document\.getElementById\('root'\)\)\.render\(React\.createElement\(IntroShell, null, React\.createElement\(App\)\)\)/);
  });
});

describe('EXTRA_CSS: circle reveal + split styles', () => {
  it('.app-reveal: site clipped at center until revealed, layout preserved', () => {
    const base = expectRule(EXTRA, '\\.app-reveal', '.app-reveal');
    expect(base, 'site starts hidden: clipped to nothing at the center')
      .toMatch(/clip-path:circle\(0% at 50% 50%\)/);
    expect(base, 'reveal must be a smooth clip transition')
      .toMatch(/transition:[^;]*clip-path[^;]*cubic-bezier/);
    /* #root is a column flex holding TopBar + .map-wrap; the wrapper must
     * replicate that box or the app layout collapses */
    expect(base, 'wrapper must preserve the column flex layout')
      .toMatch(/display:flex;flex-direction:column/);
    expect(base, 'wrapper must fill #root').toMatch(/height:100%/);
    const open = expectRule(EXTRA, '\\.app-reveal\\.open', '.app-reveal.open');
    expect(open, 'open state: circle covers the viewport')
      .toMatch(/clip-path:circle\(120% at 50% 50%\)/);
    const settled = expectRule(EXTRA, '\\.app-reveal\\.settled', '.app-reveal.settled');
    expect(settled, 'settled state: clip removed entirely (map perf)')
      .toMatch(/clip-path:none/);
  });

  it('.intro-root overlays everything while the intro shows', () => {
    const root = expectRule(EXTRA, '\\.intro-root', '.intro-root');
    expect(root, 'fixed full-viewport overlay').toMatch(/position:fixed/);
    expect(root).toMatch(/inset:0/);
    /* above the map loader (1200) and every dash/modal veil */
    expect(root, 'must stack above the loader').toMatch(/z-index:2000/);
  });

  it('.intro-half + .intro-pane: seamless split geometry', () => {
    const half = expectRule(EXTRA, '\\.intro-half', '.intro-half');
    expect(half).toMatch(/width:50%/);
    expect(half, 'halves clip their full-viewport panes').toMatch(/overflow:hidden/);
    expect(half, 'the slide must animate').toMatch(/transition:[^;]*transform[^;]*cubic-bezier/);
    const pane = expectRule(EXTRA, '\\.intro-pane', '.intro-pane');
    expect(pane).toMatch(/position:absolute/);
    expect(pane, 'pane = 200% of its half = one full viewport width')
      .toMatch(/width:200%/);
    expect(expectRule(EXTRA, '\\.intro-half-l \\.intro-pane', 'left pane offset'))
      .toMatch(/left:0/);
    expect(expectRule(EXTRA, '\\.intro-half-r \\.intro-pane', 'right pane offset'))
      .toMatch(/left:-100%/);
  });

  it('.intro-out: the halves slide apart along the vertical split', () => {
    expect(expectRule(EXTRA, '\\.intro-out \\.intro-half-l', 'left half exit'))
      .toMatch(/transform:translateX\(-101%\)/);
    expect(expectRule(EXTRA, '\\.intro-out \\.intro-half-r', 'right half exit'))
      .toMatch(/transform:translateX\(101%\)/);
  });

  it('intro chrome uses the Paper tokens (theme-swappable, no literals)', () => {
    /* exact-selector lookup: the shared-hover rule ends with .intro-cta
     * too, so the cascade-tail helper would read the hover rule here */
    const cta = exactRule(EXTRA, '\\.intro-cta');
    expect(cta, 'CTA pill uses the accent token')
      .toMatch(/background:var\(--accent\)/);
    expect(cta).toMatch(/color:var\(--on-accent\)/);
    expect(cta, 'CTA is a pill').toMatch(/border-radius:999px/);
    expect(expectRule(EXTRA, '\\.intro-headline', '.intro-headline'))
      .toMatch(/font-family:var\(--serif\)/);
    expect(expectRule(EXTRA, '\\.intro-tag', '.intro-tag'))
      .toMatch(/var\(--accent\)/);
  });

  it('shared hover: one class drives both halves of the split CTA', () => {
    const hover = expectRule(EXTRA, '\\.intro-root\\.intro-hover \\.intro-cta(?![\\w-])',
      '.intro-root.intro-hover .intro-cta');
    expect(hover, 'hovered pill darkens via token')
      .toMatch(/background:var\(--accent-ink\)/);
    expect(hover, 'hovered pill lifts').toMatch(/transform:translateY\(-2px\)/);
    expect(expectRule(EXTRA, '\\.intro-root\\.intro-hover \\.intro-cta \\.arr',
      'hovered arrow slide')).toMatch(/transform:translateX\(5px\)/);
    /* the hovered ELEMENT is never the styling subject: a native
     * .intro-cta:hover rule would light only the half under the pointer
     * (:has() contains the literal, so pin the subject tail, not the text) */
    expect(EXTRA, 'no per-half native hover rule may remain')
      .not.toMatch(/\.intro-cta:hover\s*\{/);
  });

  it(':has() paints both CTA copies in one style recalc (hover + focus)', () => {
    /* the two half-pills are separate elements; the rule must anchor on the
     * SHARED root (:has) so either copy's state styles BOTH copies — same
     * frame, no JS round-trip that can desync the halves */
    const exact = (sel, label) => {
      const r = exactRule(EXTRA, sel);
      expect(r, label).not.toBeNull();
      return r;
    };
    const hover = exact(
      '\\.intro-root:has\\(\\.intro-cta:hover\\) \\.intro-cta(?![\\w-])',
      'no :has() hover rule for the shared root');
    expect(hover, 'either copy hovered → both copies darken via token')
      .toMatch(/background:var\(--accent-ink\)/);
    expect(hover, 'either copy hovered → both copies lift')
      .toMatch(/transform:translateY\(-2px\)/);
    expect(exact(
      '\\.intro-root:has\\(\\.intro-cta:hover\\) \\.intro-cta \\.arr',
      'no :has() arrow rule'),
      'arrow slides when either copy is hovered')
      .toMatch(/transform:translateX\(5px\)/);
    const focus = exact(
      '\\.intro-root:has\\(\\.intro-cta:focus\\) \\.intro-cta(?![\\w-])',
      'no :has() focus rule');
    expect(focus, 'keyboard focus lights both copies too')
      .toMatch(/background:var\(--accent-ink\)/);
    expect(exact(
      '\\.intro-root:has\\(\\.intro-cta:focus\\) \\.intro-cta \\.arr',
      'no :has() focus arrow rule'),
      'arrow slides on keyboard focus')
      .toMatch(/transform:translateX\(5px\)/);
  });

  it('intro wordmark renders in the display serif', () => {
    expect(expectRule(EXTRA, '\\.intro-brand', '.intro-brand'))
      .toMatch(/font-family:var\(--serif\)/);
  });

  it('reduced motion: the reveal collapses to instant state changes', () => {
    expect(EXTRA, 'reduced-motion media block must exist')
      .toMatch(/prefers-reduced-motion:reduce/);
    expect(EXTRA, 'transitions must be disabled under reduced motion')
      .toMatch(/transition:none/);
  });
});
