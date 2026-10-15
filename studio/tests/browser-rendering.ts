import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Playwright is loaded from an isolated runtime by browser-check.ts.
export async function renderedLayout(page: any): Promise<void> {
  await page.bringToFront();
  const viewport = page.viewportSize();
  await page.waitForFunction((expected: { width: number; height: number } | null) =>
    document.readyState !== 'loading' && document.fonts.status === 'loaded'
      && (!expected || (innerWidth === expected.width && innerHeight === expected.height
        && document.documentElement.clientWidth > 0 && document.documentElement.clientWidth <= expected.width)),
  viewport, { timeout: 10_000, polling: 'raf' });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

export async function noOverflow(page: any, label: string, timeout = 5_000): Promise<void> {
  await renderedLayout(page);
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1,
    null, { timeout, polling: 'raf' }).catch(() => undefined);
  const dimensions = await page.evaluate(() => ({
    width: innerWidth, scroll: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth, screenWidth: screen.width,
    visualWidth: visualViewport?.width,
    ...(document.documentElement.scrollWidth > innerWidth + 1 ? {
      overflowing: [...document.querySelectorAll<HTMLElement>('body *')].map(element => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, class: element.className, left: rect.left, right: rect.right, width: rect.width };
      }).filter(rect => rect.right > innerWidth + 1).slice(0, 12),
    } : {}),
  }));
  assert(dimensions.scroll <= dimensions.width + 1, `${label}: ${dimensions.scroll}px pour ${dimensions.width}px ${JSON.stringify(dimensions)}`);
}

export async function decodedImagePreviews(page: any, selector: string, expected: number, timeout = 15_000): Promise<void> {
  await renderedLayout(page);
  await page.waitForFunction(({ selector, expected }: { selector: string; expected: number }) => {
    const images = [...document.querySelectorAll<HTMLImageElement>(selector)];
    return images.length === expected && images.every(image => image.complete && image.naturalWidth > 0);
  }, { selector, expected }, { timeout, polling: 'raf' });
  await page.locator(selector).evaluateAll((images: HTMLImageElement[]) => Promise.all(images.map(image => image.decode())));
}

async function settledScroll(page: any, position: { x: number; y: number }): Promise<void> {
  const target = await page.evaluate(({ x, y }: { x: number; y: number }) => {
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const left = Math.min(Math.max(0, x), Math.max(0, document.documentElement.scrollWidth - innerWidth));
    const top = Math.min(Math.max(0, y), Math.max(0, height - innerHeight));
    window.scrollTo({ left, top, behavior: 'instant' });
    return { x: left, y: top };
  }, position);
  await page.waitForFunction(({ x, y }: { x: number; y: number }) => Math.abs(scrollX - x) <= .5 && Math.abs(scrollY - y) <= .5,
    target, { timeout: 5000, polling: 'raf' });
  await renderedLayout(page);
  const actual = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  assert(Math.abs(actual.x - target.x) <= .5 && Math.abs(actual.y - target.y) <= .5, 'Proof scroll must remain stable while the viewport is painted');
}

async function capturePaintedPage(page: any, options: Record<string, unknown>): Promise<Buffer> {
  const viewport = page.viewportSize();
  const position = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  try {
    return await page.screenshot({ ...options, timeout: 15_000 });
  } catch (error) {
    // Only the native screenshot's deadline can trigger this recovery. Layout,
    // image, JavaScript and page-closed errors must retain their actual failure.
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    assert(viewport, 'A viewport is required to repaint a timed-out proof capture');
    // WebKit snapshots viewport coordinates with Page.snapshotRect. A one-pixel
    // resize invalidates its backing view; restore all geometry before reading
    // pixels. Keep the page, devices, forms, tokens and media connections alive.
    await page.setViewportSize({ width: viewport.width, height: viewport.height + 1 });
    try { await renderedLayout(page); }
    finally { await page.setViewportSize(viewport); }
    await settledScroll(page, position);
    await noOverflow(page, 'Repainted proof viewport');
    const images = page.locator('img');
    const count = await images.count();
    const broken = await images.evaluateAll((items: HTMLImageElement[]) => items.some(image => image.complete && image.naturalWidth === 0));
    assert(!broken, 'A missing image cannot be hidden by screenshot recovery');
    await decodedImagePreviews(page, 'img', count);
    // One real second snapshot only. A second timeout is a failing proof, never
    // a skipped capture, renamed failure, placeholder or synthesized image.
    return await page.screenshot({ ...options, timeout: 45_000 });
  }
}

