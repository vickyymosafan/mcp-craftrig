import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectedRepoContext } from '../../domain/blueprint.js';
import type { RepoScannerPort } from '../../domain/ports.js';

async function listAppRoutes(root: string): Promise<string[]> {
  const routes = new Set<string>();
  const candidates = [
    path.join(root, 'src', 'app'),
    path.join(root, 'app'),
    path.join(root, 'src', 'pages'),
    path.join(root, 'pages')
  ];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const segment = entry.name.startsWith('(') && entry.name.endsWith(')')
          ? prefix
          : `${prefix}/${entry.name}`;
        await walk(path.join(dir, entry.name), segment, depth + 1);
      } else if (/^(page|index)\.(tsx|ts|jsx|js|mdx|astro|svelte|vue)$/.test(entry.name)) {
        routes.add(prefix || '/');
      } else if (/\.(tsx|jsx|astro|svelte|vue)$/.test(entry.name) && !/^(layout|loading|error|not-found|template|route)\./.test(entry.name)) {
        const stem = entry.name.replace(/\.[^.]+$/, '');
        if (prefix.includes('pages') || dir.endsWith('pages')) {
          routes.add(stem === 'index' ? (prefix || '/') : `${prefix}/${stem}`);
        }
      }
    }
  }

  for (const candidate of candidates) {
    await walk(candidate, '', 0);
  }
  return [...routes].sort().slice(0, 40);
}

async function detectDarkModeInCss(root: string): Promise<boolean> {
  const files = [
    path.join(root, 'tailwind.config.ts'),
    path.join(root, 'tailwind.config.js'),
    path.join(root, 'tailwind.config.mjs'),
    path.join(root, 'src', 'app', 'globals.css'),
    path.join(root, 'src', 'index.css'),
    path.join(root, 'src', 'styles', 'globals.css')
  ];
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf8');
      if (/darkMode|prefers-color-scheme:\s*dark|light-dark\(|\[data-theme=["']dark["']\]|\.dark\s*\{/.test(content)) {
        return true;
      }
    } catch {
      // Ignore missing file
    }
  }
  return false;
}

export class WorkspaceRepoScanner implements RepoScannerPort {
  constructor(private readonly workspaceRoot: string) {}

  async scan(): Promise<DetectedRepoContext> {
    let hasPackageJson = false;
    let dependencies: string[] = [];

    try {
      const raw = await readFile(path.join(this.workspaceRoot, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      hasPackageJson = true;
      dependencies = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {})
      ].sort();
    } catch {
      hasPackageJson = false;
    }

    const depSet = new Set(dependencies);
    const has = (...names: string[]) => names.some(name => depSet.has(name));

    let framework: string | null = null;
    if (has('next')) framework = 'Next.js';
    else if (has('nuxt')) framework = 'Nuxt';
    else if (has('astro')) framework = 'Astro';
    else if (has('@sveltejs/kit', 'svelte')) framework = 'SvelteKit / Svelte';
    else if (has('react', 'vite')) framework = has('react') ? (has('vite') ? 'React + Vite' : 'React') : 'Vite';
    else if (has('vue')) framework = 'Vue';
    else if (has('@nestjs/core')) framework = 'NestJS';
    else if (has('fastify')) framework = 'Fastify';
    else if (has('express')) framework = 'Express';

    let router: string | null = null;
    if (has('next')) router = 'Next.js Router';
    else if (has('react-router', 'react-router-dom')) router = 'React Router';
    else if (has('@tanstack/react-router')) router = 'TanStack Router';
    else if (has('vue-router')) router = 'Vue Router';

    const hasTailwind = has('tailwindcss', '@tailwindcss/vite', '@tailwindcss/postcss');
    const hasThreeJs = has('three', '@react-three/fiber', '@react-three/drei', 'babylonjs');
    const hasMotionLib = has('framer-motion', 'motion', 'gsap', 'lenis', '@react-spring/web');
    const hasDatabase = has('prisma', '@prisma/client', 'drizzle-orm', 'mongoose', 'pg', 'mysql2', 'better-sqlite3', '@supabase/supabase-js');
    const hasAuth = has('next-auth', '@auth/core', '@clerk/nextjs', 'lucia', 'passport', 'jsonwebtoken', 'better-auth');
    const [existingRoutes, hasDarkMode] = await Promise.all([
      listAppRoutes(this.workspaceRoot),
      detectDarkModeInCss(this.workspaceRoot)
    ]);

    const assumptions: Record<string, string> = {};
    if (framework) assumptions['stack.framework'] = `Terdeteksi dari package.json: ${framework}`;
    if (hasTailwind) assumptions['stack.styling'] = 'Terdeteksi Tailwind CSS';
    if (hasThreeJs) assumptions['threejs.enabled'] = 'Terdeteksi library Three.js/WebGL di repo';
    if (hasMotionLib) assumptions['motion.enabled'] = 'Terdeteksi library animasi/motion di repo';
    if (hasDatabase) assumptions['data.database'] = 'Terdeteksi library database/ORM di repo';
    if (hasAuth) assumptions['security.auth'] = 'Terdeteksi library autentikasi di repo';
    if (hasDarkMode) assumptions['design.theme'] = 'Terdeteksi dukungan dark mode di CSS/Tailwind';

    return {
      hasPackageJson,
      framework,
      router,
      hasTailwind,
      hasThreeJs,
      hasMotionLib,
      hasDatabase,
      hasAuth,
      hasDarkMode,
      existingRoutes,
      dependencies: dependencies.slice(0, 60),
      assumptions
    };
  }
}
