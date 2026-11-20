import type {
  AxeViolationSummary,
  ColorSchemeMode,
  ContrastDefect,
  IncompleteContrastItem,
  OcclusionIssue,
  PolarityMismatchIssue,
  SectionPolarityMode,
  TargetSizeIssue,
  TypographyIssue
} from '../../domain/ports.js';

export interface DomVisualA11yMetrics {
  contrastIssues: ContrastDefect[];
  typographyIssues: TypographyIssue[];
  targetSizeIssues: TargetSizeIssue[];
  occlusionIssues: OcclusionIssue[];
  polarityIssues: PolarityMismatchIssue[];
  fontErrors: string[];
  clsScore: number | null;
}

/**
 * Self-contained DOM evaluator injected into Playwright `page.evaluate`.
 * Kept free of external imports so Playwright serialization succeeds directly.
 */
export function evaluateDomVisualA11y(params: {
  colorScheme: ColorSchemeMode;
  expectedSectionPolarity: SectionPolarityMode | undefined;
}): DomVisualA11yMetrics {
  const { colorScheme, expectedSectionPolarity } = params;

  const describeElement = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const classes = el.classList.length
      ? `.${Array.from(el.classList).slice(0, 2).join('.')}`
      : '';
    return `${tag}${id}${classes}`;
  };

  type Rgba = [number, number, number, number];
  const colorCache = new Map<string, Rgba>();
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const parseColor = (cssColor: string): Rgba => {
    const cached = colorCache.get(cssColor);
    if (cached) return cached;

    if (!cssColor || cssColor === 'transparent') {
      const zero: Rgba = [0, 0, 0, 0];
      colorCache.set(cssColor, zero);
      return zero;
    }

    const rgbMatch = cssColor.match(
      /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/i
    );
    if (rgbMatch) {
      const r = Math.min(255, Math.max(0, Number(rgbMatch[1])));
      const g = Math.min(255, Math.max(0, Number(rgbMatch[2])));
      const b = Math.min(255, Math.max(0, Number(rgbMatch[3])));
      let a = 1;
      if (rgbMatch[4] !== undefined) {
        a = rgbMatch[4].endsWith('%')
          ? parseFloat(rgbMatch[4]) / 100
          : parseFloat(rgbMatch[4]);
      }
      const parsed: Rgba = [r, g, b, Math.min(1, Math.max(0, a))];
      colorCache.set(cssColor, parsed);
      return parsed;
    }

    // Fallback via 2D canvas handles oklch(), lab(), color(srgb ...), light-dark(), color-mix()
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0)';
      ctx.fillStyle = cssColor;
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      const parsed: Rgba = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, (data[3] ?? 0) / 255];
      colorCache.set(cssColor, parsed);
      return parsed;
    }

    return [0, 0, 0, 1];
  };

  const compositeOver = (fg: Rgba, bg: Rgba): Rgba => {
    const aFg = fg[3];
    const aBg = bg[3];
    const outA = aFg + aBg * (1 - aFg);
    if (outA <= 0) return [0, 0, 0, 0];
    const r = (fg[0] * aFg + bg[0] * aBg * (1 - aFg)) / outA;
    const g = (fg[1] * aFg + bg[1] * aBg * (1 - aFg)) / outA;
    const b = (fg[2] * aFg + bg[2] * aBg * (1 - aFg)) / outA;
    return [r, g, b, outA];
  };

  const relativeLuminance = (rgba: Rgba): number => {
    const channel = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgba[0]) + 0.7152 * channel(rgba[1]) + 0.0722 * channel(rgba[2]);
  };

  const contrastRatio = (a: Rgba, b: Rgba): number => {
    const l1 = relativeLuminance(a);
    const l2 = relativeLuminance(b);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  };

  const formatRgb = (rgba: Rgba): string =>
    `rgb(${Math.round(rgba[0])}, ${Math.round(rgba[1])}, ${Math.round(rgba[2])})`;

  const isVisible = (el: HTMLElement): { visible: boolean; style: CSSStyleDeclaration; rect: DOMRect } => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible =
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) > 0.01 &&
      rect.width > 0.5 &&
      rect.height > 0.5 &&
      !el.closest('[aria-hidden="true"], [inert]');
    return { visible, style, rect };
  };

  const resolveEffectiveBackground = (el: Element): { color: Rgba; hasBackgroundImage: boolean } => {
    const chain: Element[] = [];
    let current: Element | null = el;
    while (current) {
      chain.push(current);
      current = current.parentElement;
    }
    chain.reverse();

    const defaultCanvas: Rgba = colorScheme === 'dark' ? [10, 10, 12, 1] : [255, 255, 255, 1];
    let backdrop: Rgba = defaultCanvas;
    let hasBackgroundImage = false;

    for (const node of chain) {
      const s = getComputedStyle(node);
      if (s.backgroundImage && s.backgroundImage !== 'none') {
        hasBackgroundImage = true;
      }
      const bg = parseColor(s.backgroundColor);
      const nodeOpacity = Math.min(1, Math.max(0, Number(s.opacity) || 1));
      if (bg[3] > 0) {
        const scaledBg: Rgba = [bg[0], bg[1], bg[2], bg[3] * nodeOpacity];
        backdrop = compositeOver(scaledBg, backdrop);
      }
    }

    return { color: backdrop, hasBackgroundImage };
  };

  const resolveEffectiveForeground = (el: HTMLElement, style: CSSStyleDeclaration, bg: Rgba): Rgba => {
    let fg = parseColor(style.color);
    let opacityProduct = 1;
    let current: Element | null = el;
    while (current) {
      const op = Number(getComputedStyle(current).opacity);
      if (Number.isFinite(op)) opacityProduct *= op;
      current = current.parentElement;
    }
    fg = [fg[0], fg[1], fg[2], fg[3] * Math.min(1, Math.max(0, opacityProduct))];
    return compositeOver(fg, bg);
  };

  const contrastIssues: ContrastDefect[] = [];
  const typographyIssues: TypographyIssue[] = [];
  const targetSizeIssues: TargetSizeIssue[] = [];
  const occlusionIssues: OcclusionIssue[] = [];
  const polarityIssues: PolarityMismatchIssue[] = [];

  const allElements = Array.from(document.querySelectorAll<HTMLElement>('body *'));

  for (const el of allElements) {
    const { visible, style, rect } = isVisible(el);
    if (!visible) continue;

    // Only inspect elements that directly own non-whitespace text nodes
    const hasDirectText = Array.from(el.childNodes).some(
      node => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
    );

    if (hasDirectText) {
      const textSample = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const { color: bg, hasBackgroundImage } = resolveEffectiveBackground(el);
      const fg = resolveEffectiveForeground(el, style, bg);
      const fontSizePx = parseFloat(style.fontSize) || 16;
      const fontWeight = parseInt(style.fontWeight, 10) || 400;
      const isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
      const requiredRatio = isLargeText ? 3.0 : 4.5;
      const ratio = contrastRatio(fg, bg);

      // Flag deterministic low-contrast pairs (skip indeterminate pure-image backgrounds unless near-zero fg-vs-bg)
      if ((!hasBackgroundImage && ratio < requiredRatio) || ratio < 1.5) {
        if (contrastIssues.length < 40) {
          contrastIssues.push({
            selector: describeElement(el),
            textSample,
            foreground: formatRgb(fg),
            background: formatRgb(bg),
            ratio: Math.round(ratio * 100) / 100,
            requiredRatio,
            fontSizePx: Math.round(fontSizePx * 10) / 10,
            isLargeText,
            source: 'dom-composited'
          });
        }
      }

      // Typography readability checks
      if (fontSizePx < 11 && typographyIssues.length < 30) {
        typographyIssues.push({
          selector: describeElement(el),
          kind: 'tiny-text',
          detail: `Computed font-size is ${Math.round(fontSizePx * 10) / 10}px (< 11px) for "${textSample}".`
        });
      }

      if (
        ['hidden', 'clip'].includes(style.overflowY) &&
        el.scrollHeight > el.clientHeight + 3 &&
        el.clientHeight > 0 &&
        typographyIssues.length < 30
      ) {
        typographyIssues.push({
          selector: describeElement(el),
          kind: 'clipped-text',
          detail: `Text clipped vertically (scrollHeight ${el.scrollHeight}px > clientHeight ${el.clientHeight}px) on "${textSample}".`
        });
      }

      if (el.tagName === 'P' && textSample.length >= 60 && rect.width > fontSizePx * 65 && typographyIssues.length < 30) {
        typographyIssues.push({
          selector: describeElement(el),
          kind: 'wide-measure',
          detail: `Paragraph line measure (~${Math.round(rect.width / (fontSizePx * 0.5))}ch) exceeds comfortable reading width.`
        });
      }
    }

    // Target size & occlusion for interactive controls
    const isInteractive = el.matches(
      'button, [role="button"], input:not([type="hidden"]), select, textarea, nav a[href], header a[href], a.btn, a.button'
    );
    if (isInteractive) {
      if ((rect.width < 24 || rect.height < 24) && targetSizeIssues.length < 25) {
        targetSizeIssues.push({
          selector: describeElement(el),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          requiredWidth: 24,
          requiredHeight: 24
        });
      }

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && occlusionIssues.length < 20) {
          occlusionIssues.push({
            selector: describeElement(el),
            occludingSelector: describeElement(hit),
            textSample: (el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 40)
          });
        }
      }
    }
  }

  // Section polarity verification: catch unintended always-dark sections in Light mode when follow-active-theme was requested
  if (colorScheme === 'light' && expectedSectionPolarity === 'follow-active-theme') {
    const sections = Array.from(document.querySelectorAll<HTMLElement>('header, main > section, section, footer'));
    for (const sec of sections) {
      const { visible, rect } = isVisible(sec);
      if (!visible || rect.height < 140 || rect.width < window.innerWidth * 0.5) continue;
      if (sec.hasAttribute('data-surface')) continue;
      const { color: bg } = resolveEffectiveBackground(sec);
      const lum = relativeLuminance(bg);
      if (lum < 0.08 && polarityIssues.length < 10) {
        polarityIssues.push({
          selector: describeElement(sec),
          background: formatRgb(bg),
          luminance: Math.round(lum * 1000) / 1000,
          detail: `Large section renders dark (luminance ${lum.toFixed(3)}) in Light Mode while sectionPolarity is follow-active-theme.`
        });
      }
    }
  }

  const fontErrors: string[] = [];
  if ('fonts' in document) {
    for (const fontFace of Array.from(document.fonts)) {
      if (fontFace.status === 'error') {
        fontErrors.push(`${fontFace.family} (${fontFace.weight})`);
      }
    }
  }

  let clsScore: number | null = null;
  try {
    const shifts = performance.getEntriesByType('layout-shift') as Array<{ value?: number; hadRecentInput?: boolean }>;
    if (shifts.length > 0) {
      clsScore = Math.round(
        shifts.filter(s => !s.hadRecentInput).reduce((acc, s) => acc + (s.value ?? 0), 0) * 10000
      ) / 10000;
    }
  } catch {
    clsScore = null;
  }

  return {
    contrastIssues,
    typographyIssues,
    targetSizeIssues,
    occlusionIssues,
    polarityIssues,
    fontErrors: [...new Set(fontErrors)],
    clsScore
  };
}

