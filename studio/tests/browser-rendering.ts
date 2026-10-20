import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Playwright is loaded from an isolated runtime by browser-check.ts.
export async function renderedLayout(page: any): Promise<void> {
  await page.bringToFront();
  const viewport = page.viewportSize();
  const key = `__ninoPaintProbe_${randomUUID()}`;
  try {
    await page.waitForFunction(({ expected, key }: { expected: { width: number; height: number } | null; key: string }) => {
      const probes = document as unknown as Record<string, { signature: string; frames: number }>;
      const probe = probes[key] ??= { signature: '', frames: 0 };
      if (document.readyState === 'loading' || document.fonts.status !== 'loaded'
        || (expected && (innerWidth !== expected.width || innerHeight !== expected.height
          || document.documentElement.clientWidth <= 0 || document.documentElement.clientWidth > expected.width))) {
        probe.frames = 0; probe.signature = ''; return false;
      }
      const signature = [innerWidth, innerHeight, document.documentElement.clientWidth,
        document.documentElement.scrollWidth, document.documentElement.scrollHeight, document.body.scrollHeight,
        visualViewport?.width, visualViewport?.height].join(',');
      if (signature !== probe.signature) { probe.signature = signature; probe.frames = 0; return false; }
      return ++probe.frames >= 2;
    }, { expected: viewport, key }, { timeout: 10_000, polling: 'raf' });
  } finally {
    await page.evaluate((key: string) => { delete (document as unknown as Record<string, unknown>)[key]; }, key).catch(() => undefined);
  }
  // Keep both paint frames inside waitForFunction: Playwright recreates that
  // wait and its document-scoped probe when navigation destroys the context.
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
  const key = `__ninoImageProbe_${randomUUID()}`;
  try {
    await page.waitForFunction(({ selector, expected, key }: { selector: string; expected: number; key: string }) => {
      type Probe = { images: HTMLImageElement[]; sources: string[]; status: 'pending' | 'decoded' | 'failed'; error?: unknown };
      const probes = document as unknown as Record<string, Probe>;
      const images = [...document.querySelectorAll<HTMLImageElement>(selector)];
      if (images.length !== expected || images.some(image => !image.complete || image.naturalWidth === 0)) {
        delete probes[key]; return false;
      }
      let probe = probes[key];
      if (!probe || images.some((image, index) => image !== probe.images[index] || image.currentSrc !== probe.sources[index])) {
        probe = probes[key] = { images, sources: images.map(image => image.currentSrc), status: 'pending' };
        const decoding = probe;
        Promise.all(images.map(image => image.decode())).then(() => { decoding.status = 'decoded'; }, error => {
          decoding.status = 'failed'; decoding.error = error;
        });
      }
      if (probe.status === 'failed') throw probe.error;
      return probe.status === 'decoded';
    }, { selector, expected, key }, { timeout, polling: 'raf' });
  } finally {
    await page.evaluate((key: string) => { delete (document as unknown as Record<string, unknown>)[key]; }, key).catch(() => undefined);
  }
  // The synchronous predicate stays false until native decoding completes.
  // Its document-scoped probe is recreated if navigation destroys the context.
}

async function settledScroll(page: any, position: { x: number; y: number }): Promise<void> {
  // Activating a WebKit page can restore focus/scroll and change its mobile
  // scrollport. Activate and paint first, rather than after setting the target.
  await renderedLayout(page);
  const key = `__ninoScrollProbe_${randomUUID()}`;
  let target: { x: number; y: number };
  try {
    const settled = await page.waitForFunction(({ x, y, key }: { x: number; y: number; key: string }) => {
      const probes = document as unknown as Record<string, { signature: string; frames: number }>;
      const probe = probes[key] ??= { signature: '', frames: 0 };
      const width = document.documentElement.scrollWidth;
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const target = { x: Math.min(Math.max(0, x), Math.max(0, width - innerWidth)),
        y: Math.min(Math.max(0, y), Math.max(0, height - innerHeight)) };
      const signature = [innerWidth, innerHeight, width, height, target.x, target.y].join(',');
      if (Math.abs(scrollX - target.x) > .5 || Math.abs(scrollY - target.y) > .5) {
        window.scrollTo({ left: target.x, top: target.y, behavior: 'instant' });
        probe.signature = signature; probe.frames = 0; return false;
      }
      // Recompute the clamp on each frame if layout/scroll restoration moved
      // it. A transient matching scroll event is not yet a painted viewport.
      if (signature !== probe.signature) { probe.signature = signature; probe.frames = 0; return false; }
      return ++probe.frames >= 2 ? target : false;
    }, { ...position, key }, { timeout: 5000, polling: 'raf' });
    try { target = await settled.jsonValue(); }
    finally { await settled.dispose(); }
  } finally {
    await page.evaluate((key: string) => { delete (document as unknown as Record<string, unknown>)[key]; }, key).catch(() => undefined);
  }
  const actual = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  assert(Math.abs(actual.x - target.x) <= .5 && Math.abs(actual.y - target.y) <= .5,
    `Proof scroll must remain stable while the viewport is painted: ${JSON.stringify({ requested: position, target, actual })}`);
}

