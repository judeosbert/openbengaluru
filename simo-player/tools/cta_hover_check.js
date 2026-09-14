/* Headless ground-truth check: hover each half of the split intro CTA and
 * read both copies' computed background. Usage: node tools/cta_hover_check.js [url] */
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://localhost:5199/';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--user-data-dir=/var/folders/vz/99s7gdkj03q1qjzmdzq0yj7c0000gp/T/kilo/cta-check-profile'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.intro-cta', { timeout: 10000 });

  const info = await page.evaluate(() => {
    return [...document.querySelectorAll('.intro-cta')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        half: el.closest('.intro-half').className,
        box: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        visibility: getComputedStyle(el).visibility,
        pointerEvents: getComputedStyle(el).pointerEvents,
      };
    });
  });
  console.log('copies:', JSON.stringify(info, null, 2));

  const read = () => page.evaluate(() =>
    [...document.querySelectorAll('.intro-cta')].map((el) => ({
      half: el.closest('.intro-half').className,
      bg: getComputedStyle(el).backgroundColor,
      transform: getComputedStyle(el).transform,
      hovered: el.matches(':hover'),
    })));

  console.log('no hover:', JSON.stringify(await read(), null, 2));

  for (const side of ['l', 'r']) {
    const pt = await page.evaluate((s) => {
      const el = document.querySelector(`.intro-half-${s} .intro-cta`);
      const r = el.getBoundingClientRect();
      /* a point inside THIS half's visible clip: left half → x = mid of [r.x, viewport mid] */
      const midX = window.innerWidth / 2;
      return s === 'l'
        ? { x: (r.x + midX) / 2, y: r.y + r.height / 2 }
        : { x: (midX + r.x + r.width) / 2, y: r.y + r.height / 2 };
    }, side);
    await page.mouse.move(pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 500)); /* let transitions finish */
    console.log(`hover LEFT-half pill point (${side} probe):`, JSON.stringify(await read(), null, 2));
  }

  /* elementFromPoint at both pill halves — what actually receives the pointer */
  const hit = await page.evaluate(() => {
    const el = document.querySelector('.intro-half-l .intro-cta');
    const r = el.getBoundingClientRect();
    const midX = window.innerWidth / 2;
    const y = r.y + r.height / 2;
    const f = (x) => {
      const t = document.elementFromPoint(x, y);
      return t ? t.className || t.tagName : 'null';
    };
    return { leftHalfHit: f((r.x + midX) / 2), rightHalfHit: f((midX + r.x + r.width) / 2) };
  });
  console.log('hit-test at pill:', JSON.stringify(hit));
} finally {
  await browser.close();
}
