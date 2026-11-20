import type { BrowserContext, Page } from 'playwright';

export const WEBGL_SHADER_WARNING_PATTERN = /THREE\.WebGLProgram|Shader Error|GL_INVALID|WebGL.*CONTEXT_LOST/i;

const WEBGL_INIT_SCRIPT = () => {
  const trackerKey = '__craftrigWebGLContexts';
  const globalAny = window as unknown as Record<string, unknown>;
  if (!Array.isArray(globalAny[trackerKey])) {
    globalAny[trackerKey] = [];
  }
  const tracked = globalAny[trackerKey] as Array<{ canvas: HTMLCanvasElement; gl: WebGLRenderingContext | WebGL2RenderingContext }>;
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
    options?: unknown
  ) {
    const ctx = origGetContext.call(this, contextId as any, options as any);
    if (
      ctx &&
      (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') &&
      !tracked.some(item => item.canvas === this)
    ) {
      tracked.push({ canvas: this, gl: ctx as WebGLRenderingContext | WebGL2RenderingContext });
    }
    return ctx;
  } as typeof HTMLCanvasElement.prototype.getContext;
};

export async function installWebGLTracker(context: BrowserContext): Promise<void> {
  await context.addInitScript(WEBGL_INIT_SCRIPT);
}

export interface WebGLAuditSummary {
  webglContextCount: number;
  contextLost: boolean;
  blankCanvasCount: number;
  issues: string[];
}

export async function auditWebGLCanvases(
  page: Page,
  shaderWarnings: readonly string[]
): Promise<WebGLAuditSummary> {
  const issues: string[] = [];

  const inspected = await page.evaluate(() => {
    const tracked = ((window as unknown as Record<string, unknown>).__craftrigWebGLContexts ?? []) as Array<{
      canvas: HTMLCanvasElement;
      gl: WebGLRenderingContext | WebGL2RenderingContext;
    }>;

    let contextLost = false;
    const probeIds: string[] = [];

    for (let i = 0; i < tracked.length; i++) {
      const entry = tracked[i];
      if (!entry) continue;
      const { canvas, gl } = entry;
      try {
        if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
          contextLost = true;
        }
      } catch {
        // Ignore gl state read failure
      }

      const style = getComputedStyle(canvas);
      const rect = canvas.getBoundingClientRect();
      if (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0.01 &&
        rect.width >= 24 &&
        rect.height >= 24 &&
        probeIds.length < 4
      ) {
        const probeId = `craftrig-webgl-${i}`;
        canvas.setAttribute('data-craftrig-webgl-id', probeId);
        probeIds.push(probeId);
      }
    }

    return {
      webglContextCount: tracked.length,
      contextLost,
      probeIds
    };
  }).catch(() => ({ webglContextCount: 0, contextLost: false, probeIds: [] as string[] }));

  if (inspected.contextLost) {
    issues.push('WebGL context lost detected on one or more canvas elements.');
  }
  if (inspected.webglContextCount > 4) {
    issues.push(
      `WebGL multi-context defect: ${inspected.webglContextCount} simultaneous WebGL contexts detected; consolidate into a single WebGLRenderer with setScissor()/setViewport() to avoid context loss.`
    );
  }
  if (shaderWarnings.length > 0) {
    issues.push(`WebGL/Three.js shader or GL error detected: ${shaderWarnings[0]}`);
  }

  let blankCanvasCount = 0;
  if (inspected.probeIds.length > 0) {
    for (const probeId of inspected.probeIds) {
      try {
        const locator = page.locator(`canvas[data-craftrig-webgl-id="${probeId}"]`).first();
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(80);
        const buffer = await locator.screenshot({ animations: 'disabled' });
        const base64 = buffer.toString('base64');
        const isBlank = await page.evaluate(async b64 => {
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Failed to decode canvas screenshot'));
            img.src = `data:image/png;base64,${b64}`;
          });
          const sample = document.createElement('canvas');
          sample.width = 24;
          sample.height = 24;
          const ctx = sample.getContext('2d');
          if (!ctx) return false;
          ctx.drawImage(img, 0, 0, 24, 24);
          const pixels = ctx.getImageData(0, 0, 24, 24).data;
          const r0 = pixels[0] ?? 0;
          const g0 = pixels[1] ?? 0;
          const b0 = pixels[2] ?? 0;
          const a0 = pixels[3] ?? 0;
          for (let i = 4; i < pixels.length; i += 4) {
            if (
              Math.abs((pixels[i] ?? 0) - r0) > 4 ||
              Math.abs((pixels[i + 1] ?? 0) - g0) > 4 ||
              Math.abs((pixels[i + 2] ?? 0) - b0) > 4 ||
              Math.abs((pixels[i + 3] ?? 0) - a0) > 4
            ) {
              return false;
            }
          }
          return true;
        }, base64);
        if (isBlank) blankCanvasCount++;
      } catch {
        // Ignore individual canvas capture failure when node is detached or animating out
      }
    }

    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
    if (blankCanvasCount > 0) {
      issues.push(
        `Blank WebGL canvas defect: ${blankCanvasCount} visible WebGL canvas(es) rendered a completely uniform/empty frame.`
      );
    }
  }

  return {
    webglContextCount: inspected.webglContextCount,
    contextLost: inspected.contextLost,
    blankCanvasCount,
    issues
  };
}
