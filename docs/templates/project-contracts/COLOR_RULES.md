# Color Rules

## Palette source
- Brand source / approved palette: TBD
- Primitive scales: TBD
- Color space used for generation: TBD

## Semantic tokens
Define roles such as text, surface, elevated surface, border, primary, secondary, accent, success, warning, danger, info, focus and disabled.

## Theme mapping & flexible polarity
- Theme mode (`light-only` | `dark-only` | `light-and-dark` | `system-auto` | `high-contrast`): TBD
- Section polarity (`follow-active-theme` | `contrast-bands` | `always-dark-media-showcase` | `always-light-reading`): TBD
- Light theme mappings: TBD
- Dark theme mappings: TBD
- Foreground/background pairs: TBD
- Surface scoping rule: Do not force sections dark when the user chose `follow-active-theme`. When `contrast-bands` or `always-dark-media-showcase` / `always-light-reading` is chosen, isolate that section with an explicit surface scope (e.g. `color-scheme` + `light-dark()` or `[data-surface="dark"]` / `[data-surface="light"]`) that redefines every semantic foreground, border, and badge/pill token—never let global page ink leak onto an inverted surface.
- Micro-component pairing: Badges, pills, chips, captions, placeholders, and disabled/muted states must explicitly pair background, foreground, and border tokens from the same surface scope.

## Accessibility
- Normal text contrast: WCAG AA 4.5:1.
- Large text contrast: WCAG AA 3:1; large means at least 18pt regular or 14pt bold.
- Required non-text UI and graphical contrast: 3:1 where WCAG applies.
- Do not communicate state by color alone.
- Measure the final rendered pair, including opacity and overlays.

## Constraints
- Default profile excludes pink.
- Preferred families: charcoal, black, gray, white, navy, blue, sage, earthy green, brown and cream; lime/orange as limited accents when justified.
- Test gamut conversion and rendering on target browsers/devices.
