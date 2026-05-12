import { mkdtemp, mkdir, writeFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module under test depends only on `node:fs` + `@shared/logger`; the
// logger transitively imports `electron` in some build configs, so stub it.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

import {
  buildProjectProfile,
  cleanReadme,
  detectComponentLibraries,
  detectIconLibraries,
  extractCssVarTokens,
  extractTailwindTokens,
  loadCachedOrBuild,
  parseComponentExports,
} from '@main/services/ProjectProfileBuilder';

describe('ProjectProfileBuilder', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-profile-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeProject(files: Record<string, string>): Promise<void> {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(tmp, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, body, 'utf8');
    }
  }

  it('detects Next.js + Tailwind + TS + pnpm from canonical signals', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { next: '^14.0.0', tailwindcss: '^3.4.0' },
      }),
      'next.config.js': 'module.exports = {}',
      'tailwind.config.js': 'module.exports = {}',
      'tsconfig.json': '{}',
      'pnpm-lock.yaml': '',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile).not.toBeNull();
    expect(profile?.framework).toBe('next');
    expect(profile?.styling).toBe('tailwind');
    expect(profile?.typescript).toBe(true);
    expect(profile?.packageManager).toBe('pnpm');
    expect(profile?.summary).toContain('Next.js');
    expect(profile?.summary).toContain('Tailwind CSS');
    expect(profile?.summary).toContain('TypeScript');
    expect(profile?.summary).toContain('pnpm');
  });

  it('detects Vite + styled-components + JS + npm', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { vite: '^5.0.0', 'styled-components': '^6.0.0' },
      }),
      'vite.config.js': 'export default {}',
      'package-lock.json': '{}',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile).not.toBeNull();
    expect(profile?.framework).toBe('vite');
    expect(profile?.styling).toBe('styled-components');
    expect(profile?.typescript).toBe(false);
    expect(profile?.packageManager).toBe('npm');
  });

  it('detects CSS Modules from a *.module.css presence under src/', async () => {
    await writeProject({
      'package.json': JSON.stringify({ name: 't', dependencies: { vite: '^5' } }),
      'vite.config.js': 'export default {}',
      'src/components/Button.module.css': '.btn { color: red; }',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.styling).toBe('css-modules');
  });

  it('detects vanilla CSS when no module.css but plain .css exists', async () => {
    await writeProject({
      'package.json': JSON.stringify({ name: 't', dependencies: { vite: '^5' } }),
      'vite.config.js': 'export default {}',
      'src/styles/main.css': 'body { margin: 0 }',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.styling).toBe('vanilla-css');
  });

  it('detects Tailwind v4 from `@import "tailwindcss"` even without config file', async () => {
    await writeProject({
      'package.json': JSON.stringify({ name: 't', dependencies: { next: '^15' } }),
      'next.config.js': 'module.exports = {}',
      'app/globals.css': '@import "tailwindcss";\n.body{}',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.styling).toBe('tailwind');
  });

  it('returns null when there is no package.json', async () => {
    // Empty tmp dir — no package.json present.
    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile).toBeNull();
  });

  it('caches and reuses the profile on second call when fingerprint inputs are unchanged', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { vite: '^5' },
      }),
      'vite.config.js': 'export default {}',
    });

    const first = await loadCachedOrBuild(tmp);
    // Verify the on-disk cache file exists.
    const cacheFile = path.join(tmp, '.devspace', 'design', 'profile.json');
    const cacheStat = await stat(cacheFile);
    expect(cacheStat.isFile()).toBe(true);
    expect(first?.fingerprint).toBeTruthy();

    // No file mutated between calls → fingerprint matches → cache hit.
    const second = await loadCachedOrBuild(tmp);
    expect(second?.builtAt).toBe(first?.builtAt);
    expect(second?.fingerprint).toBe(first?.fingerprint);
  });

  it('rebuilds the profile when package.json mtime changes (fingerprint mismatch)', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { vite: '^5' },
      }),
      'vite.config.js': 'export default {}',
    });

    const first = await loadCachedOrBuild(tmp);
    expect(first).not.toBeNull();

    // Bump package.json mtime — fingerprint must change → rebuild.
    const future = new Date(first!.builtAt + 60_000);
    await utimes(path.join(tmp, 'package.json'), future, future);

    const second = await loadCachedOrBuild(tmp);
    expect(second).not.toBeNull();
    expect(second!.builtAt).toBeGreaterThan(first!.builtAt);
    expect(second!.fingerprint).not.toBe(first!.fingerprint);
  });

  it('records evidence signals used during detection', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { next: '^14.0.0', tailwindcss: '^3' },
      }),
      'next.config.js': 'module.exports = {}',
      'tailwind.config.js': 'module.exports = {}',
      'tsconfig.json': '{}',
      'pnpm-lock.yaml': '',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.evidence).toContain('package.json');
    expect(profile?.evidence).toContain('tsconfig.json');
    expect(profile?.evidence).toContain('pnpm-lock.yaml');
    expect(profile?.evidence.some((e) => e.includes('tailwind'))).toBe(true);
    expect(profile?.evidence.some((e) => e.includes('next'))).toBe(true);
  });

  // ── v0.13 extensions ────────────────────────────────────────────────

  it('detects Next.js App Router variant from app/ + next.config.*', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 'app-router-app',
        dependencies: { next: '^15' },
      }),
      'next.config.js': 'module.exports = {}',
      'app/page.tsx': 'export default function Page() { return null }',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.framework).toBe('next');
    expect(profile?.frameworkVariant).toBe('next-app-router');
  });

  it('detects Next.js Pages Router variant from pages/ dir', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 'pages-app',
        dependencies: { next: '^14' },
      }),
      'next.config.js': 'module.exports = {}',
      'pages/index.tsx': 'export default function Index() { return null }',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.framework).toBe('next');
    expect(profile?.frameworkVariant).toBe('next-pages-router');
  });

  it('detects vite-electron variant when electron + electron.vite.config present', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 'electron-app',
        dependencies: { vite: '^5', electron: '^28' },
      }),
      'vite.config.js': 'export default {}',
      'electron.vite.config.js': 'export default {}',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.framework).toBe('vite');
    expect(profile?.frameworkVariant).toBe('vite-electron');
  });

  it('captures projectName and capped projectDescription from package.json', async () => {
    const longDesc = 'x'.repeat(250);
    await writeProject({
      'package.json': JSON.stringify({
        name: 'my-cool-app',
        description: longDesc,
        dependencies: { vite: '^5' },
      }),
      'vite.config.js': 'export default {}',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.projectName).toBe('my-cool-app');
    expect(profile?.projectDescription).toBeTruthy();
    expect(profile?.projectDescription!.length).toBeLessThanOrEqual(200);
  });

  it('detects component libraries: Radix + shadcn + Material UI; sorts and dedupes', async () => {
    const profile = await buildProjectProfile({ projectPath: tmp }).catch(() => null);
    // Above call returns null (no package.json yet) — use the exported helper directly.
    expect(profile).toBeNull();

    const libs = detectComponentLibraries({
      dependencies: {
        '@radix-ui/react-dialog': '*',
        '@radix-ui/themes': '*',
        'class-variance-authority': '*',
        '@mui/material': '*',
      },
    });
    expect(libs).toContain('Radix UI');
    expect(libs).toContain('Radix Themes');
    expect(libs).toContain('shadcn/ui (Radix + CVA)');
    expect(libs).toContain('Material UI');
    // Sorted alphabetically.
    expect([...libs]).toEqual([...libs].sort());
  });

  it('detects icon libraries (lucide-react, heroicons)', async () => {
    const icons = detectIconLibraries({
      dependencies: { 'lucide-react': '*', '@heroicons/react': '*' },
    });
    expect(icons).toContain('lucide-react');
    expect(icons).toContain('Heroicons');
  });

  it('extracts README excerpt by stripping front-matter, badges, and headings', () => {
    const raw = [
      '---',
      'title: My Project',
      '---',
      '',
      '# My Project',
      '',
      '![build](https://img.shields.io/badge/build-passing-green)',
      '[![npm](https://img.shields.io/npm/v/foo)](https://npmjs.com/foo)',
      '<img src="hero.png" alt="hero">',
      '<!-- HTML comment -->',
      '',
      'My Project is a tool for doing things. It exists to make life easier.',
      '',
      '## Install',
      '',
      'Run `pnpm i`.',
    ].join('\n');
    const cleaned = cleanReadme(raw);
    expect(cleaned).not.toContain('![');
    expect(cleaned).not.toContain('<img');
    expect(cleaned).not.toContain('---');
    expect(cleaned).not.toContain('# My');
    expect(cleaned).toContain('My Project is a tool for doing things.');
  });

  it('readme excerpt caps near 600 chars and ends on a sentence boundary when possible', () => {
    const para =
      'This is a sentence. ' + 'Another short sentence. '.repeat(50);
    const cleaned = cleanReadme(para);
    expect(cleaned.length).toBeLessThanOrEqual(600);
    // Should end at . / ! / ? when possible.
    expect(/[.!?]$/.test(cleaned)).toBe(true);
  });

  it('extracts tailwind tokens from theme.extend.colors / fontFamily / spacing', () => {
    const cfg = `
      module.exports = {
        theme: {
          extend: {
            colors: {
              brand: '#4c8dff',
              accent: '#ff7e3a',
              'soft-bg': '#f4f6fb',
            },
            fontFamily: {
              sans: 'Inter',
              mono: 'JetBrains Mono',
            },
            spacing: {
              'sidebar': '280px',
            },
          },
        },
      };
    `;
    const tokens = extractTailwindTokens(cfg);
    expect(tokens.colors.some((c) => c.startsWith('brand:'))).toBe(true);
    expect(tokens.colors.some((c) => c.startsWith('accent:'))).toBe(true);
    expect(tokens.fonts.some((f) => f.startsWith('sans:'))).toBe(true);
    expect(tokens.spacing.some((s) => s.startsWith('sidebar:'))).toBe(true);
  });

  it('falls back to CSS-var tokens when no tailwind config is present', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { next: '^15' },
      }),
      'next.config.js': 'module.exports = {}',
      'app/globals.css': [
        '@import "tailwindcss";',
        ':root {',
        '  --primary: #4c8dff;',
        '  --accent-color: oklch(60% 0.2 200);',
        '  --font-sans: Inter;',
        '  --radius: 8px;',
        '}',
      ].join('\n'),
    });
    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.designTokens?.source).toBe('css-vars');
    expect(profile?.designTokens?.colors.some((c) => c.startsWith('primary:'))).toBe(true);
    expect(profile?.designTokens?.fonts.some((f) => f.startsWith('font-sans:'))).toBe(true);
    expect(profile?.designTokens?.spacing.some((s) => s.startsWith('radius:'))).toBe(true);
  });

  it('extractCssVarTokens recognizes color-ish keys and oklch values', () => {
    const css = `
      :root {
        --primary: #ff0000;
        --background: hsl(0 0% 100%);
        --font-mono: JetBrains Mono;
        --gap-sm: 4px;
        --random: 42;
      }
    `;
    const tokens = extractCssVarTokens(css);
    expect(tokens.colors.some((c) => c.startsWith('primary:'))).toBe(true);
    expect(tokens.colors.some((c) => c.startsWith('background:'))).toBe(true);
    expect(tokens.fonts.some((f) => f.startsWith('font-mono:'))).toBe(true);
    expect(tokens.spacing.some((s) => s.startsWith('gap-sm:'))).toBe(true);
  });

  it('parseComponentExports detects default, named, and both', () => {
    expect(
      parseComponentExports('export default function Button(props) { return null }'),
    ).toEqual({ name: 'Button', exportKind: 'default' });

    expect(
      parseComponentExports('export function Card() { return null }'),
    ).toEqual({ name: 'Card', exportKind: 'named' });

    expect(
      parseComponentExports(`
        export function Header() { return null }
        export default function Page() { return null }
      `),
    ).toEqual({ name: 'Page', exportKind: 'both' });

    expect(
      parseComponentExports('export const FancyBox = () => null'),
    ).toEqual({ name: 'FancyBox', exportKind: 'named' });

    expect(parseComponentExports('// no exports')).toBeNull();
  });

  // v0.13 MED #2 regression — code-review found that the v0.13.0 builder
  // matched `export default function Foo` inside line/block comments and
  // string literals. The stripCommentsAndStrings pre-pass added in the
  // fix should make these all return null.
  it('parseComponentExports ignores commented-out + stringified exports', () => {
    expect(
      parseComponentExports('// export default function Ghost() {}'),
    ).toBeNull();
    expect(
      parseComponentExports('/* export function Ghost() {} */'),
    ).toBeNull();
    expect(
      parseComponentExports(
        'const doc = "see also: export default function Ghost";',
      ),
    ).toBeNull();
    expect(
      parseComponentExports(
        "const t = `the canonical pattern is: export function Ghost()`;",
      ),
    ).toBeNull();
    // Real export AFTER a commented one should still be detected.
    expect(
      parseComponentExports(
        '// export default function OldName\nexport default function Real() {}',
      ),
    ).toEqual({ name: 'Real', exportKind: 'default' });
  });

  it('builds a componentInventory from src/components walk', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { vite: '^5' },
      }),
      'vite.config.js': 'export default {}',
      'src/components/Button.tsx':
        'export default function Button() { return null }',
      'src/components/Card.tsx':
        'export function Card() { return null }',
      'src/components/forms/Input.tsx':
        'export const Input = () => null',
      // Lowercase file should be ignored.
      'src/components/utils.ts':
        'export const helper = () => null',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.componentInventory).toBeTruthy();
    const names = profile!.componentInventory!.map((c) => c.name).sort();
    expect(names).toContain('Button');
    expect(names).toContain('Card');
    expect(names).toContain('Input');
  });

  it('fingerprint changes when a tracked file mtime changes', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { next: '^15', tailwindcss: '^3' },
      }),
      'next.config.js': 'module.exports = {}',
      'tailwind.config.js':
        'module.exports = { theme: { extend: { colors: { brand: "#abc" } } } }',
    });

    const first = await buildProjectProfile({ projectPath: tmp });
    expect(first?.fingerprint).toBeTruthy();

    // Touch tailwind.config.js — this file is read by the builder so
    // its mtime participates in the fingerprint.
    const future = new Date(first!.builtAt + 60_000);
    await utimes(path.join(tmp, 'tailwind.config.js'), future, future);

    const second = await loadCachedOrBuild(tmp);
    expect(second?.fingerprint).not.toBe(first?.fingerprint);
  });

  it('summary surface includes project name, libraries, tokens, and components', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 'sample-app',
        description: 'A sample for the suite.',
        dependencies: {
          next: '^15',
          tailwindcss: '^3',
          '@radix-ui/react-dialog': '*',
          'class-variance-authority': '*',
          'lucide-react': '*',
        },
      }),
      'next.config.js': 'module.exports = {}',
      'tailwind.config.js':
        'module.exports = { theme: { extend: { colors: { brand: "#4c8dff" } } } }',
      'app/page.tsx': 'export default function Page() { return null }',
      'src/components/Button.tsx':
        'export default function Button() { return null }',
      'README.md': '# Sample App\n\nThis is the sample app for the suite.',
    });

    const profile = await buildProjectProfile({ projectPath: tmp });
    expect(profile?.summary).toContain('sample-app');
    expect(profile?.summary).toContain('A sample for the suite.');
    expect(profile?.summary).toContain('Component libraries:');
    expect(profile?.summary).toContain('Radix UI');
    expect(profile?.summary).toContain('Icon libraries: lucide-react');
    expect(profile?.summary).toContain('Design tokens:');
    expect(profile?.summary).toContain('Components: 1 found');
    expect(profile?.summary).toContain('README excerpt:');
    expect(profile?.summary).toContain('Variant: Next.js App Router');
  });

  it('loads old v0.10 caches missing fingerprint by rebuilding rather than crashing', async () => {
    await writeProject({
      'package.json': JSON.stringify({
        name: 't',
        dependencies: { vite: '^5' },
      }),
      'vite.config.js': 'export default {}',
    });
    // Hand-write a v0.10-shaped cache (no fingerprint field).
    const cachePath = path.join(tmp, '.devspace', 'design', 'profile.json');
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        projectPath: tmp,
        framework: 'vite',
        styling: 'unknown',
        packageManager: 'npm',
        typescript: false,
        summary: '- Framework: Vite',
        evidence: ['package.json'],
        builtAt: Date.now() - 1000,
        // no fingerprint
      }),
      'utf8',
    );

    const profile = await loadCachedOrBuild(tmp);
    // Must rebuild → fingerprint is now present.
    expect(profile?.fingerprint).toBeTruthy();
  });
});
