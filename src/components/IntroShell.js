/* IntroShell: the once-per-lifecycle intro gate + site reveal wrapper.
 *
 * Mount: hasSeenIntro(window.localStorage) decides the path.
 * - Repeat visit: no intro. The app renders inside .app-reveal, clipped
 *   to circle(0%) at the center; once the window load event fires
 *   (everything loaded), the clip blooms open — smooth load instead of a
 *   pop-in. The clip is dropped entirely after the bloom (map perf).
 * - First visit: the intro (the landing design on Paper tokens) covers
 *   the site while it loads behind. The CTA does NOT open a popup: it
 *   marks the lifecycle flag, the intro splits vertically down the
 *   middle (halves slide apart), and the site circle-reveals from the
 *   center through the widening gap.
 *
 * Split geometry: two 50%-wide halves each clip a full-viewport pane
 * (.intro-pane, width:200% of the half) — the panes tile the design
 * seamlessly, and sliding the halves apart drags each pane's copy of the
 * scene with it. */
import React from 'react';
import { hasSeenIntro, markIntroSeen } from '../lib/intro.js';
import {
  sceneScale, sceneX, sceneY, sceneLenX, sceneLenY,
} from '../lib/introScene.js';

const h = React.createElement;

const INTRO_SPLIT_MS = 900;
const INTRO_REVEAL_DELAY_MS = 350;
const INTRO_CIRCLE_MS = 1100;

/* Abstract street-network backdrop — the landing concept's canvas scene,
 * restyled to the Paper palette. Canvas paints cannot read CSS custom
 * properties, so these are literals (one-time intro; a future theme swap
 * may leave the backdrop stale — acceptable). */
const INTRO_ROADS = [
  { type: 'ring', cx: .50, cy: .50, rx: .36, ry: .38 },
  { type: 'ring', cx: .50, cy: .50, rx: .22, ry: .24 },
  { type: 'line', x1: .50, y1: .05, x2: .50, y2: .95 },
  { type: 'line', x1: .10, y1: .50, x2: .90, y2: .50 },
  { type: 'line', x1: .22, y1: .22, x2: .78, y2: .78 },
  { type: 'line', x1: .78, y1: .20, x2: .30, y2: .85 },
  { type: 'grid', x: .44, y: .42, size: .12, cols: 5, rows: 4 },
  { type: 'grid', x: .32, y: .30, size: .08, cols: 4, rows: 4 },
  { type: 'grid', x: .60, y: .56, size: .09, cols: 4, rows: 3 },
  { type: 'lake', cx: .58, cy: .42, r: .028 },
  { type: 'lake', cx: .74, cy: .62, r: .048 },
  { type: 'lake', cx: .70, cy: .74, r: .040 },
  { type: 'lake', cx: .46, cy: .76, r: .032 },
  { type: 'lake', cx: .35, cy: .65, r: .025 },
];

