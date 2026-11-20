---
name: design-direction
description: Establish a distinct, high-craft visual direction and differentiate true premium digital craft from generic AI-generated interface templates.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Design Direction & Visual Polish (Production Standards)

## Step 0: Design Brief Intake (user chooses first)
Before writing any UI, let the user shape the result. Do not impose the house style below unless the user declines to choose.

1. Read the menu from MCP resource `harness://design-options` (source: `catalogs/design-options.json`). It covers personality, theme mode, color family and harmony, accent usage, heading/body/mono fonts, type scale, weight, layout pattern, density, content width, navigation, corner radius, surface, icons, imagery, motion, background, accessibility target, responsive priority, copy tone and language.
2. Ask the user using the host's native question UI (multiple choice). Group into at most 3 rounds:
   - Round 1 (identity): personality, themeMode, colorFamily, colorHarmony, accentUsage.
   - Round 2 (type and layout): headingFont, bodyFont, monoFont, typeScale, layoutPattern, density, navigation.
   - Round 3 (finish): shape, surface, iconStyle, imagery, motionLevel, background, accessibilityTarget, contentTone, language.
   Offer a "You decide" choice per round; it applies the `default` of each question.
3. Honor free-form answers (a hex color, a named font, a reference site) as `custom-*` choices.
4. Write every decision into the project's `DESIGN.md` (copy from `docs/templates/project-contracts/DESIGN.md`) under a `## User choices` section, then derive tokens (CSS variables) from it. Later work must read that file, not re-ask.
5. If a choice conflicts with accessibility (for example low-contrast palette against `wcag-aa`), keep the choice's intent, adjust shades until contrast passes, and tell the user what changed.
6. The "no pink" rule below is only a default. If the user picks `rose-pink` or `custom-hex` with pink, follow the user.
7. After building, show the user screenshots (via `localhost.inspect_responsive`) and offer to swap any single choice, then re-run affected checks.

## Core Philosophy: Distinction between Slop vs. High Craft
The mandate to "avoid AI slop" does **NOT** mean designing flat, boring, sterile gray websites. It means rejecting cheap, unearned tropes and replacing them with **intentional, high-craft digital artistry**:

| Dimension | ❌ Cheap AI Slop (Avoid) | ✅ High-Craft Modern Polish (Build This) |
| :--- | :--- | :--- |
| **Color Palette** | Blinding uncalibrated pink/purple neon gradients (`#FF0080` / `#7928CA`). | Deep Obsidian canvas (`#07090E`), Titanium Slate, Emerald (`#10B981`) or Ice Cyan (`#06B6D4`) precision accents. No pink. |
| **Glassmorphism** | Milky white cards with unreadable light gray text (WCAG 2:1 failure). | Subtle dark glass (`rgba(17, 24, 39, 0.75)` + `backdrop-filter: blur(20px)`) with crisp white/platinum text (WCAG 14:1 AAA). |
| **Layout** | Repetitive equal-width boxes, broken mobile overflow, static tables. | Asymmetric Bento grids (7/5 column splits), fluid micro-mesh backgrounds, responsive clamp typography. |
| **Content & Copy** | Cliché buzzwords ("*10,000x Quantum AI Synergy Alchemy*"). | Authentic engineering metrics ("*p99 latency < 4.2ms*", "*eBPF kernel ring buffer*"). |
| **Interactivity** | Broken unhandled exceptions, non-clickable buttons due to canvas z-index. | Interactive telemetry wave canvases, clickable cluster nodes, snappy spring transforms. |

---

## 1. Establishing Identity & Visual Hierarchy
1. **Audience & Context:** Match aesthetic tone to real technical domain (e.g., enterprise observability, aerospace CAD, developer tooling).
2. **Typography Scale:** Use responsive modular fluid scales with `clamp()`:
   ```css
   --font-hero: clamp(2.4rem, 6vw, 4.4rem);
   --font-sub:  clamp(1rem, 2vw, 1.25rem);
   ```
3. **Contrast Hierarchy:**
   - Hero Headings: High-luminance white (`#FFFFFF`) with subtle metallic gradient roll-off.
   - Body Text: Platinum slate (`#F1F5F9`) ensuring high readability.
   - Secondary Text: Muted slate (`#94A3B8`), maintaining minimum 7:1 contrast ratio.

---

## 2. Palet & Brand Guardrails
- **Project Rule:** No pink.
- **Preferred Color Foundations:** Deep charcoal, obsidian black, slate navy, titanium gray, sage green, forest emerald, ice cyan, warm tungsten amber.
- **Accent Philosophy:** Use accents as functional beacons (e.g. status dots, focus rings, primary action buttons), never as full-screen eye-straining gradient fills.

---

## 3. Review & Verification
- Test all pages with actual browser screenshots across mobile and desktop.
- Grade the design on both **Aesthetic Impact** (does it feel dynamic and premium?) and **Technical Rigor** (does it reflow with 0px overflow and high accessibility?).
