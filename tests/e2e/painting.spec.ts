import { expect, test, type CDPSession, type Page } from '@playwright/test';

type Pt = [number, number];

/** Real touch input via the DevTools protocol (multi-touch capable). */
class Touch {
  constructor(
    private readonly cdp: CDPSession,
    private readonly box: { x: number; y: number; width: number; height: number },
  ) {}
  private p = ([x, y]: Pt) => ({ x: this.box.x + x * this.box.width, y: this.box.y + y * this.box.height });

  async drag(points: Pt[], steps = 20) {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [this.p(points[0]!)] });
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1]!, points[i]!];
      for (let s = 1; s <= steps; s++) {
        const q: Pt = [a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps];
        await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [this.p(q)] });
      }
    }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async twoFingerTap() {
    const a = this.p([0.4, 0.5]);
    const b = this.p([0.6, 0.5]);
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a, id: 1 }, { ...b, id: 2 }] });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async pinch() {
    const t = (d: number) => [
      { ...this.p([0.5 - d, 0.5]), id: 1 },
      { ...this.p([0.5 + d, 0.5]), id: 2 },
    ];
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: t(0.1) });
    for (let i = 1; i <= 10; i++) {
      await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: t(0.1 + i * 0.02) });
      await new Promise((r) => setTimeout(r, 40));
    }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

declare global {
  interface Window {
    __app: {
      engine: { commands(): unknown[]; readImage(): ImageData; view: { scale: number } } | null;
      canUndo: { value: boolean };
      busy: { value: boolean };
      error: { value: string | null };
    };
  }
}

const commandCount = (page: Page) => page.evaluate(() => window.__app.engine!.commands().length);

/** Fraction of pixels that are clearly coloured (not white/grey). */
const colourfulness = (page: Page) =>
  page.evaluate(() => {
    const img = window.__app.engine!.readImage();
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4 * 16) {
      const r = img.data[i]!, g = img.data[i + 1]!, b = img.data[i + 2]!;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) n++;
    }
    return n / (img.data.length / (4 * 16));
  });

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start painting' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForFunction(() => !!window.__app.engine && !window.__app.busy.value);
}

test('the full technique works with touch: splodge, bury, sweep, undo', async ({ page, context, isMobile }) => {
  test.skip(!isMobile, 'touch flow');
  await start(page);
  const box = (await page.locator('canvas').boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.width).toBeLessThanOrEqual(vw); // no horizontal overflow on phones
  const touch = new Touch(await context.newCDPSession(page), box);

  await page.getByRole('button', { name: 'Scatter' }).tap();
  await touch.drag([[0.5, 0.5], [0.5, 0.5]], 1); // tap = drop a blob
  await expect.poll(() => commandCount(page)).toBe(2);
  const afterDrop = await colourfulness(page);
  expect(afterDrop).toBeGreaterThan(0.02);

  await page.getByRole('button', { name: /Bury/ }).tap();
  await page.getByRole('button', { name: 'Cover all' }).tap();
  const afterCover = await colourfulness(page);
  expect(afterCover).toBeLessThan(afterDrop / 4); // colours are buried under white

  await page.getByRole('button', { name: /Sweep/ }).tap();
  await touch.drag([[0.05, 0.3], [0.5, 0.25], [0.95, 0.35]]);
  await touch.drag([[0.05, 0.7], [0.5, 0.8], [0.95, 0.65]]);
  await expect.poll(() => commandCount(page)).toBe(5);
  const afterSweep = await colourfulness(page);
  expect(afterSweep).toBeGreaterThan(afterCover * 2); // the sweep brings colour back

  // Two-finger tap undoes the last stroke.
  await touch.twoFingerTap();
  await expect.poll(() => commandCount(page)).toBe(4);
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();

  // Pinch zooms without painting.
  const scale = await page.evaluate(() => window.__app.engine!.view.scale);
  await touch.pinch();
  expect(await page.evaluate(() => window.__app.engine!.view.scale)).toBeGreaterThan(scale * 1.5);
  expect(await commandCount(page)).toBe(4);
  expect(await page.evaluate(() => window.__app.error.value)).toBeNull();
});

test('undo/redo replay is exact', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Scatter' }).click();
  await page.getByRole('button', { name: /Bury/ }).click();
  await page.getByRole('button', { name: 'Cover all' }).click();
  await page.getByRole('button', { name: /Sweep/ }).click();
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + box.width * (0.1 + i * 0.027), box.y + box.height * (0.5 + Math.sin(i / 5) * 0.1));
  await page.mouse.up();
  await expect.poll(() => commandCount(page)).toBe(3);
  const hash = () =>
    page.evaluate(() => {
      const d = window.__app.engine!.readImage().data;
      let h = 0;
      for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]!) >>> 0;
      return h;
    });
  const before = await hash();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => commandCount(page)).toBe(1);
  await page.getByRole('button', { name: 'Redo' }).click();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(() => commandCount(page)).toBe(3);
  expect(await hash()).toBe(before);
});

test('paintings are saved and restored after reload', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Scatter' }).click();
  await expect.poll(() => commandCount(page)).toBe(1);
  // Autosave is debounced; open the gallery to force a save.
  await page.getByRole('button', { name: 'My paintings' }).click();
  await expect(page.locator('.gallery-item img')).toHaveCount(1);
  await page.reload();
  await page.waitForFunction(() => !!window.__app.engine && !window.__app.busy.value && window.__app.engine.commands().length > 0);
  expect(await commandCount(page)).toBe(1);
});
