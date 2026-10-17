#!/usr/bin/env node
/**
 * Headless screenshot / smoke-test tool (Playwright Chromium).
 *
 * Usage:
 *   node scripts/shot.mjs <path-or-url> <out.png> [options]
 *
 * Options:
 *   --w 1280 --h 720          viewport size (default 1280x720)
 *   --dpr 1                   device scale factor
 *   --wait 3000               ms to wait after load (or after ready) before capturing (default 2500)
 *   --ready                   wait until window.__shotReady === true (max 20s) before the wait
 *   --keys "KeyW:2000,Space+KeyW:800"   hold key combos for durations (ms), sequentially, after wait
 *   --series N --interval ms  capture N screenshots (out_0.png ...) spaced by interval, during/after keys
 *   --eval "js"               evaluate JS in the page before capturing (after wait)
 *   --gl swiftshader|gpu      WebGL backend (default gpu; falls back to swiftshader automatically if WebGL fails)
 *   --fps                     report rendered frames per second over 2s
 *   --mobile                  emulate touch + mobile viewport (390x844, dpr 3)
 *
 * The base URL defaults to http://127.0.0.1:5173 (override with SHOT_BASE).
 * Console errors / page errors are printed as "[console.error] ..." lines; exit code 2 if any page error.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: node scripts/shot.mjs <path-or-url> <out.png> [options]');
  process.exit(1);
}
const target = args[0];
const out = resolve(args[1]);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const flag = (name) => args.includes(`--${name}`);

const base = process.env.SHOT_BASE ?? 'http://127.0.0.1:5173';
const url = /^https?:\/\//.test(target) ? target : base + (target.startsWith('/') ? target : `/${target}`);
const mobile = flag('mobile');
const W = Number(opt('w', mobile ? 390 : 1280));
const H = Number(opt('h', mobile ? 844 : 720));
const dpr = Number(opt('dpr', mobile ? 3 : 1));
const wait = Number(opt('wait', 2500));
const series = Number(opt('series', 1));
const interval = Number(opt('interval', 500));
const keys = opt('keys', '');
const evalJs = opt('eval', '');
const glMode = opt('gl', 'gpu');

const GL_ARGS = {
  gpu: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-webgl', '--disable-gpu-sandbox'],
  swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
};

async function run(mode) {
  const browser = await chromium.launch({ headless: true, args: [...GL_ARGS[mode], '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: dpr,
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') {
      const text = m.text();
      if (/GPU stall due to ReadPixels|Automatic fallback to software WebGL|WebGL-.*Performance/i.test(text)) return;
      problems.push(`[console.${t}] ${text}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const webgl = await page.evaluate(() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'webgl2';
    } catch {
      return null;
    }
  });
  if (!webgl) {
    await browser.close();
    return { ok: false, mode };
  }
  if (flag('ready')) {
    try {
      await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 20000 });
    } catch {
      problems.push('[shot] window.__shotReady never became true (20s)');
    }
  }
  await page.waitForTimeout(wait);
  if (evalJs) {
    try {
      const r = await page.evaluate(evalJs);
      if (r !== undefined) console.log('[eval]', typeof r === 'string' ? r : JSON.stringify(r));
    } catch (e) {
      problems.push(`[eval error] ${e.message}`);
    }
  }

  const shots = [];
  const capture = async (i) => {
    const file = series > 1 ? out.replace(/\.png$/, `_${i}.png`) : out;
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    shots.push(file);
  };

  if (keys) {
    // hold key combos sequentially; capture series spread over the key timeline
    const steps = String(keys)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [combo, ms] = s.split(':');
        return { combo: combo.split('+'), ms: Number(ms ?? 500) };
      });
    const total = steps.reduce((a, s) => a + s.ms, 0);
    let shotIdx = 0;
    const shotTimes = Array.from({ length: series }, (_, i) => (series === 1 ? total : (i * total) / Math.max(1, series - 1)));
    let t = 0;
    for (const step of steps) {
      for (const k of step.combo) await page.keyboard.down(k);
      const end = t + step.ms;
      while (shotIdx < series && shotTimes[shotIdx] <= end) {
        const dtWait = Math.max(0, shotTimes[shotIdx] - t);
        await page.waitForTimeout(dtWait);
        t += dtWait;
        await capture(shotIdx++);
      }
      await page.waitForTimeout(Math.max(0, end - t));
      t = end;
      for (const k of step.combo) await page.keyboard.up(k);
    }
    while (shotIdx < series) await capture(shotIdx++);
  } else {
    for (let i = 0; i < series; i++) {
      if (i > 0) await page.waitForTimeout(interval);
      await capture(i);
    }
  }

  if (flag('fps')) {
    const fps = await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => {
            n++;
            if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
            else res(Math.round((n * 1000) / (performance.now() - t0)));
          };
          requestAnimationFrame(tick);
        }),
    );
    console.log(`[fps] ${fps}`);
  }
  await browser.close();
  return { ok: true, mode, webgl, problems, shots };
}

let res = await run(glMode === 'swiftshader' ? 'swiftshader' : 'gpu');
if (!res.ok && glMode !== 'swiftshader') res = await run('swiftshader');
if (!res.ok) {
  console.error('[shot] WebGL2 unavailable in headless Chromium');
  process.exit(3);
}
console.log(`[shot] renderer=${res.webgl} mode=${res.mode}`);
for (const s of res.shots) console.log(`[shot] saved ${s}`);
for (const p of res.problems) console.log(p);
process.exit(res.problems.some((p) => p.startsWith('[pageerror]')) ? 2 : 0);
