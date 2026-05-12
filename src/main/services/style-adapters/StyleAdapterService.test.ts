// Detection + dispatch tests for StyleAdapterService. `detectAdapter`
// is a pure file-scan; `writeBack` fans out to the per-adapter modules.
// We exercise detection across the four supported stacks plus the
// nothing-detected fallback, and we cover the dispatch behaviour for
// Tailwind (delegates to the real adapter) and a stubbed kind (returns
// the 0.8 not-implemented error).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { DesignWriteBackEdit } from '@shared/design';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// ─── helpers ───────────────────────────────────────────────────────────────

async function writePkgJson(
  dir: string,
  deps: Record<string, string> = {},
  devDeps: Record<string, string> = {},
): Promise<void> {
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'detect-test',
      version: '0.0.0',
      dependencies: deps,
      devDependencies: devDeps,
    }),
    'utf8',
  );
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('detectAdapter', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-style-detect-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('detects Tailwind from package.json + tailwind.config.ts', async () => {
    await writePkgJson(tmp, { react: '^19.0.0' }, { tailwindcss: '^3.4.0' });
    await writeFile(
      path.join(tmp, 'tailwind.config.ts'),
      `export default { content: [], theme: {}, plugins: [] };\n`,
      'utf8',
    );

    const { detectAdapter } = await import(
      '@main/services/style-adapters/StyleAdapterService'
    );
    const result = await detectAdapter({ projectPath: tmp });

    expect(result.preferred).toBe('tailwind');
    expect(result.available).toContain('tailwind');
    // Evidence cites both the dep and the config file.
    expect(result.evidence.some((e) => e.includes('tailwindcss'))).toBe(true);
    expect(result.evidence.some((e) => e.includes('tailwind.config'))).toBe(true);
  });

  it('detects styled-components when present without Tailwind', async () => {
    await writePkgJson(tmp, { 'styled-components': '^6.0.0', react: '^19.0.0' });

    const { detectAdapter } = await import(
      '@main/services/style-adapters/StyleAdapterService'
    );
    const result = await detectAdapter({ projectPath: tmp });

    expect(result.preferred).toBe('styled-components');
    expect(result.available).toContain('styled-components');
  });

  it('lists css-modules in `available` when a *.module.css file exists', async () => {
    await writePkgJson(tmp, { react: '^19.0.0' });
    await mkdir(path.join(tmp, 'src'), { recursive: true });
    await writeFile(
      path.join(tmp, 'src', 'Button.module.css'),
      `.btn { color: red; }\n`,
      'utf8',
    );

    const { detectAdapter } = await import(
      '@main/services/style-adapters/StyleAdapterService'
    );
    const result = await detectAdapter({ projectPath: tmp });

    expect(result.available).toContain('css-modules');
    // First-detected wins as `preferred` when nothing else is in play.
    expect(result.preferred).toBe('css-modules');
  });

  it('lists vanilla-css in `available` when a non-module *.css file exists', async () => {
    await writePkgJson(tmp, { react: '^19.0.0' });
    await mkdir(path.join(tmp, 'src'), { recursive: true });
    await writeFile(path.join(tmp, 'src', 'App.css'), `body { margin: 0; }\n`, 'utf8');

    const { detectAdapter } = await import(
      '@main/services/style-adapters/StyleAdapterService'
    );
    const result = await detectAdapter({ projectPath: tmp });

    expect(result.available).toContain('vanilla-css');
  });

  it('falls back to "unknown" for a project with no style stack', async () => {
    // Empty package.json, no config files, no stylesheets.
    await writePkgJson(tmp);

    const { detectAdapter } = await import(
      '@main/services/style-adapters/StyleAdapterService'
    );
    const result = await detectAdapter({ projectPath: tmp });

    expect(result.preferred).toBe('unknown');
    expect(result.available).toContain('unknown');
  });
});