/** Reproduce the mobile scrollport changes that used to happen between the
 * first matching scroll position and the separate paint/foreground wait. */
async function verifyLayoutSynchronization(page: any, meta: string): Promise<void> {
  await page.setContent(`${meta}<main style="height:2700px">Scroll synchronization</main>`);
  await page.evaluate(() => window.addEventListener('scroll', () => {
    requestAnimationFrame(() => { document.querySelector<HTMLElement>('main')!.style.height = '2500px'; });
  }, { once: true }));
  await settledScroll(page, { x: 0, y: 1800 });
  assert.equal(await page.evaluate(() => scrollY), 1600,
    'A document resized during the scroll must use its new painted bottom, not a stale clamp');

  await page.evaluate(() => window.addEventListener('scroll', () => {
    requestAnimationFrame(() => window.scrollTo({ top: 120, behavior: 'instant' }));
  }, { once: true }));
  await settledScroll(page, { x: 0, y: 700 });
  assert.equal(await page.evaluate(() => scrollY), 700,
    'Asynchronous scroll restoration must settle before the proof reads pixels');

  const destination = 'https://rendering.nino.test/paint-navigation';
  await page.route(destination, (route: any) => route.fulfill({ contentType: 'text/html', body: `${meta}<main>Navigation painted</main>` }));
  await page.evaluate((url: string) => {
    // Do not allow the departing document to look settled while navigation is
    // committing. Its timers disappear when the real document is replaced.
    setInterval(() => { document.body.style.paddingTop = `${parseFloat(document.body.style.paddingTop || '0') + 1}px`; }, 1);
    requestAnimationFrame(() => location.replace(url));
  }, destination);
  await renderedLayout(page);
  assert.equal(page.url(), destination, 'Paint synchronization must survive a document replacement');
  assert.equal(await page.locator('main').textContent(), 'Navigation painted');
  await page.unroute(destination);
  console.info('Gardes rendu : contraction du document, restauration asynchrone du scroll et navigation pendant les frames réellement synchronisées.');
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
    await verifyLayoutSynchronization(page, meta);
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

    const destination = 'https://rendering.nino.test/decoded-images-navigation';
    await page.route(destination, (route: any) => route.fulfill({ contentType: 'text/html',
      body: `${meta}<img src="${pixel}"><img src="${pixel}">` }));
    await page.evaluate((url: string) => {
      const nativeDecode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        // Decode a real image, then replace the document before this call can
        // complete. The new document must decode its own images natively.
        return nativeDecode.call(this).then(() => new Promise<void>(() => {
          requestAnimationFrame(() => location.replace(url));
        }));
      };
    }, destination);
    await decodedImagePreviews(page, 'img', 2);
    assert.equal(page.url(), destination, 'Image decoding must survive a real document replacement');
    await page.unroute(destination);

    await page.locator('img').first().evaluate((image: HTMLImageElement) => {
      image.decode = () => Promise.reject(new Error('Deliberate native image decode failure'));
    });
    await assert.rejects(() => decodedImagePreviews(page, 'img', 2), /Deliberate native image decode failure/);
    await page.setContent(`${meta}<img src="${pixel}">`);
    await assert.rejects(() => decodedImagePreviews(page, 'img', 2, 500), /Timeout/);
    console.info('Gardes images : navigation réelle pendant le décodage supportée ; erreur de décodage et nombre incorrect rejetés.');
    await verifyScreenshotRecovery(page, meta, pixel);
  } finally {
    await context.close();
  }
}
