---
name: design-direction
description: Establish a distinct, high-craft visual direction and differentiate true premium digital craft from generic AI-generated interface templates.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Design Direction & Visual Polish (Production Standards)

## Step 0: Design Brief Intake (user chooses first)
Before writing any UI, let the user shape the result. Do not impose the house style below unless the user declines to choose.

1. Read the menu from MCP resource `craftrig://design-options` (source: `catalogs/design-options.json`). It covers personality, theme mode, section polarity (`follow-active-theme`, `contrast-bands`, `always-dark-media-showcase`, `always-light-reading`), theme toggle control, light canvas tone, color family and harmony, accent usage, heading/body/mono fonts, type scale, weight, layout pattern, density, content width, navigation, corner radius, surface, icons, imagery, motion, background, accessibility target, responsive priority, copy tone and language.
2. Ask the user using the host's native question UI (multiple choice). Group into at most 3 rounds:
   - Round 1 (identity & polarity): personality, themeMode, sectionPolarity, themeToggle, lightCanvasTone, colorFamily, colorHarmony, accentUsage.
   - Round 2 (type and layout): headingFont, bodyFont, monoFont, typeScale, layoutPattern, density, navigation.
   - Round 3 (finish): shape, surface, iconStyle, imagery, motionLevel, background, accessibilityTarget, contentTone, language.
   Offer a "You decide" choice per round; it applies the `default` of each question.
3. Honor free-form answers (a hex color, a named font, a reference site, or custom section behavior) as `custom-*` choices. Never force sections dark unless the user chose `dark-only`, `contrast-bands`, or `always-dark-media-showcase`.
4. Write every decision into the project's `DESIGN.md` (copy from `docs/templates/project-contracts/DESIGN.md`) under a `## User choices` section, then derive tokens (CSS variables using `light-dark()` + `color-scheme` or surface-scoped variables) from it. Later work must read that file, not re-ask.
5. If a choice conflicts with accessibility (for example low-contrast palette against `wcag-aa`), keep the choice's intent, adjust shades until contrast passes, and tell the user what changed.
6. The "no pink" rule below is only a default. If the user picks `rose-pink` or `custom-hex` with pink, follow the user.
7. After building, verify every enabled theme mode (`light` and/or `dark`) with `localhost_inspect_responsive` and `localhost_audit_visual_a11y`, show screenshots to the user, and offer to swap any single choice, then re-run affected checks.

## Core Philosophy: Distinction between Slop vs. High Craft (Dual-Polarity)
The mandate to "avoid AI slop" does **NOT** mean designing flat, boring, sterile gray websites—and it does **NOT** mean forcing dark mode everywhere. It means rejecting cheap, unearned tropes and replacing them with **intentional, high-craft digital artistry** calibrated for the user's chosen polarity (Light, Dark, or both):

| Dimension | ❌ Cheap AI Slop (Avoid) | ✅ High-Craft Modern Polish (Build This) |
| :--- | :--- | :--- |
| **Color & Polarity** | Blinding uncalibrated pink/purple neon gradients (`#FF0080` / `#7928CA`), or forcing dark sections with broken light-mode tokens. | Calibrated dual-polarity palettes: Crisp/Warm Light (`#FAF9F6` / `#FFFFFF` + deep charcoal ink `#111827`) and/or Deep Obsidian Dark (`#07090E` + platinum `#F1F5F9`) with disciplined Emerald/Cyan/Amber accents. |
| **Glass & Surfaces** | Milky white cards or muddy translucent pills with unreadable text (WCAG < 3:1 failure, e.g. dark ink on dark badge). | Surface-scoped solid/elevated cards or calibrated glass (`rgba(255,255,255,0.82)` in Light, `rgba(17,24,39,0.78)` in Dark + `backdrop-filter`) with paired foreground tokens ($\ge 7:1$ body, $\ge 4.5:1$ UI). |
| **Layout** | Repetitive equal-width boxes, broken mobile overflow, static tables. | Asymmetric Bento grids (7/5 column splits), fluid micro-mesh/editorial rhythm, responsive clamp typography. |
| **Content & Copy** | Cliché buzzwords ("*10,000x Quantum AI Synergy Alchemy*"). | Authentic domain metrics ("*p99 latency < 4.2ms*", "*eBPF kernel ring buffer*"). |
| **Interactivity** | Broken unhandled exceptions, non-clickable buttons due to canvas z-index. | Interactive telemetry/3D canvases with `pointer-events` isolation, high-contrast HUD scrims, snappy spring transforms. |

---

## 1. Establishing Identity & Visual Hierarchy
1. **Audience & Context:** Match aesthetic tone and light/dark polarity to real technical/editorial domain and user choices in `DESIGN.md`.
2. **Typography Scale:** Use responsive modular fluid scales with `clamp()`:
   ```css
   --font-hero: clamp(2.4rem, 6vw, 4.4rem);
   --font-sub:  clamp(1rem, 2vw, 1.25rem);
   ```
3. **Dual-Polarity Contrast Hierarchy:**
   - **Light Mode:** Deep charcoal/ink headings (`#0F172A`), neutral slate body (`#1E293B`), muted metadata (`#475569` — still $\ge 7:1$ on light canvas).
   - **Dark Mode:** High-luminance white/off-white headings (`#F8FAFC`), platinum slate body (`#E2E8F0`), muted slate (`#94A3B8` — $\ge 5.5:1$ on obsidian canvas).
   - **Inverted / Contrast Sections (only when chosen in `sectionPolarity`):** Must redefine all surface, text, border, and badge tokens inside an explicit surface scope (`[data-surface="dark"]` / `color-scheme`).

---

## 2. Palet & Brand Guardrails
- **Project Rule:** No pink.
- **Preferred Color Foundations:** Deep charcoal, obsidian black, slate navy, titanium gray, sage green, forest emerald, ice cyan, warm tungsten amber.
- **Accent Philosophy:** Use accents as functional beacons (e.g. status dots, focus rings, primary action buttons), never as full-screen eye-straining gradient fills.

---

## 3. Review & Verification
- Test all pages with actual browser screenshots across mobile and desktop.
- Grade the design on both **Aesthetic Impact** (does it feel dynamic and premium?) and **Technical Rigor** (does it reflow with 0px overflow and high accessibility?).
