import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../src/application/task-service.js';
import { EMPTY_STATE, type HarnessState } from '../src/domain/models.js';
import type { StateRepository } from '../src/domain/ports.js';
import { toVisualA11yAuditInput } from '../src/interfaces/mcp/input-normalizers.js';
import { extractAxeFindings } from '../src/infrastructure/browser/visual-a11y-evaluator.js';
import { PlaywrightInspector } from '../src/infrastructure/browser/playwright-inspector.js';

class MemoryRepository implements StateRepository {
  private state: HarnessState = structuredClone(EMPTY_STATE);
  async read(): Promise<HarnessState> { return structuredClone(this.state); }
  async transact<T>(operation: (state: HarnessState) => T | Promise<T>): Promise<T> {
    return operation(this.state);
  }
}

test('toVisualA11yAuditInput omits undefined optional properties', () => {
  const normalized = toVisualA11yAuditInput({
    baseUrl: 'http://127.0.0.1:3000',
    routes: ['/'],
    colorSchemes: ['light', 'dark'],
    testReducedMotion: true,
    evidenceDirectory: 'evidence',
    timeoutMs: 15000
  });

  assert.equal('expectedSectionPolarity' in normalized, false);
  assert.equal('themeToggleSelector' in normalized, false);
  assert.deepEqual(normalized.viewports, []);
});

test('toVisualA11yAuditInput preserves provided optional properties', () => {
  const normalized = toVisualA11yAuditInput({
    baseUrl: 'http://127.0.0.1:3000',
    routes: ['/'],
    colorSchemes: ['light'],
    viewports: [{ name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }],
    expectedSectionPolarity: 'follow-active-theme',
    themeToggleSelector: '[data-testid="theme-toggle"]',
    testReducedMotion: false,
    evidenceDirectory: 'evidence',
    timeoutMs: 15000
  });

  assert.equal(normalized.expectedSectionPolarity, 'follow-active-theme');
  assert.equal(normalized.themeToggleSelector, '[data-testid="theme-toggle"]');
  assert.equal(normalized.viewports.length, 1);
});

test('typography-color and accessibility checkpoints block screenshot-only, responsive-only, and failing visual-a11y reports', async () => {
  const service = new TaskService(new MemoryRepository());
  const created = await service.createPlan({
    title: 'Dual theme web app',
    request: 'Build a responsive dual-theme frontend website'
  });

  const screenshotEv = await service.recordEvidence({
    planId: created.plan.id,
    taskId: null,
    kind: 'screenshot',
    title: 'Dark mode screenshot',
    description: 'Only a screenshot',
    path: 'tests/fixtures/review-evidence.md',
    uri: null,
    metadata: {},
    createdBy: 'qa'
  });
  await assert.rejects(
    () => service.updateCheckpoint(created.plan.id, 'typography-color', 'pass', [screenshotEv.id], null),
    /screenshot evidence alone/i
  );

  const responsiveEv = await service.recordEvidence({
    planId: created.plan.id,
    taskId: null,
    kind: 'browser-report',
    title: 'Responsive inspection',
    description: 'Overflow check only',
    path: 'tests/fixtures/review-evidence.md',
    uri: null,
    metadata: { overallStatus: 'pass', results: [] },
    createdBy: 'responsive-qa'
  });
  await assert.rejects(
    () => service.updateCheckpoint(created.plan.id, 'accessibility', 'pass', [responsiveEv.id], null),
    /responsive\/interaction browser reports alone/i
  );

  const failingVisualEv = await service.recordEvidence({
    planId: created.plan.id,
    taskId: null,
    kind: 'browser-report',
    title: 'Visual audit fail',
    description: 'Black text on black background in light mode',
    path: 'tests/fixtures/review-evidence.md',
    uri: null,
    metadata: {
      auditType: 'visual-a11y',
      overallStatus: 'fail',
      totalContrastViolations: 1,
      totalAxeViolations: 1,
      testedColorSchemes: ['light', 'dark'],
      expectedColorSchemes: ['light', 'dark']
    },
    createdBy: 'a11y-qa'
  });
  await assert.rejects(
    () => service.updateCheckpoint(created.plan.id, 'typography-color', 'pass', [failingVisualEv.id], null),
    /visual-a11y audit reports failures/i
  );

  const partialSchemeEv = await service.recordEvidence({
    planId: created.plan.id,
    taskId: null,
    kind: 'browser-report',
    title: 'Dark-only audit',
    description: 'Only tested dark scheme',
    path: 'tests/fixtures/review-evidence.md',
    uri: null,
    metadata: {
      auditType: 'visual-a11y',
      overallStatus: 'pass',
      totalContrastViolations: 0,
      totalAxeViolations: 0,
      testedColorSchemes: ['dark'],
      expectedColorSchemes: ['light', 'dark']
    },
    createdBy: 'a11y-qa'
  });
  await assert.rejects(
    () => service.updateCheckpoint(created.plan.id, 'accessibility', 'pass', [partialSchemeEv.id], null),
    /did not test all expected color schemes/i
  );

  const passingVisualEv = await service.recordEvidence({
    planId: created.plan.id,
    taskId: null,
    kind: 'browser-report',
    title: 'Dual theme pass',
    description: 'Both light and dark schemes passed',
    path: 'tests/fixtures/review-evidence.md',
    uri: null,
    metadata: {
      auditType: 'visual-a11y',
      overallStatus: 'pass',
      totalContrastViolations: 0,
      totalAxeViolations: 0,
      testedColorSchemes: ['light', 'dark'],
      expectedColorSchemes: ['light', 'dark']
    },
    createdBy: 'a11y-qa'
  });
  const passed = await service.updateCheckpoint(created.plan.id, 'typography-color', 'pass', [passingVisualEv.id], null);
  assert.equal(passed.status, 'pass');
});