export async function proofScreenshot(page: any, path: string, viewportOnly = false): Promise<string[]> {
  await renderedLayout(page);
  if (!viewportOnly) {
    await capturePaintedPage(page, { path, fullPage: true, animations: 'disabled' });
    return [path];
  }
  // WebKit's fullPage path snapshots an offscreen document rectangle. Capture
  // actual painted viewports instead, with overlap for fixed studio controls.
  const viewport = page.viewportSize();
  assert(viewport, 'A viewport is required for WebKit proof captures');
  assert(path.endsWith('.png'), 'Proof captures use PNG');
  const original = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const height = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
  const lastOffset = Math.max(0, height - viewport.height);
  const offsets = [0];
  const stride = Math.max(1, Math.floor(viewport.height / 2));
  for (let offset = stride; offset < lastOffset; offset += stride) offsets.push(offset);
  if (lastOffset > 0) offsets.push(lastOffset);
  const paths: string[] = [];
  try {
    for (const [index, offset] of offsets.entries()) {
      await settledScroll(page, { x: 0, y: offset });
      const destination = index === 0 ? path : path.replace(/\.png$/, `-part-${index + 1}.png`);
      const png = await capturePaintedPage(page, { path: destination, fullPage: false, scale: 'css', animations: 'disabled' });
      assert.equal(png.readUInt32BE(16), viewport.width, 'The captured viewport has the requested width');
      assert.equal(png.readUInt32BE(20), viewport.height, 'The captured viewport has the requested height');
      paths.push(destination);
    }
  } finally {
    // A closed/failed page must not replace the original capture error.
    await settledScroll(page, original).catch(() => undefined);
  }
  return paths;
}

/** Exercise the recovery with real painted PNGs, including the document's last
 * viewport. Inject only failures, never an image or a successful screenshot. */