function IntroPane({ onEnter, onHover }) {
  const ref = React.useRef(null);

  React.useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    let w = 0;
    let hgt = 0;
    let mx = 0;
    let my = 0;
    let tx = 0;
    let ty = 0;
    let raf = 0;
    const resize = () => {
      w = canvas.width = window.innerWidth;
      hgt = canvas.height = window.innerHeight;
    };
    const onMove = (e) => { tx = e.clientX; ty = e.clientY; };
    const draw = () => {
      mx += (tx - mx) * 0.05;
      my += (ty - my) * 0.05;
      const ox = (mx - w / 2) * 0.015;
      const oy = (my - hgt / 2) * 0.015;
      ctx.clearRect(0, 0, w, hgt);
      ctx.save();
      ctx.translate(ox, oy);
      /* faint drafting-grid dots */
      ctx.fillStyle = 'rgba(74,55,40,.10)';
      for (let x = 0; x < w; x += 40) {
        for (let y = 0; y < hgt; y += 40) ctx.fillRect(x, y, 1, 1);
      }
      /* cover-fit the 16:9 design box: uniform scale, crop overflow — at
       * exactly 16:9 this reduces to the original fraction math */
      const s = sceneScale(w, hgt);
      INTRO_ROADS.forEach((it) => {
        if (it.type === 'ring') {
          ctx.beginPath();
          ctx.ellipse(sceneX(it.cx, w, s), sceneY(it.cy, hgt, s),
            sceneLenX(it.rx, s), sceneLenY(it.ry, s), 0, 0, 2 * Math.PI);
          ctx.strokeStyle = 'rgba(74,55,40,.16)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (it.type === 'line') {
          ctx.beginPath();
          ctx.moveTo(sceneX(it.x1, w, s), sceneY(it.y1, hgt, s));
          ctx.lineTo(sceneX(it.x2, w, s), sceneY(it.y2, hgt, s));
          ctx.strokeStyle = 'rgba(74,55,40,.18)';
          ctx.lineWidth = 1;
          ctx.stroke();
        } else if (it.type === 'grid') {
          const sx = sceneX(it.x, w, s);
          const sy = sceneY(it.y, hgt, s);
          const cw = sceneLenX(it.size, s) / it.cols;
          const ch = sceneLenY(it.size, s) / it.rows;
          ctx.strokeStyle = 'rgba(74,55,40,.12)';
          ctx.lineWidth = 0.75;
          for (let c = 0; c <= it.cols; c++) {
            ctx.beginPath();
            ctx.moveTo(sx + c * cw, sy);
            ctx.lineTo(sx + c * cw, sy + it.rows * ch);
            ctx.stroke();
          }
          for (let r = 0; r <= it.rows; r++) {
            ctx.beginPath();
            ctx.moveTo(sx, sy + r * ch);
            ctx.lineTo(sx + it.cols * cw, sy + r * ch);
            ctx.stroke();
          }
        } else {
          ctx.beginPath();
          ctx.arc(sceneX(it.cx, w, s), sceneY(it.cy, hgt, s), sceneLenX(it.r, s), 0, 2 * Math.PI);
          ctx.strokeStyle = 'rgba(194,80,46,.30)';
          ctx.fillStyle = 'rgba(194,80,46,.04)';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();
        }
      });
      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    resize();
    draw();
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  return h('div', { className: 'intro-pane' },
    h('canvas', { ref, className: 'intro-net' }),
    h('div', { className: 'intro-micro intro-micro-top' },
      h('span', null, ''),
      h('span', null, '')),
    h('div', { className: 'intro-copy' },
      h('div', { className: 'intro-brand' }, 'OpenBengaluru'),
      h('span', { className: 'intro-tag' }, 'Chapter 1: Traffic'),
      h('div', { className: 'intro-headline' }, 'What would you change?'),
      h('p', { className: 'intro-sub' },
        'Bengaluru is a living city. Explore it, change it, and see what happens.'),
      h('button', {
        className: 'intro-cta', onClick: onEnter,
        /* the pill straddles the split — hover/focus must light up BOTH
         * halves, so the state rides the intro root, not this instance */
        onMouseEnter: () => onHover(true), onMouseLeave: () => onHover(false),
        onFocus: () => onHover(true), onBlur: () => onHover(false),
      },
        h('span', null, 'Open Bengaluru'),
        h('span', { className: 'arr' },
          h('svg', {
            width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
            'aria-hidden': 'true',
          }, h('path', {
            d: 'M2.5 8h10.5M8.5 4.5 12 8l-3.5 3.5',
            stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'square',
          }))))),
    h('div', { className: 'intro-micro intro-micro-bottom' },
      ''),
  );
}

export function IntroShell({ children }) {
  const [seen] = React.useState(() => hasSeenIntro(window.localStorage));
  const [hover, setHover] = React.useState(false);
  const [out, setOut] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [settled, setSettled] = React.useState(false);
  const [gone, setGone] = React.useState(false);

  const startReveal = React.useCallback(() => {
    setOpen(true);
    setTimeout(() => setSettled(true), INTRO_CIRCLE_MS);
  }, []);

  /* Repeat visits: the site stays clipped while everything loads behind
   * it; the circle blooms open on the window load event (or immediately
   * via one frame when the app mounts after load). */
  React.useEffect(() => {
    if (!seen) return undefined;
    if (document.readyState === 'complete') {
      const id = requestAnimationFrame(() => startReveal());
      return () => cancelAnimationFrame(id);
    }
    window.addEventListener('load', startReveal, { once: true });
    return () => window.removeEventListener('load', startReveal);
  }, [seen, startReveal]);

  /* CTA: mark the lifecycle flag, split the intro, bloom the site. */
  const enterSandbox = React.useCallback(() => {
    markIntroSeen(window.localStorage);
    setOut(true);
    setTimeout(() => startReveal(), INTRO_REVEAL_DELAY_MS);
    setTimeout(() => setGone(true), INTRO_SPLIT_MS);
  }, [startReveal]);

  return h(React.Fragment, null,
    h('div', { className: 'app-reveal' + (open ? ' open' : '') + (settled ? ' settled' : '') }, children),
    !seen ? h('div', { className: 'intro-root' + (out ? ' intro-out' : '') + (hover ? ' intro-hover' : '') },
      gone ? null : [
        h('div', { className: 'intro-half intro-half-l', key: 'l' },
          h(IntroPane, { onEnter: enterSandbox, onHover: setHover })),
        h('div', { className: 'intro-half intro-half-r', key: 'r' },
          h(IntroPane, { onEnter: enterSandbox, onHover: setHover })),
      ]) : null);
}
