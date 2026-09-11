const { chromium } = require('playwright-core');
const fs = require('node:fs');
const base = fs.readFileSync(
  require('node:path').join(
    __dirname,
    '../fixtures/thicken-variable-radius.ts',
  ),
  'utf8',
);
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    for (const [size, depth, low, high] of [
      [100, 1, 1, 5],
      [304.8, 3, 0.1, 1],
      [304.8, 1, 1, 5],
    ]) {
      const source = base
        .replace('const levels = 1;', `const levels = ${depth};`)
        .replace('0.1, 1)', `${low}, ${high})`);
      const start = Date.now();
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1100 },
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(
        ({ source, size }) => {
          localStorage.setItem('occlude.sketch', source);
          localStorage.setItem(
            'occlude.settings',
            JSON.stringify({
              paper: 'Custom',
              customPaper: { w: size, h: size },
            }),
          );
        },
        { source, size },
      );
      await page.goto(process.env.STUDIO_URL || 'http://127.0.0.1:4173/', {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForFunction(
        () => {
          const s = document.querySelector('#status-msg');
          return s?.textContent === 'ok' || s?.className === 'status-err';
        },
        {},
        { timeout: 60000 },
      );
      const status = await page.locator('#status-msg').textContent();
      const build = await page.locator('#status-build').textContent();
      if (
        process.env.EXPECTED_BUILD &&
        !build.includes(process.env.EXPECTED_BUILD)
      )
        throw Error('Unexpected build: ' + build);
      console.log(
        JSON.stringify({
          size,
          depth,
          low,
          high,
          status,
          build,
          errors,
          elapsedMs: Date.now() - start,
        }),
      );
      if (status !== 'ok' || errors.length)
        throw Error(status + ' ' + errors.join(','));
      await page.screenshot({
        path: `/tmp/thicken-exact-${size}-${depth}.png`,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
