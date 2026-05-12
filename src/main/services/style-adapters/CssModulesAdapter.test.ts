// Integration tests for the CSS-Modules StyleAdapter. We write a real
// `.module.css` (and its JSX consumer) to a tmpdir project, hand the
// adapter the hashed runtime class names the bridge would emit, and
// confirm the rule body in the `.module.css` file is edited as the
// spec requires. No mocks of the adapter itself — only `electron`
// (transitively pulled in by `@shared/logger`) so the import resolves
// under vitest's node environment.
//
// Three de-hash conventions covered (matches `dehashRuntimeClass` in
// CssModulesAdapter.ts):
//   1. `<base>__<class>--<hash>`   (Next.js / CRA css-loader default)
//   2. `<class>--<hash>`           (Vite's CSS Modules default)
//   3. `<class>_<hash>`            (Webpack older default, class>=3 chars)
//
// Plus a co-located-preference test (multiple `.module.css` files; the
// one in the same directory as the JSX consumer wins), a multi-class
// element test, a no-match test, a `composes:` non-follow test, a
// `:hover` pseudo-class non-pick test, and the standard dry-run +
// unsafe-value pair.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { DesignWriteBackEdit } from '@shared/design';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// ─── helpers ───────────────────────────────────────────────────────────────

interface FileSpec {
  relPath: string;     // relative to projectPath
  content: string;
}

async function writeProject(
  tmp: string,
  files: FileSpec[],
): Promise<{ projectPath: string }> {
  const projectPath = tmp;
  await writeFile(
    path.join(projectPath, 'package.json'),
    JSON.stringify({
      name: 'test-project',
      version: '0.0.0',
      dependencies: { react: '^19.0.0' },
    }),
    'utf8',
  );
  for (const f of files) {
    const abs = path.join(projectPath, f.relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, 'utf8');
  }
  return { projectPath };
}