describe('writeBack — dispatch', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-style-writeback-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function buildTailwindProject(): Promise<{
    projectPath: string;
    filePath: string;
  }> {
    await writePkgJson(tmp, { react: '^19.0.0' }, { tailwindcss: '^3.4.0' });
    await writeFile(
      path.join(tmp, 'tailwind.config.ts'),
      `export default { content: [], theme: {}, plugins: [] };\n`,
      'utf8',
    );
    await mkdir(path.join(tmp, 'src'), { recursive: true });
    const filePath = path.join(tmp, 'src', 'App.tsx');
    const content =
      `import React from 'react';\n\nexport default function App() {\n  return <button className="bg-red-500 p-4">x</button>;\n}\n`;
    await writeFile(filePath, content, 'utf8');
    return { projectPath: tmp, filePath };
  }

  function tailwindEdit(filePath: string): DesignWriteBackEdit {
    return {
      source: {
        kind: 'user-jsx',
        ref: `${filePath}:4:9`,
        className: 'bg-red-500 p-4',
        classOrigin: 'literal',
      },
      property: 'background-color',
      value: '#3b82f6',
    };
  }

  it('dispatches to the Tailwind adapter when preferredAdapter is tailwind', async () => {
    const { projectPath, filePath } = await buildTailwindProject();
    const { writeBack } = await import(
      '@main/services/style-adapters/StyleAdapterService'
    );

    const result = await writeBack({
      projectPath,
      preferredAdapter: 'tailwind',
      edits: [tailwindEdit(filePath)],
      dryRun: true,
    });

    expect(result.applied.length).toBe(1);
    const applied = result.applied[0]!;
    expect(applied.adapter).toBe('tailwind');
    expect(applied.error).toBeUndefined();
    expect(applied.diff).toBeTruthy();
    expect(applied.diff).toContain('bg-blue-500');
  });

  it('dispatches a vanilla-css preferredAdapter to the vanilla-css adapter (v0.9+)', async () => {
    // In v0.9.0 the vanilla-css, styled-components, and css-modules
    // adapters all exist. Dispatching to vanilla-css now actually
    // runs the adapter — if it can't resolve a rule for the class it
    // falls back to a style-prop write on the JSX file, so the result
    // is OK and the file has been touched.
    const { projectPath, filePath } = await buildTailwindProject();
    const { writeBack } = await import(
      '@main/services/style-adapters/StyleAdapterService'
    );

    const result = await writeBack({
      projectPath,
      preferredAdapter: 'vanilla-css',
      edits: [tailwindEdit(filePath)],
      dryRun: true,
    });

    expect(result.applied.length).toBe(1);
    const applied = result.applied[0]!;
    expect(applied.adapter).toBe('vanilla-css');
    // The Tailwind project has no plain .css file matching `bg-red-500`,
    // so vanilla-css falls back to style-prop write on the JSX file —
    // result should NOT carry a "not implemented" error.
    if (applied.error) {
      expect(applied.error.toLowerCase()).not.toMatch(/not implemented/);
    }
  });

  it('rejects an empty edits array with a top-level errorMessage', async () => {
    const { projectPath } = await buildTailwindProject();
    const { writeBack } = await import(
      '@main/services/style-adapters/StyleAdapterService'
    );

    const result = await writeBack({
      projectPath,
      preferredAdapter: 'tailwind',
      edits: [],
    });

    expect(result.ok).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.errorMessage).toBeTruthy();
  });

  it('rejects a non-absolute projectPath', async () => {
    const { writeBack } = await import(
      '@main/services/style-adapters/StyleAdapterService'
    );

    const result = await writeBack({
      projectPath: 'relative/path',
      preferredAdapter: 'tailwind',
      edits: [
        {
          source: {
            kind: 'user-jsx',
            ref: '/whatever:1:1',
            classOrigin: 'literal',
          },
          property: 'background-color',
          value: '#3b82f6',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errorMessage?.toLowerCase()).toMatch(/absolute|projectpath/);
  });
});
