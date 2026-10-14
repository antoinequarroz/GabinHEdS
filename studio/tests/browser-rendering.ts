import assert from 'node:assert/strict';

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

export async function proofScreenshot(page: any, path: string, viewportOnly = false): Promise<string[]> {
  await renderedLayout(page);
  if (!viewportOnly) {
    await page.screenshot({ path, fullPage: true, animations: 'disabled', timeout: 45_000 });
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
      await page.evaluate((top: number) => window.scrollTo({ top, left: 0, behavior: 'instant' }), offset);
      await renderedLayout(page);
      const destination = index === 0 ? path : path.replace(/\.png$/, `-part-${index + 1}.png`);
      const png = await page.screenshot({ path: destination, fullPage: false, scale: 'css', animations: 'disabled', timeout: 45_000 });
      assert.equal(png.readUInt32BE(16), viewport.width, 'The captured viewport has the requested width');
      assert.equal(png.readUInt32BE(20), viewport.height, 'The captured viewport has the requested height');
      paths.push(destination);
    }
  } finally {
    // A closed/failed page must not replace the original capture error.
    await page.evaluate(({ x, y }: { x: number; y: number }) => window.scrollTo({ left: x, top: y, behavior: 'instant' }), original).catch(() => undefined);
  }
  return paths;
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
  } finally {
    await context.close();
  }
}