function buildEdit(opts: {
  consumerPath: string;
  cssModuleClasses: string[];
  property: string;
  value: string;
}): DesignWriteBackEdit {
  return {
    source: {
      kind: 'user-jsx',
      ref: `${opts.consumerPath}:1:0`,
      cssModuleClasses: opts.cssModuleClasses,
      classOrigin: 'literal',
    },
    property: opts.property,
    value: opts.value,
  };
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('CssModulesAdapter.applyEdit', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-css-mod-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('de-hashes `<base>__<class>--<hash>` and edits the rule', async () => {
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/Button.tsx',
        content: `export default function Button() { return null; }\n`,
      },
      {
        relPath: 'src/Button.module.css',
        content: `.primary {\n  color: red;\n}\n`,
      },
    ]);

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Button.tsx'),
        cssModuleClasses: ['Button__primary--abc123'],
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    expect(result.adapter).toBe('css-modules');
    const updated = await readFile(
      path.join(projectPath, 'src/Button.module.css'),
      'utf8',
    );
    expect(updated).toContain('#3b82f6');
    expect(updated).not.toContain('color: red');
  });

  it('de-hashes `<class>--<hash>` and edits the rule', async () => {
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/Card.tsx',
        content: `export default function Card() { return null; }\n`,
      },
      {
        relPath: 'src/Card.module.css',
        content: `.primary {\n  color: red;\n}\n`,
      },
    ]);

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Card.tsx'),
        cssModuleClasses: ['primary--xyz789'],
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(
      path.join(projectPath, 'src/Card.module.css'),
      'utf8',
    );
    expect(updated).toContain('#3b82f6');
  });

  it('de-hashes `<class>_<hash>` when class is >=3 chars', async () => {
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/Item.tsx',
        content: `export default function Item() { return null; }\n`,
      },
      {
        relPath: 'src/Item.module.css',
        content: `.primary {\n  color: red;\n}\n`,
      },
    ]);

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Item.tsx'),
        cssModuleClasses: ['primary_xyz789'],
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(
      path.join(projectPath, 'src/Item.module.css'),
      'utf8',
    );
    expect(updated).toContain('#3b82f6');
  });

  it('works on an un-hashed (identity) runtime class', async () => {
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/Plain.tsx',
        content: `export default function Plain() { return null; }\n`,
      },
      {
        relPath: 'src/Plain.module.css',
        content: `.simple {\n  color: red;\n}\n`,
      },
    ]);

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Plain.tsx'),
        cssModuleClasses: ['simple'],
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(
      path.join(projectPath, 'src/Plain.module.css'),
      'utf8',
    );
    expect(updated).toContain('#3b82f6');
  });

  it('prefers a co-located `.module.css` over a distant one', async () => {
    // Both files define a `.primary` rule. The adapter must pick the one
    // co-located with the JSX consumer (same dir) over the distant one.
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/components/Button.tsx',
        content: `export default function Button() { return null; }\n`,
      },
      {
        // co-located (winner)
        relPath: 'src/components/Button.module.css',
        content: `.primary {\n  color: green;\n}\n`,
      },
      {
        // distant (loser)
        relPath: 'src/other/Other.module.css',
        content: `.primary {\n  color: red;\n}\n`,
      },
    ]);

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/components/Button.tsx'),
        cssModuleClasses: ['Button__primary--abc123'],
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    // The adapter realpath()s the target — on macOS the tmpdir is
    // `/var/folders/...` but realpath returns `/private/var/folders/...`.
    // Compare against the canonical path so the test is host-portable.
    const expectedReal = await realpath(
      path.join(projectPath, 'src/components/Button.module.css'),
    );
    expect(result.filePath).toBe(expectedReal);
    const colocated = await readFile(
      path.join(projectPath, 'src/components/Button.module.css'),
      'utf8',
    );
    const distant = await readFile(
      path.join(projectPath, 'src/other/Other.module.css'),
      'utf8',
    );
    expect(colocated).toContain('#3b82f6');
    expect(colocated).not.toContain('color: green');
    // The distant file MUST be untouched.
    expect(distant).toContain('color: red');
    expect(distant).not.toContain('#3b82f6');
  });

  it('multi-class element — first class that resolves wins', async () => {
    // Element has TWO runtime classes. The first matches a rule in the
    // co-located module; the second matches nothing. The adapter must
    // edit the first.
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/Item.tsx',
        content: `export default function Item() { return null; }\n`,
      },
      {
        relPath: 'src/Item.module.css',
        content: `.primary {\n  color: red;\n}\n`,
      },
    ]);

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Item.tsx'),
        cssModuleClasses: ['Button__primary--abc123', 'utility__x--deadbf'],
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(
      path.join(projectPath, 'src/Item.module.css'),
      'utf8',
    );
    expect(updated).toContain('#3b82f6');
  });

  it('returns an error when no rule resolves in any module file', async () => {
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/Empty.tsx',
        content: `export default function Empty() { return null; }\n`,
      },
      {
        relPath: 'src/Empty.module.css',
        content: `.something-else {\n  color: red;\n}\n`,
      },
    ]);
    const cssBefore = await readFile(
      path.join(projectPath, 'src/Empty.module.css'),
      'utf8',
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Empty.tsx'),
        cssModuleClasses: ['NothingMatches_what__abc123'],
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeTruthy();
    expect(
      await readFile(path.join(projectPath, 'src/Empty.module.css'), 'utf8'),
    ).toBe(cssBefore);
  });

  it('does NOT follow `composes:` — only the direct rule is edited', async () => {
    // `.primary` composes `parent`. The adapter must edit `.primary`
    // directly, NOT follow the `composes:` chain to `.parent`.
    const cssBody = [
      `.parent {`,
      `  color: green;`,
      `}`,
      ``,
      `.primary {`,
      `  composes: parent;`,
      `  color: red;`,
      `}`,
      ``,
    ].join('\n');
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/Composed.tsx',
        content: `export default function Composed() { return null; }\n`,
      },
      {
        relPath: 'src/Composed.module.css',
        content: cssBody,
      },
    ]);

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Composed.tsx'),
        cssModuleClasses: ['Composed__primary--abc123'],
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(
      path.join(projectPath, 'src/Composed.module.css'),
      'utf8',
    );
    // The `.primary` body got the new color.
    expect(updated).toMatch(/\.primary\s*\{[\s\S]*#3b82f6[\s\S]*\}/);
    // The `.parent` body was NOT followed — its `color: green` survives.
    expect(updated).toMatch(/\.parent\s*\{[\s\S]*color:\s*green[\s\S]*\}/);
  });

  it('does NOT pick `.primary:hover` over the base `.primary` rule', async () => {
    // Base + pseudo variant share the same property; the base must win.
    const cssBody = [
      `.primary {`,
      `  color: red;`,
      `}`,
      ``,
      `.primary:hover {`,
      `  color: blue;`,
      `}`,
      ``,
    ].join('\n');
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/Hov.tsx',
        content: `export default function Hov() { return null; }\n`,
      },
      {
        relPath: 'src/Hov.module.css',
        content: cssBody,
      },
    ]);

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Hov.tsx'),
        cssModuleClasses: ['Hov__primary--abc123'],
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(
      path.join(projectPath, 'src/Hov.module.css'),
      'utf8',
    );
    // Base rule's color is updated.
    expect(updated).toMatch(/\.primary\s*\{[\s\S]*#3b82f6[\s\S]*\}/);
    // `:hover` variant is untouched — its `color: blue` survives.
    expect(updated).toMatch(/\.primary:hover\s*\{[\s\S]*color:\s*blue[\s\S]*\}/);
    expect(updated).not.toMatch(/\.primary:hover\s*\{[\s\S]*#3b82f6/);
  });

  it('dry-run leaves disk untouched and populates result.diff; unsafe value is rejected', async () => {
    const { projectPath } = await writeProject(tmp, [
      {
        relPath: 'src/Dry.tsx',
        content: `export default function Dry() { return null; }\n`,
      },
      {
        relPath: 'src/Dry.module.css',
        content: `.primary {\n  color: red;\n}\n`,
      },
    ]);
    const cssBefore = await readFile(
      path.join(projectPath, 'src/Dry.module.css'),
      'utf8',
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/CssModulesAdapter'
    );

    // Dry-run.
    const dryResult = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Dry.tsx'),
        cssModuleClasses: ['Dry__primary--abc123'],
        property: 'color',
        value: '#3b82f6',
      }),
      true,
    );
    expect(dryResult.error).toBeUndefined();
    expect(typeof dryResult.diff).toBe('string');
    expect(dryResult.diff).toContain('---');
    expect(dryResult.diff).toContain('+++');
    expect(dryResult.diff).toContain('red');
    expect(dryResult.diff).toContain('#3b82f6');
    expect(
      await readFile(path.join(projectPath, 'src/Dry.module.css'), 'utf8'),
    ).toBe(cssBefore);

    // Unsafe value — must be refused, file must remain untouched.
    const unsafeResult = await applyEdit(
      projectPath,
      buildEdit({
        consumerPath: path.join(projectPath, 'src/Dry.tsx'),
        cssModuleClasses: ['Dry__primary--abc123'],
        property: 'color',
        value: 'red; }',
      }),
      false,
    );
    expect(unsafeResult.error).toBeTruthy();
    expect(
      await readFile(path.join(projectPath, 'src/Dry.module.css'), 'utf8'),
    ).toBe(cssBefore);
  });
});