async function verifyScreenshotRecovery(page: any, meta: string, pixel: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'nino-screenshot-guard-'));
  const nativeScreenshot = page.screenshot.bind(page);
  const timedOut = () => { const error = new Error('page.screenshot: Timeout 15000ms exceeded. Synthetic deadline for the guard.'); error.name = 'TimeoutError'; return error; };
  try {
    await page.setContent(`${meta}<style>section{height:900px}header{position:fixed;top:0;left:0;right:0;height:48px;background:#fff}img{position:fixed;right:8px;bottom:8px;width:24px;height:24px}</style><header><input id="preserved" value="État conservé"></header><section style="background:#442233"></section><section style="background:#224433"></section><section style="background:#223344"></section><img src="${pixel}">`);
    await decodedImagePreviews(page, 'img', 1);
    await settledScroll(page, { x: 0, y: 350 });
    let attempts = 0; const paintedOffsets: number[] = [];
    page.screenshot = async (options: Record<string, unknown>) => {
      if (++attempts === 1) throw timedOut();
      paintedOffsets.push(await page.evaluate(() => scrollY));
      return nativeScreenshot(options);
    };
    const paths = await proofScreenshot(page, join(directory, 'recovered.png'), true);
    assert.equal(paths.length, 5, 'Every overlapping viewport, including the bottom, must be captured');
    assert.deepEqual(paintedOffsets, [0, 450, 900, 1350, 1800]);
    assert.equal(attempts, 6, 'Only the timed-out first viewport gets one extra native attempt');
    const expected = [[68, 34, 51], [34, 68, 51], [34, 68, 51], [34, 51, 68], [34, 51, 68]];
    for (const [index, path] of paths.entries()) {
      const png = await readFile(path);
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(png.readUInt32BE(16), 390); assert.equal(png.readUInt32BE(20), 900);
      const painted = await page.evaluate(async (uri: string) => {
        const image = new Image(); image.src = uri; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
        return [...context.getImageData(30, 450, 1, 1).data];
      }, `data:image/png;base64,${png.toString('base64')}`);
      assert.deepEqual(painted, [...expected[index], 255], 'The PNG must contain the actual coloured document at its intended scroll position');
    }
    assert.deepEqual(page.viewportSize(), { width: 390, height: 900 });
    assert.equal(await page.evaluate(() => scrollY), 350, 'Recovery must restore the original scroll position');
    assert.equal(await page.locator('#preserved').inputValue(), 'État conservé', 'Recovery must preserve the live page rather than reload it');

    attempts = 0; page.screenshot = async () => { attempts++; throw timedOut(); };
    await assert.rejects(() => proofScreenshot(page, join(directory, 'persistent.png'), true), (error: unknown) => error instanceof Error && error.name === 'TimeoutError');
    assert.equal(attempts, 2, 'A persistent capture failure must stop after its second attempt');
    await assert.rejects(() => readFile(join(directory, 'persistent.png')), /ENOENT/);

    attempts = 0; page.screenshot = async () => { attempts++; throw new Error('Renderer failure, not a capture timeout'); };
    await assert.rejects(() => proofScreenshot(page, join(directory, 'renderer-error.png'), true), /Renderer failure/);
    assert.equal(attempts, 1, 'Other native or JavaScript errors must not enter timeout recovery');

    attempts = 0; page.screenshot = async () => { attempts++; await page.locator('body').evaluate((body: HTMLElement) => { body.style.minWidth = '420px'; }); throw timedOut(); };
    await assert.rejects(() => proofScreenshot(page, join(directory, 'overflow.png'), true), assert.AssertionError);
    assert.equal(attempts, 1, 'A real overflowing layout must prevent the second capture');
    await page.locator('body').evaluate((body: HTMLElement) => { body.style.minWidth = ''; });

    attempts = 0; page.screenshot = async () => {
      attempts++; await page.locator('img').evaluate((image: HTMLImageElement) => { image.src = 'https://rendering.nino.test/missing.png'; });
      await page.waitForFunction(() => { const image = document.querySelector('img')!; return image.complete && image.naturalWidth === 0; });
      throw timedOut();
    };
    await assert.rejects(() => proofScreenshot(page, join(directory, 'missing.png'), true), /missing image/);
    assert.equal(attempts, 1, 'A missing decoded image must prevent the second capture');
    console.info('Gardes capture : timeout récupéré par 5 PNG réels, couleurs/dimensions/recouvrement et bas de page vérifiés ; échecs persistants, JS, débordement et image manquante rejetés.');
  } finally {
    page.screenshot = nativeScreenshot;
    await rm(directory, { recursive: true, force: true });
  }
}

// These guards fail if a change accidentally hides a real layout/image failure.
export async function verifyRenderingGuards(browser: any): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    // Keep this synthetic guard at scale 1: mobile Chromium otherwise zooms
    // out to fit the deliberately overflowing element before it is measured.
    const meta = '<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1"><style>body{margin:0}</style>';
    await page.setContent(`${meta}<main>Rendering guard</main>`);
    await noOverflow(page, 'Viewport 390');
    await page.locator('main').evaluate((element: HTMLElement) => { element.style.width = '420px'; });
    await assert.rejects(() => noOverflow(page, 'Overflow guard', 100), assert.AssertionError);

    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    await page.route('https://rendering.nino.test/missing.png', (route: any) => route.fulfill({ status: 404, body: 'Missing image' }));
    await page.setContent(`${meta}<img src="${pixel}"><img src="https://rendering.nino.test/missing.png">`);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('img')]
      .some(image => image.src.endsWith('/missing.png') && image.complete && image.naturalWidth === 0));
    await assert.rejects(() => decodedImagePreviews(page, 'img', 2, 500), /Timeout/);
    await page.setContent(`${meta}<img src="${pixel}"><img src="${pixel}">`);
    await decodedImagePreviews(page, 'img', 2);
    await verifyScreenshotRecovery(page, meta, pixel);
  } finally {
    await context.close();
  }
}
