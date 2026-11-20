import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlaywrightInspector } from '../src/infrastructure/browser/playwright-inspector.js';

test('PlaywrightInspector catches multi-context (>4) and blank WebGL canvases while passing rendered WebGL frames', async t => {
  const multiContextHtml = `<!doctype html>
  <html><body>
    ${Array.from({ length: 5 }, (_, i) => `<canvas id="c${i}" width="64" height="64"></canvas>`).join('')}
    <script>
      for (let i = 0; i < 5; i++) {
        const gl = document.getElementById('c' + i).getContext('webgl2') || document.getElementById('c' + i).getContext('webgl');
        if (gl) {
          gl.clearColor(0.2, 0.4, 0.8, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      }
    </script>
  </body></html>`;

  const blankCanvasHtml = `<!doctype html>
  <html><body>
    <canvas id="blank" width="120" height="120"></canvas>
    <script>
      const gl = document.getElementById('blank').getContext('webgl2') || document.getElementById('blank').getContext('webgl');
      if (gl) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    </script>
  </body></html>`;

  const renderedCanvasHtml = `<!doctype html>
  <html><body style="background:#f5f2eb;margin:0;padding:16px;">
    <canvas id="ok" width="120" height="120" style="display:block;"></canvas>
    <script>
      const gl = document.getElementById('ok').getContext('webgl2') || document.getElementById('ok').getContext('webgl');
      if (gl) {
        gl.clearColor(0.95, 0.94, 0.91, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(24, 24, 72, 72);
        gl.clearColor(0.12, 0.14, 0.18, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    </script>
  </body></html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/multi') res.end(multiContextHtml);
    else if (req.url === '/blank') res.end(blankCanvasHtml);
    else res.end(renderedCanvasHtml);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'craftrig-webgl-audit-'));

  try {
    const inspector = new PlaywrightInspector();
    const viewport = [{ name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }];

    let report;
    try {
      report = await inspector.inspectResponsive({
        baseUrl,
        routes: ['/multi', '/blank', '/ok'],
        viewports: viewport,
        evidenceDirectory: tempDir,
        timeoutMs: 15000,
        allowedOverflowSelectors: []
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/Executable doesn't exist|browserType\.launch|Failed to launch/i.test(msg)) {
        t.skip(`Chromium unavailable in environment: ${msg}`);
        return;
      }
      throw error;
    }

    const multi = report.results.find(r => r.route === '/multi')!;
    const blank = report.results.find(r => r.route === '/blank')!;
    const ok = report.results.find(r => r.route === '/ok')!;

    assert.equal(multi.passed, false);
    assert.ok(multi.issues.some(i => /multi-context defect/i.test(i)), `Expected multi-context issue, got: ${multi.issues.join('; ')}`);

    assert.equal(blank.passed, false);
    assert.ok(blank.issues.some(i => /Blank WebGL canvas defect/i.test(i)), `Expected blank canvas issue, got: ${blank.issues.join('; ')}`);

    assert.equal(ok.passed, true, `Expected /ok to pass, got: ${ok.issues.join('; ')}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});