export function extractAxeFindings(results: {
  violations: Array<{
    id: string;
    impact?: string | null;
    help: string;
    description: string;
    nodes: Array<{ target: unknown[]; failureSummary?: string; any?: Array<{ data?: Record<string, unknown> }> }>;
  }>;
  incomplete: Array<{
    id: string;
    nodes: Array<{ target: unknown[]; failureSummary?: string; any?: Array<{ data?: Record<string, unknown>; message?: string }> }>;
  }>;
}): {
  axeViolations: AxeViolationSummary[];
  axeContrastIssues: ContrastDefect[];
  incompleteContrast: IncompleteContrastItem[];
} {
  const axeViolations: AxeViolationSummary[] = [];
  const axeContrastIssues: ContrastDefect[] = [];
  const incompleteContrast: IncompleteContrastItem[] = [];

  for (const violation of results.violations) {
    const targets = violation.nodes.map(node => node.target.map(String).join(' > '));
    const firstSummary = violation.nodes[0]?.failureSummary ?? '';
    axeViolations.push({
      id: violation.id,
      impact: violation.impact ?? null,
      help: violation.help,
      description: violation.description,
      targets: targets.slice(0, 20),
      failureSummary: firstSummary
    });

    if (violation.id === 'color-contrast' || violation.id === 'color-contrast-enhanced') {
      for (const node of violation.nodes.slice(0, 30)) {
        const data = node.any?.[0]?.data;
        const ratio = typeof data?.contrastRatio === 'number' ? data.contrastRatio : 0;
        const expected = typeof data?.expectedContrastRatio === 'string'
          ? parseFloat(data.expectedContrastRatio)
          : 4.5;
        const fontSize = typeof data?.fontSize === 'string' ? parseFloat(data.fontSize) : 16;
        axeContrastIssues.push({
          selector: node.target.map(String).join(' > '),
          textSample: '',
          foreground: typeof data?.fgColor === 'string' ? data.fgColor : 'unknown',
          background: typeof data?.bgColor === 'string' ? data.bgColor : 'unknown',
          ratio,
          requiredRatio: Number.isFinite(expected) ? expected : 4.5,
          fontSizePx: Number.isFinite(fontSize) ? fontSize : 16,
          isLargeText: (Number.isFinite(expected) ? expected : 4.5) < 4.5,
          source: 'axe'
        });
      }
    }
  }

  for (const item of results.incomplete) {
    if (item.id !== 'color-contrast' && item.id !== 'color-contrast-enhanced') continue;
    for (const node of item.nodes.slice(0, 25)) {
      const check = node.any?.[0];
      const data = check?.data;
      const entry: IncompleteContrastItem = {
        selector: node.target.map(String).join(' > '),
        textSample: '',
        reason: typeof data?.missingData === 'string'
          ? `Indeterminate contrast (${data.missingData})`
          : (check?.message ?? node.failureSummary ?? 'Needs manual/pixel contrast check')
      };
      if (typeof data?.fgColor === 'string') entry.foreground = data.fgColor;
      if (typeof data?.bgColor === 'string') entry.background = data.bgColor;
      incompleteContrast.push(entry);
    }
  }

  return { axeViolations, axeContrastIssues, incompleteContrast };
}