test('extractAxeFindings maps color-contrast violations and incomplete bgImage items accurately', () => {
  const parsed = extractAxeFindings({
    violations: [
      {
        id: 'color-contrast',
        impact: 'serious',
        help: 'Elements must meet minimum color contrast ratio thresholds',
        description: 'Contrast check',
        nodes: [
          {
            target: ['.badge-webgl'],
            failureSummary: 'Fix contrast',
            any: [{ data: { fgColor: '#111111', bgColor: '#16181a', contrastRatio: 1.07, expectedContrastRatio: '4.5:1', fontSize: '12.0px' } }]
          }
        ]
      }
    ],
    incomplete: [
      {
        id: 'color-contrast',
        nodes: [
          {
            target: ['.hero-hud'],
            any: [{ data: { missingData: 'bgImage', fgColor: '#ffffff' } }]
          }
        ]
      }
    ]
  });

  assert.equal(parsed.axeViolations.length, 1);
  assert.equal(parsed.axeContrastIssues.length, 1);
  assert.equal(parsed.axeContrastIssues[0]!.ratio, 1.07);
  assert.equal(parsed.incompleteContrast.length, 1);
  assert.match(parsed.incompleteContrast[0]!.reason, /bgImage/);
});

test('PlaywrightInspector.auditVisualA11y detects light-mode black-on-black badge and passes when fixed with light-dark()', async t => {
  const brokenHtml = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Test Showcase</title>
      <style>
        :root { color-scheme: light dark; --ink: #111111; }
        @media (prefers-color-scheme: dark) { :root { --ink: #f4f4f5; } }
        body { margin: 0; font-family: sans-serif; background: #ffffff; color: #111111; }
        .dark-band { background: #16181a; color: #f4f4f5; padding: 32px; min-height: 200px; }
        .badge { display: inline-block; padding: 6px 10px; background: #202326; color: var(--ink); font-size: 12px; border: 1px solid #333; }
      </style>
    </head>
    <body>
      <main>
        <section class="dark-band" data-surface="dark">
          <span class="badge">WEBGL · 60 FPS</span>
          <h1>Interactive 3D Garment Inspection</h1>
        </section>
      </main>
    </body>
  </html>`;

  const fixedHtml = `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Test Showcase Fixed</title>
      <style>
        :root { color-scheme: light dark; --surface-bg: light-dark(#ffffff, #111315); --ink: light-dark(#111111, #f4f4f5); --badge-bg: light-dark(#f1f5f9, #202326); }
        body { margin: 0; font-family: sans-serif; background: var(--surface-bg); color: var(--ink); }
        .adaptive-band { background: var(--surface-bg); color: var(--ink); padding: 32px; min-height: 200px; }
        .badge { display: inline-block; padding: 6px 10px; background: var(--badge-bg); color: var(--ink); font-size: 12px; border: 1px solid light-dark(#cbd5e1, #3f3f46); }
      </style>
    </head>
    <body>
      <main>
        <section class="adaptive-band">
          <span class="badge">WEBGL · 60 FPS</span>
          <h1>Interactive 3D Garment Inspection</h1>
        </section>
      </main>
    </body>
  </html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/fixed' ? fixedHtml : brokenHtml);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'craftrig-visual-a11y-'));

  try {
    const inspector = new PlaywrightInspector();
    const singleViewport = [{ name: 'laptop-1280', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }];

    let brokenReport;
    try {
      brokenReport = await inspector.auditVisualA11y({
        baseUrl,
        routes: ['/'],
        colorSchemes: ['light', 'dark'],
        viewports: singleViewport,
        testReducedMotion: true,
        evidenceDirectory: tempDir,
        timeoutMs: 15000
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/Executable doesn't exist|browserType\.launch|Failed to launch/i.test(msg)) {
        t.skip(`Chromium unavailable in environment: ${msg}`);
        return;
      }
      throw error;
    }

    const lightCase = brokenReport.results.find(r => r.colorScheme === 'light')!;
    const darkCase = brokenReport.results.find(r => r.colorScheme === 'dark')!;
    assert.equal(brokenReport.overallStatus, 'fail');
    assert.equal(lightCase.passed, false);
    assert.ok(lightCase.contrastIssues.length > 0, 'Light mode must catch black-on-black badge');
    assert.equal(darkCase.passed, true, 'Dark mode looks fine just like user screenshot');

    const fixedReport = await inspector.auditVisualA11y({
      baseUrl,
      routes: ['/fixed'],
      colorSchemes: ['light', 'dark'],
      viewports: singleViewport,
      expectedSectionPolarity: 'follow-active-theme',
      testReducedMotion: true,
      evidenceDirectory: tempDir,
      timeoutMs: 15000
    });
    assert.equal(fixedReport.overallStatus, 'pass');
    assert.equal(fixedReport.totalContrastViolations, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});
