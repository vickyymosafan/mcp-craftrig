import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BrowserInspectorPort,
  ColorSchemeMode,
  InteractionScenarioInput,
  InteractionScenarioReport,
  ResponsiveInspectionInput,
  ResponsiveInspectionReport,
  ResponsiveViewportResult,
  ThemeToggleVerification,
  ViewportProfile,
  VisualA11yAuditInput,
  VisualA11yAuditReport,
  VisualA11yCaseResult
} from '../../domain/ports.js';
import { assertLocalhostUrl } from '../security/workspace-guard.js';
import { evaluateDomVisualA11y, extractAxeFindings } from './visual-a11y-evaluator.js';
import { auditWebGLCanvases, installWebGLTracker, WEBGL_SHADER_WARNING_PATTERN } from './webgl-audit.js';

const DEFAULT_VISUAL_A11Y_VIEWPORTS: ViewportProfile[] = [
  { name: 'laptop-1280', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  { name: 'mobile-390', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
];

const DEFAULT_VIEWPORTS = [
  { name: 'small-mobile-320', width: 320, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'mobile-360', width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'mobile-375', width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'mobile-390', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'mobile-414', width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'large-mobile-430', width: 430, height: 932, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'tablet-768-portrait', width: 768, height: 1024, isMobile: false, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'mobile-844-landscape', width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'tablet-1024-landscape', width: 1024, height: 768, isMobile: false, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'laptop-1280', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  { name: 'laptop-1366', width: 1366, height: 768, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  { name: 'desktop-1440', width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  { name: 'wide-desktop-1920', width: 1920, height: 1080, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }
];

function safeRoute(route: string): string {
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\')) throw new Error(`Route must be a local absolute path beginning with /: ${route}`);
  return route;
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page'; }

const PERFORMANCE_ARGS = [
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--disable-translate',
  '--disable-extensions',
  '--disable-default-apps',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-pings'
];

async function launchSmartBrowser(chromium: typeof import('playwright').chromium) {
  const preferred = process.env.PLAYWRIGHT_CHANNEL;
  const candidates: Array<string | undefined> = [preferred, 'chrome', 'msedge', undefined].filter(
    (c, i, a): c is string | undefined => a.indexOf(c) === i
  );

  for (const channel of candidates) {
    try {
      return await chromium.launch({
        channel: channel as any,
        headless: true,
        args: PERFORMANCE_ARGS
      });
    } catch {
      // Continue to next fallback candidate
    }
  }

  return await chromium.launch({ headless: true, args: PERFORMANCE_ARGS });
}

class SharedBrowserPool {
  private browserPromise: Promise<import('playwright').Browser> | null = null;
  private activeCount = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private semaphoreAvailable = 4;
  private readonly waitingQueue: Array<() => void> = [];

  async runWithBrowser<T>(chromium: typeof import('playwright').chromium, fn: (browser: import('playwright').Browser) => Promise<T>): Promise<T> {
    await this.waitSemaphore();
    try {
      const browser = await this.getBrowser(chromium);
      return await fn(browser);
    } finally {
      this.releaseBrowser();
      this.releaseSemaphore();
    }
  }

  private waitSemaphore(): Promise<void> {
    if (this.semaphoreAvailable > 0) {
      this.semaphoreAvailable--;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waitingQueue.push(() => {
        this.semaphoreAvailable--;
        resolve();
      });
    });
  }

  private releaseSemaphore(): void {
    this.semaphoreAvailable++;
    const next = this.waitingQueue.shift();
    if (next) next();
  }

  private async getBrowser(chromium: typeof import('playwright').chromium): Promise<import('playwright').Browser> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.activeCount++;

    if (!this.browserPromise) {
      this.browserPromise = launchSmartBrowser(chromium).catch(err => {
        this.browserPromise = null;
        throw err;
      });
    }

    const browser = await this.browserPromise;
    if (!browser.isConnected()) {
      this.browserPromise = launchSmartBrowser(chromium);
      return this.browserPromise;
    }
    return browser;
  }

  private releaseBrowser(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.activeCount === 0 && this.browserPromise) {
      this.idleTimer = setTimeout(async () => {
        if (this.activeCount === 0 && this.browserPromise) {
          const promise = this.browserPromise;
          this.browserPromise = null;
          try {
            const browser = await promise;
            await browser.close();
          } catch {
            // ignore
          }
        }
      }, 20000);
      if (this.idleTimer.unref) this.idleTimer.unref();
    }
  }
}

const sharedPool = new SharedBrowserPool();

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await fn(item, index);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export class PlaywrightInspector implements BrowserInspectorPort {
  async discoverRoutes(baseUrl: string, timeoutMs: number) {
    const base = assertLocalhostUrl(baseUrl);
    const { chromium } = await import('playwright');
    return sharedPool.runWithBrowser(chromium, async browser => {
      const context = await browser.newContext();
      try {
        await context.route('**/*', async routeRequest => {
          if (!routeRequest.request().isNavigationRequest()) { await routeRequest.continue(); return; }
          try {
            const target = new URL(routeRequest.request().url());
            if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname) || target.origin !== base.origin) { await routeRequest.abort('blockedbyclient'); return; }
            await routeRequest.continue();
          } catch { await routeRequest.abort('blockedbyclient'); }
        });
        const page = await context.newPage();
        await page.goto(base.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const hrefs = await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => (anchor as HTMLAnchorElement).href));
        const routes = new Set<string>(['/']);
        for (const href of hrefs) {
          try {
            const target = new URL(href);
            if (target.origin !== base.origin) continue;
            routes.add(`${target.pathname}${target.search}`);
          } catch { /* Ignore malformed links. */ }
        }
        return { baseUrl: base.href, routes: [...routes].sort(), discoveredAt: new Date().toISOString() };
      } finally {
        await context.close();
      }
    });
  }

  async inspectResponsive(input: ResponsiveInspectionInput): Promise<ResponsiveInspectionReport> {
    const base = assertLocalhostUrl(input.baseUrl);
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const routes = input.routes.length ? input.routes : ['/'];
    const profiles = input.viewports.length ? input.viewports : DEFAULT_VIEWPORTS;
    const evidenceDirectory = path.resolve(input.evidenceDirectory);
    await mkdir(evidenceDirectory, { recursive: true });
    const { chromium } = await import('playwright');

    return sharedPool.runWithBrowser(chromium, async browser => {
      const tasks: Array<{ route: string; targetUrl: URL; viewport: (typeof profiles)[number] }> = [];
      for (const routeValue of routes) {
        const route = safeRoute(routeValue);
        const targetUrl = new URL(route, base);
        if (targetUrl.origin !== base.origin) throw new Error('Route escaped the configured localhost origin.');
        for (const viewport of profiles) {
          tasks.push({ route, targetUrl, viewport });
        }
      }

      const results: ResponsiveViewportResult[] = await mapConcurrent(tasks, 3, async ({ route, targetUrl, viewport }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          screen: { width: viewport.width, height: viewport.height },
          isMobile: viewport.isMobile,
          hasTouch: viewport.hasTouch,
          deviceScaleFactor: viewport.deviceScaleFactor,
          serviceWorkers: 'block',
          bypassCSP: true
        });
        await context.tracing.start({ screenshots: true, snapshots: true });
        await installWebGLTracker(context);
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        const shaderWarnings: string[] = [];
        const pageErrors: string[] = [];
        const failedRequests: string[] = [];
        const httpErrors: Array<{ status: number; url: string }> = [];
        page.on('console', message => {
          const text = message.text();
          if (message.type() === 'error') consoleErrors.push(text);
          if ((message.type() === 'error' || message.type() === 'warning') && WEBGL_SHADER_WARNING_PATTERN.test(text)) {
            shaderWarnings.push(text);
          }
        });
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown'}`));
        page.on('response', response => { if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() }); });
        await context.route('**/*', async routeRequest => {
          if (!routeRequest.request().isNavigationRequest()) { await routeRequest.continue(); return; }
          try {
            const navigationUrl = new URL(routeRequest.request().url());
            const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(navigationUrl.hostname);
            if (!isLoopback || navigationUrl.origin !== base.origin) { await routeRequest.abort('blockedbyclient'); return; }
            await routeRequest.continue();
          } catch { await routeRequest.abort('blockedbyclient'); }
        });
        const caseDirectory = path.join(evidenceDirectory, runId, slug(route), viewport.name);
        await mkdir(caseDirectory, { recursive: true });
        const screenshotPath = path.join(caseDirectory, 'full-page.png');
        let metrics = {
          documentWidth: viewport.width,
          viewportWidth: viewport.width,
          horizontalOverflow: 0,
          overflowElements: [] as Array<{ selector: string; scrollWidth: number; clientWidth: number }>,
          outOfBoundsElements: [] as Array<{ selector: string; left: number; right: number; width: number }>,
          brokenImages: [] as string[],
          bodyOverflowXHidden: false,
          backdropFilterCount: 0
        };
        const issues: string[] = [];
        let cdpMetrics: ResponsiveViewportResult['cdpMetrics'] = null;
        let tracePath: string | null = null;
        try {
          const response = await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs });
          await page.waitForLoadState('networkidle', { timeout: Math.min(input.timeoutMs, 3000) }).catch(() => undefined);
          await page.evaluate(async () => { if ('fonts' in document) await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1500))]); });
          const finalUrl = new URL(page.url());
          if (finalUrl.origin !== base.origin) throw new Error(`Navigation escaped localhost origin: ${finalUrl.origin}`);
          if (response && response.status() >= 400) issues.push(`Route returned HTTP ${response.status()}.`);

          try {
            const cdp = await context.newCDPSession(page);
            await cdp.send('Performance.enable').catch(() => {});
            const perfData = await cdp.send('Performance.getMetrics').catch(() => null);
            if (perfData?.metrics) {
              const m = new Map(perfData.metrics.map(x => [x.name, x.value]));
              cdpMetrics = {
                jsHeapUsedSize: m.get('JSHeapUsedSize'),
                jsHeapTotalSize: m.get('JSHeapTotalSize'),
                nodes: m.get('Nodes'),
                layoutCount: m.get('LayoutCount'),
                recalcStyleCount: m.get('RecalcStyleCount')
              };
            }
            await cdp.detach().catch(() => {});
          } catch {
            // CDP fallback
          }

          metrics = await page.evaluate((allowedSelectors: string[]) => {
            const doc = document.documentElement;
            const viewportWidth = window.innerWidth;
            const documentWidth = Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0);
            const isAllowed = (element: Element) => allowedSelectors.some(selector => { try { return element.matches(selector) || Boolean(element.closest(selector)); } catch { return false; } });
            const overflowElements: Array<{ selector: string; scrollWidth: number; clientWidth: number }> = [];
            const outOfBoundsElements: Array<{ selector: string; left: number; right: number; width: number }> = [];
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
              if (isAllowed(element)) continue;
              const style = getComputedStyle(element);
              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || element.closest('[aria-hidden="true"], [inert]')) continue;
              const rect = element.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) continue;
              if (element.scrollWidth > element.clientWidth + 3 && ['auto', 'scroll'].includes(style.overflowX)) {
                overflowElements.push({ selector: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '') + (element.classList.length ? `.${Array.from(element.classList).slice(0, 2).join('.')}` : ''), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth });
              }
              if (rect.left < -2 || rect.right > viewportWidth + 2) {
                outOfBoundsElements.push({ selector: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '') + (element.classList.length ? `.${Array.from(element.classList).slice(0, 2).join('.')}` : ''), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) });
              }
            }
            const brokenImages: string[] = [];
            for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('img'))) {
              if (img.complete && img.naturalWidth === 0) {
                const src = img.currentSrc || img.src || img.getAttribute('src') || 'unknown';
                brokenImages.push(src);
              }
            }

            const bodyStyle = document.body ? getComputedStyle(document.body) : null;
            const docStyle = getComputedStyle(doc);
            const bodyOverflowXHidden = (bodyStyle?.overflowX === 'hidden') || (docStyle.overflowX === 'hidden');

            let backdropFilterCount = 0;
            for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
              const s = getComputedStyle(el);
              const bf = s.backdropFilter || (s as Record<string, any>).webkitBackdropFilter;
              if (bf && bf !== 'none') backdropFilterCount++;
            }

            return {
              documentWidth,
              viewportWidth,
              horizontalOverflow: Math.max(0, documentWidth - viewportWidth),
              overflowElements: overflowElements.slice(0, 30),
              outOfBoundsElements: outOfBoundsElements.slice(0, 30),
              brokenImages: brokenImages.slice(0, 10),
              bodyOverflowXHidden,
              backdropFilterCount
            };
          }, input.allowedOverflowSelectors);
          if (metrics.horizontalOverflow > 1) issues.push(`Document has ${metrics.horizontalOverflow}px horizontal overflow.`);
          if (metrics.bodyOverflowXHidden) issues.push('Smoothness defect: <body> or <html> has overflow-x: hidden which breaks compositor fast-path scrolling; use overflow-x: clip instead.');
          if (metrics.backdropFilterCount > 8) issues.push(`Performance defect: ${metrics.backdropFilterCount} elements with backdrop-filter detected; excessive blur on scrolling elements exhausts GPU fillrate.`);
          if (metrics.outOfBoundsElements.length > 0) issues.push(`${metrics.outOfBoundsElements.length} visible element(s) extend beyond the viewport bounds.`);
          if (metrics.brokenImages.length > 0) issues.push(`${metrics.brokenImages.length} image(s) failed to load / broken: ${metrics.brokenImages.slice(0, 3).join(', ')}`);
          if (consoleErrors.length) issues.push(`${consoleErrors.length} browser console error(s).`);
          if (pageErrors.length) issues.push(`${pageErrors.length} uncaught page error(s).`);
          if (httpErrors.some(item => new URL(item.url).origin === base.origin)) issues.push('One or more same-origin requests returned HTTP 4xx/5xx.');
          const localFailedRequests = failedRequests.filter(value => { try { return new URL(value.match(/https?:\/\/\S+/)?.[0] ?? '').origin === base.origin; } catch { return false; } });
          if (localFailedRequests.length) issues.push(`${localFailedRequests.length} same-origin request(s) failed.`);

          const webglAudit = await auditWebGLCanvases(page, shaderWarnings);
          for (const webglIssue of webglAudit.issues) issues.push(webglIssue);
          await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
          await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
        } finally {
          if (issues.length > 0) {
            tracePath = path.join(caseDirectory, 'trace.zip');
            await context.tracing.stop({ path: tracePath }).catch(() => {});
          } else {
            await context.tracing.stop().catch(() => {});
          }
          await context.close();
        }
        const finalUrl = page.url();
        const passed = issues.length === 0;
        return {
          route,
          viewport,
          finalUrl,
          documentWidth: metrics.documentWidth,
          viewportWidth: metrics.viewportWidth,
          horizontalOverflow: metrics.horizontalOverflow,
          overflowElements: metrics.overflowElements,
          outOfBoundsElements: metrics.outOfBoundsElements,
          consoleErrors,
          pageErrors,
          failedRequests,
          httpErrors,
          screenshotPath,
          tracePath,
          cdpMetrics,
          passed,
          issues
        };
      });

      const finishedAt = new Date().toISOString();
      const passedCases = results.filter(item => item.passed).length;
      const report: ResponsiveInspectionReport = {
        runId, baseUrl: base.href, startedAt, finishedAt, routeCount: routes.length, viewportCount: profiles.length,
        totalCases: results.length, passedCases, failedCases: results.length - passedCases,
        overallStatus: passedCases === results.length ? 'pass' : 'fail', results,
        reportPath: path.join(evidenceDirectory, runId, 'responsive-report.json')
      };
      await mkdir(path.dirname(report.reportPath), { recursive: true });
      await writeFile(report.reportPath, JSON.stringify(report, null, 2), 'utf8');
      return report;
    });
  }

  async runInteractionScenario(input: InteractionScenarioInput): Promise<InteractionScenarioReport> {
    const base = assertLocalhostUrl(input.baseUrl);
    const route = safeRoute(input.route);
    const target = new URL(route, base);
    if (target.origin !== base.origin) throw new Error('Interaction route escaped the configured localhost origin.');
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const { chromium } = await import('playwright');
    const steps: InteractionScenarioReport['steps'] = [];
    const directory = path.join(path.resolve(input.evidenceDirectory), runId);
    await mkdir(directory, { recursive: true });
    const screenshotPath = path.join(directory, 'interaction.png');
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const httpErrors: Array<{ status: number; url: string }> = [];

    return sharedPool.runWithBrowser(chromium, async browser => {
      const context = await browser.newContext({ serviceWorkers: 'block', bypassCSP: true });
      try {
        await context.route('**/*', async routeRequest => {
          if (!routeRequest.request().isNavigationRequest()) { await routeRequest.continue(); return; }
          try {
            const navigationUrl = new URL(routeRequest.request().url());
            if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(navigationUrl.hostname) || navigationUrl.origin !== base.origin) { await routeRequest.abort('blockedbyclient'); return; }
            await routeRequest.continue();
          } catch { await routeRequest.abort('blockedbyclient'); }
        });
        const page = await context.newPage();
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown'}`));
        page.on('response', response => { if (response.status() >= 400) httpErrors.push({ status: response.status(), url: response.url() }); });
        await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs });
        for (const action of input.actions) {
          try {
            const locator = page.locator(action.selector).first();
            const timeout = action.timeoutMs ?? input.timeoutMs;
            if (!input.allowRiskyActions) {
              const targetDescription = await locator.evaluate(element => [element.textContent, element.getAttribute('aria-label'), element.getAttribute('name'), element.getAttribute('type'), element.getAttribute('data-testid')].filter(Boolean).join(' ')).catch(() => '');
              if (/delete|remove|purchase|checkout|pay|submit|logout|sign.?out/i.test(`${action.selector} ${targetDescription}`)) throw new Error('Potentially destructive target blocked. Set allowRiskyActions=true only for an isolated test environment.');
            }
            switch (action.action) {
              case 'click': await locator.click({ timeout }); break;
              case 'fill': await locator.fill(action.value ?? '', { timeout }); break;
              case 'check': await locator.check({ timeout }); break;
              case 'uncheck': await locator.uncheck({ timeout }); break;
              case 'select': await locator.selectOption(action.value ?? '', { timeout }); break;
              case 'press': await locator.press(action.value ?? 'Enter', { timeout }); break;
              case 'expect-visible': await locator.waitFor({ state: 'visible', timeout }); break;
              case 'expect-text': {
                const text = await locator.textContent({ timeout });
                if (!text?.includes(action.value ?? '')) throw new Error(`Expected text not found: ${action.value ?? ''}`);
                break;
              }
            }
            steps.push({ action: action.action, selector: action.selector, status: 'pass' });
          } catch (error) {
            steps.push({ action: action.action, selector: action.selector, status: 'fail', error: error instanceof Error ? error.message : String(error) });
          }
        }
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } finally {
        await context.close();
      }
      const finishedAt = new Date().toISOString();
      const localHttpErrors = httpErrors.filter(item => new URL(item.url).origin === base.origin);
      const localFailedRequests = failedRequests.filter(value => { try { return new URL(value.match(/https?:\/\/\S+/)?.[0] ?? '').origin === base.origin; } catch { return false; } });
      const passed = steps.every(step => step.status === 'pass') && consoleErrors.length === 0 && pageErrors.length === 0 && localHttpErrors.length === 0 && localFailedRequests.length === 0;
      const report: InteractionScenarioReport = { runId, route, passed, startedAt, finishedAt, steps, consoleErrors, pageErrors, failedRequests, httpErrors, screenshotPath, reportPath: path.join(directory, 'interaction-report.json') };
      await writeFile(report.reportPath, JSON.stringify(report, null, 2), 'utf8');
      return report;
    });
  }

  async auditVisualA11y(input: VisualA11yAuditInput): Promise<VisualA11yAuditReport> {
    const base = assertLocalhostUrl(input.baseUrl);
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const routes = input.routes.length ? input.routes : ['/'];
    const colorSchemes: ColorSchemeMode[] = input.colorSchemes.length ? [...new Set(input.colorSchemes)] : ['light', 'dark'];
    const profiles = input.viewports.length ? input.viewports : DEFAULT_VISUAL_A11Y_VIEWPORTS;
    const evidenceDirectory = path.resolve(input.evidenceDirectory);
    await mkdir(evidenceDirectory, { recursive: true });

    const { chromium } = await import('playwright');
    const { AxeBuilder } = await import('@axe-core/playwright');

    return sharedPool.runWithBrowser(chromium, async browser => {
      const tasks: Array<{ route: string; targetUrl: URL; colorScheme: ColorSchemeMode; viewport: ViewportProfile }> = [];
      for (const routeValue of routes) {
        const route = safeRoute(routeValue);
        const targetUrl = new URL(route, base);
        if (targetUrl.origin !== base.origin) throw new Error('Route escaped the configured localhost origin.');
        for (const colorScheme of colorSchemes) {
          for (const viewport of profiles) {
            tasks.push({ route, targetUrl, colorScheme, viewport });
          }
        }
      }

      let themeToggleCheck: ThemeToggleVerification | null = null;

      const results: VisualA11yCaseResult[] = await mapConcurrent(tasks, 2, async ({ route, targetUrl, colorScheme, viewport }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          screen: { width: viewport.width, height: viewport.height },
          isMobile: viewport.isMobile,
          hasTouch: viewport.hasTouch,
          deviceScaleFactor: viewport.deviceScaleFactor,
          colorScheme,
          serviceWorkers: 'block',
          bypassCSP: true
        });
        await context.tracing.start({ screenshots: true, snapshots: true });
        await context.route('**/*', async routeRequest => {
          if (!routeRequest.request().isNavigationRequest()) { await routeRequest.continue(); return; }
          try {
            const navigationUrl = new URL(routeRequest.request().url());
            const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(navigationUrl.hostname);
            if (!isLoopback || navigationUrl.origin !== base.origin) { await routeRequest.abort('blockedbyclient'); return; }
            await routeRequest.continue();
          } catch { await routeRequest.abort('blockedbyclient'); }
        });

        await installWebGLTracker(context);
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        const shaderWarnings: string[] = [];
        const pageErrors: string[] = [];
        page.on('console', message => {
          const text = message.text();
          if (message.type() === 'error') consoleErrors.push(text);
          if ((message.type() === 'error' || message.type() === 'warning') && WEBGL_SHADER_WARNING_PATTERN.test(text)) {
            shaderWarnings.push(text);
          }
        });
        page.on('pageerror', error => pageErrors.push(error.message));

        const caseDirectory = path.join(evidenceDirectory, runId, slug(route), colorScheme, viewport.name);
        await mkdir(caseDirectory, { recursive: true });
        const screenshotPath = path.join(caseDirectory, `${colorScheme}.png`);
        const ariaSnapshotPath = path.join(caseDirectory, 'aria-snapshot.yml');

        const issues: string[] = [];
        let axeViolations: VisualA11yCaseResult['axeViolations'] = [];
        let contrastIssues: VisualA11yCaseResult['contrastIssues'] = [];
        let incompleteContrast: VisualA11yCaseResult['incompleteContrast'] = [];
        let typographyIssues: VisualA11yCaseResult['typographyIssues'] = [];
        let targetSizeIssues: VisualA11yCaseResult['targetSizeIssues'] = [];
        let occlusionIssues: VisualA11yCaseResult['occlusionIssues'] = [];
        let polarityIssues: VisualA11yCaseResult['polarityIssues'] = [];
        let reducedMotionHiddenCount = 0;
        let fontErrors: string[] = [];
        let clsScore: number | null = null;
        let cdpMetrics: VisualA11yCaseResult['cdpMetrics'] = null;
        let tracePath: string | null = null;

        try {
          const response = await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs });
          await page.waitForLoadState('networkidle', { timeout: Math.min(input.timeoutMs, 3000) }).catch(() => undefined);
          await page.evaluate(async () => { if ('fonts' in document) await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1500))]); });

          const finalUrl = new URL(page.url());
          if (finalUrl.origin !== base.origin) throw new Error(`Navigation escaped localhost origin: ${finalUrl.origin}`);
          if (response && response.status() >= 400) issues.push(`Route returned HTTP ${response.status()}.`);

          try {
            const cdp = await context.newCDPSession(page);
            await cdp.send('Performance.enable').catch(() => {});
            const perfData = await cdp.send('Performance.getMetrics').catch(() => null);
            if (perfData?.metrics) {
              const m = new Map(perfData.metrics.map(x => [x.name, x.value]));
              cdpMetrics = {
                jsHeapUsedSize: m.get('JSHeapUsedSize'),
                jsHeapTotalSize: m.get('JSHeapTotalSize'),
                nodes: m.get('Nodes'),
                layoutCount: m.get('LayoutCount'),
                recalcStyleCount: m.get('RecalcStyleCount')
              };
            }
            await cdp.detach().catch(() => {});
          } catch {
            // CDP fallback
          }

          const axeResults = await new AxeBuilder({ page: page as any })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze();
          const extracted = extractAxeFindings(axeResults as any);
          axeViolations = extracted.axeViolations;

          const domMetrics = await page.evaluate(evaluateDomVisualA11y, {
            colorScheme,
            expectedSectionPolarity: input.expectedSectionPolarity
          });

          contrastIssues = [...extracted.axeContrastIssues, ...domMetrics.contrastIssues];
          incompleteContrast = extracted.incompleteContrast;
          typographyIssues = domMetrics.typographyIssues;
          targetSizeIssues = domMetrics.targetSizeIssues;
          occlusionIssues = domMetrics.occlusionIssues;
          polarityIssues = domMetrics.polarityIssues;
          fontErrors = domMetrics.fontErrors;
          clsScore = domMetrics.clsScore;

          const ariaYaml = await page.locator('body').ariaSnapshot({ mode: 'ai', boxes: true }).catch(() => '');
          await writeFile(ariaSnapshotPath, ariaYaml || '# ariaSnapshot unavailable', 'utf8');

          await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });

          if (input.testReducedMotion) {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.waitForTimeout(100);
            reducedMotionHiddenCount = await page.evaluate(() => {
              let hidden = 0;
              for (const el of Array.from(document.querySelectorAll<HTMLElement>('h1, h2, main > section, [data-reveal]'))) {
                const s = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                if (s.display !== 'none' && rect.height > 10 && (Number(s.opacity) === 0 || s.visibility === 'hidden')) {
                  hidden++;
                }
              }
              return hidden;
            });
          }

          const webglAudit = await auditWebGLCanvases(page, shaderWarnings);
          for (const webglIssue of webglAudit.issues) issues.push(`[${colorScheme}] ${webglIssue}`);

          if (axeViolations.length > 0) issues.push(`[${colorScheme}] ${axeViolations.length} axe-core WCAG violation rule(s).`);
          if (domMetrics.contrastIssues.length > 0) issues.push(`[${colorScheme}] ${domMetrics.contrastIssues.length} rendered low-contrast/invisible text pair(s).`);
          if (occlusionIssues.length > 0) issues.push(`[${colorScheme}] ${occlusionIssues.length} interactive control(s) occluded by another layer.`);
          if (targetSizeIssues.length > 0) issues.push(`[${colorScheme}] ${targetSizeIssues.length} interactive target(s) smaller than 24x24 CSS px.`);
          if (polarityIssues.length > 0) issues.push(`[${colorScheme}] ${polarityIssues.length} section(s) violated expected follow-active-theme polarity.`);
          if (typographyIssues.some(item => item.kind === 'clipped-text' || item.kind === 'tiny-text')) {
            issues.push(`[${colorScheme}] Typography clipping or sub-11px text detected.`);
          }
          if (fontErrors.length > 0) issues.push(`[${colorScheme}] Webfont load errors: ${fontErrors.join(', ')}`);
          if (reducedMotionHiddenCount > 0) issues.push(`[${colorScheme}] ${reducedMotionHiddenCount} primary section/heading(s) remained hidden under prefers-reduced-motion: reduce.`);
          if (consoleErrors.length > 0) issues.push(`[${colorScheme}] ${consoleErrors.length} console error(s).`);
          if (pageErrors.length > 0) issues.push(`[${colorScheme}] ${pageErrors.length} uncaught page error(s).`);
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
          await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
          await writeFile(ariaSnapshotPath, '# ariaSnapshot skipped due to error', 'utf8').catch(() => undefined);
        } finally {
          if (issues.length > 0) {
            tracePath = path.join(caseDirectory, 'trace.zip');
            await context.tracing.stop({ path: tracePath }).catch(() => {});
          } else {
            await context.tracing.stop().catch(() => {});
          }
          await context.close();
        }

        const passed = issues.length === 0;
        return {
          route,
          colorScheme,
          viewport,
          finalUrl: targetUrl.href,
          axeViolations,
          contrastIssues,
          incompleteContrast,
          typographyIssues,
          targetSizeIssues,
          occlusionIssues,
          polarityIssues,
          reducedMotionHiddenCount,
          fontErrors,
          clsScore,
          ariaSnapshotPath,
          screenshotPath,
          tracePath,
          cdpMetrics,
          consoleErrors,
          pageErrors,
          passed,
          issues
        };
      });

      // Optional interactive theme-toggle verification on the first route
      if (input.themeToggleSelector) {
        const toggleContext = await browser.newContext({ colorScheme: colorSchemes[0] ?? 'light', serviceWorkers: 'block', bypassCSP: true });
        const togglePage = await toggleContext.newPage();
        try {
          const firstUrl = new URL(safeRoute(routes[0] ?? '/'), base);
          await togglePage.goto(firstUrl.href, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs });
          const readThemeState = () => togglePage.evaluate(() => {
            const root = document.documentElement;
            const bodyBg = getComputedStyle(document.body).backgroundColor;
            return JSON.stringify({
              dataTheme: root.getAttribute('data-theme'),
              className: root.className,
              colorScheme: getComputedStyle(root).colorScheme,
              bodyBg
            });
          });
          const beforeState = await readThemeState();
          await togglePage.locator(input.themeToggleSelector).first().click({ timeout: input.timeoutMs });
          await togglePage.waitForTimeout(150);
          const afterState = await readThemeState();
          const changed = beforeState !== afterState;
          themeToggleCheck = {
            tested: true,
            selector: input.themeToggleSelector,
            changed,
            beforeState,
            afterState,
            detail: changed
              ? 'Theme toggle updated root theme state or computed background.'
              : 'Theme toggle click produced no observable DOM or background change.'
          };
        } catch (error) {
          themeToggleCheck = {
            tested: true,
            selector: input.themeToggleSelector,
            changed: false,
            beforeState: 'unknown',
            afterState: 'unknown',
            detail: `Theme toggle test failed: ${error instanceof Error ? error.message : String(error)}`
          };
        } finally {
          await toggleContext.close();
        }
      }

      const finishedAt = new Date().toISOString();
      const passedCases = results.filter(item => item.passed).length;
      const totalContrastViolations = results.reduce((sum, item) => sum + item.contrastIssues.length, 0);
      const totalAxeViolations = results.reduce((sum, item) => sum + item.axeViolations.length, 0);
      const totalIncompleteContrast = results.reduce((sum, item) => sum + item.incompleteContrast.length, 0);
      const toggleFailed = themeToggleCheck !== null && !themeToggleCheck.changed;
      const report: VisualA11yAuditReport = {
        runId,
        baseUrl: base.href,
        startedAt,
        finishedAt,
        testedColorSchemes: colorSchemes,
        totalCases: results.length,
        passedCases,
        failedCases: results.length - passedCases,
        totalContrastViolations,
        totalAxeViolations,
        totalIncompleteContrast,
        themeToggleCheck,
        overallStatus: passedCases === results.length && !toggleFailed ? 'pass' : 'fail',
        results,
        reportPath: path.join(evidenceDirectory, runId, 'visual-a11y-report.json')
      };
      await mkdir(path.dirname(report.reportPath), { recursive: true });
      await writeFile(report.reportPath, JSON.stringify(report, null, 2), 'utf8');
      return report;
    });
  }
}

export { DEFAULT_VIEWPORTS };
