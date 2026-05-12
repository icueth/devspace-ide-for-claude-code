// Integration tests for the vanilla-CSS StyleAdapter. We write a real
// JSX file + one or more `.css` files to a tmpdir project, invoke
// `applyEdit`, then read the affected files back to confirm the splice
// landed in the right rule (or, for the style-prop fallback, on the
// JSX element). No mocks of the adapter itself — only `electron`
// (transitively pulled in by `@shared/logger`) so the import resolves
// under vitest's node environment.
//
// Cases (per Phase C3b spec):
//   1. Resolve FIRST className to a rule and update its declaration.
//   2. Resolve SECOND className when the first has no matching rule.
//   3. No matching rule → style-prop fallback on the JSX element.
//   4. Multiple CSS files — rule lives in `theme.css`, adapter finds it.
//   5. Multi-selector rule (`.btn, .button { ... }`) — body update works.
//   6. Property already exists → in-place value swap.
//   7. Property absent → declaration appended before `}`.
//   8. Commented `.btn` MUST NOT match the live rule of a different class.
//   9. Dry-run — disk untouched, `result.diff` populated.
//   10. Unsafe value (`red; }`) rejected, file unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { DesignWriteBackEdit } from '@shared/design';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// ─── helpers ───────────────────────────────────────────────────────────────

interface FileSpec {
  relPath: string;
  content: string;
}

const APP_TSX_HEADER = `import React from 'react';\n\nexport default function App() {\n  `;
const RETURN_LINE = 4;
const RETURN_COL = '  return '.length;

function makeAppTsx(jsx: string): string {
  return `${APP_TSX_HEADER}return ${jsx};\n}\n`;
}

async function writeProject(
  tmp: string,
  jsx: string,
  cssFiles: FileSpec[],
): Promise<{ projectPath: string; appPath: string }> {
  const projectPath = tmp;
  await mkdir(path.join(projectPath, 'src'), { recursive: true });
  await writeFile(
    path.join(projectPath, 'package.json'),
    JSON.stringify({
      name: 'test-project',
      version: '0.0.0',
      dependencies: { react: '^19.0.0' },
    }),
    'utf8',
  );
  const appPath = path.join(projectPath, 'src', 'App.tsx');
  await writeFile(appPath, makeAppTsx(jsx), 'utf8');
  for (const f of cssFiles) {
    const abs = path.join(projectPath, f.relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content, 'utf8');
  }
  return { projectPath, appPath };
}

function buildEdit(opts: {
  filePath: string;
  className: string;
  property: string;
  value: string;
}): DesignWriteBackEdit {
  return {
    source: {
      kind: 'user-jsx',
      ref: `${opts.filePath}:${RETURN_LINE}:${RETURN_COL}`,
      className: opts.className,
      classOrigin: 'literal',
    },
    property: opts.property,
    value: opts.value,
  };
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('VanillaCssAdapter.applyEdit', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-vanilla-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('resolves the first className to a rule and updates the property', async () => {
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="btn primary">x</button>`,
      [
        {
          relPath: 'src/styles.css',
          content: `.btn {\n  background: red;\n}\n.primary {\n  color: white;\n}\n`,
        },
      ],
    );
    const appBefore = await readFile(appPath, 'utf8');

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'btn primary',
        property: 'background-color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    expect(result.adapter).toBe('vanilla-css');
    const css = await readFile(path.join(projectPath, 'src/styles.css'), 'utf8');
    // The `.btn` rule got the new property. The original `background: red`
    // declaration is a SHORTHAND; the adapter may append the longhand
    // alongside it rather than overwriting. Either way:
    //   - `#3b82f6` must appear inside the `.btn` rule.
    //   - the `.primary` rule's `color: white` must be untouched.
    expect(css).toMatch(/\.btn\s*\{[\s\S]*#3b82f6[\s\S]*\}/);
    expect(css).toMatch(/\.primary\s*\{[\s\S]*color:\s*white[\s\S]*\}/);
    // JSX file untouched (the className path did NOT fall through to
    // the style-prop fallback).
    expect(await readFile(appPath, 'utf8')).toBe(appBefore);
  });

  it('uses the second className when the first has no matching rule', async () => {
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="nonexistent primary">x</button>`,
      [
        {
          relPath: 'src/styles.css',
          content: `.primary {\n  color: red;\n}\n`,
        },
      ],
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'nonexistent primary',
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const css = await readFile(path.join(projectPath, 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.primary\s*\{[\s\S]*#3b82f6[\s\S]*\}/);
    expect(css).not.toContain('color: red');
  });

  it('falls back to a style={{...}} write when no className matches', async () => {
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="nothing-matches">x</button>`,
      [
        // A CSS file exists but defines a different class.
        {
          relPath: 'src/styles.css',
          content: `.other-thing {\n  color: red;\n}\n`,
        },
      ],
    );
    const cssBefore = await readFile(
      path.join(projectPath, 'src/styles.css'),
      'utf8',
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'nothing-matches',
        property: 'padding',
        value: '4px',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updatedJsx = await readFile(appPath, 'utf8');
    // The style-prop fallback added an inline style. The exact shape
    // is up to the writer (`style={{ padding: '4px' }}` vs.
    // `style={{padding:'4px'}}`); match permissively.
    expect(updatedJsx).toMatch(/style=\{\{[^}]*padding[^}]*['"]4px['"][^}]*\}\}/);
    // CSS file MUST be untouched.
    expect(
      await readFile(path.join(projectPath, 'src/styles.css'), 'utf8'),
    ).toBe(cssBefore);
  });

  it('finds the rule across MULTIPLE CSS files', async () => {
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="theme-only">x</button>`,
      [
        {
          relPath: 'src/styles.css',
          content: `.unrelated {\n  color: red;\n}\n`,
        },
        {
          relPath: 'src/theme.css',
          content: `.theme-only {\n  color: red;\n}\n`,
        },
      ],
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'theme-only',
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const themeCss = await readFile(
      path.join(projectPath, 'src/theme.css'),
      'utf8',
    );
    const stylesCss = await readFile(
      path.join(projectPath, 'src/styles.css'),
      'utf8',
    );
    expect(themeCss).toContain('#3b82f6');
    // The unrelated stylesheet must be untouched.
    expect(stylesCss).toContain('color: red');
    expect(stylesCss).not.toContain('#3b82f6');
  });

  it('updates a rule with a multi-selector head (`.btn, .button`)', async () => {
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="btn">x</button>`,
      [
        {
          relPath: 'src/styles.css',
          content: `.btn, .button {\n  color: red;\n}\n`,
        },
      ],
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'btn',
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const css = await readFile(path.join(projectPath, 'src/styles.css'), 'utf8');
    // Selector head is preserved verbatim; only the body changed.
    expect(css).toContain('.btn, .button {');
    expect(css).toContain('#3b82f6');
    expect(css).not.toContain('color: red');
  });

  it('swaps an existing property value in place', async () => {
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="btn">x</button>`,
      [
        {
          relPath: 'src/styles.css',
          content: `.btn {\n  color: red;\n  padding: 4px;\n}\n`,
        },
      ],
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'btn',
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const css = await readFile(path.join(projectPath, 'src/styles.css'), 'utf8');
    expect(css).toContain('#3b82f6');
    // The unrelated `padding: 4px` declaration survives.
    expect(css).toContain('padding: 4px');
    expect(css).not.toContain('color: red');
  });

  it('appends a new declaration when the property is absent', async () => {
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="btn">x</button>`,
      [
        {
          relPath: 'src/styles.css',
          content: `.btn {\n  color: red;\n}\n`,
        },
      ],
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'btn',
        property: 'border-radius',
        value: '4px',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const css = await readFile(path.join(projectPath, 'src/styles.css'), 'utf8');
    // Original color survives.
    expect(css).toContain('color: red');
    // New declaration was appended inside the rule body, before the `}`.
    expect(css).toMatch(/\.btn\s*\{[\s\S]*border-radius:\s*4px[\s\S]*\}/);
  });

  it('does NOT match a class name that only appears inside a CSS comment', async () => {
    // The comment mentions `.btn`. The live rule is `.btn-real`. Looking
    // up `btn` MUST NOT find the comment, and lookup MUST NOT mistakenly
    // edit `.btn-real`. Result: no rule matches → style-prop fallback.
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="btn">x</button>`,
      [
        {
          relPath: 'src/styles.css',
          content: `/* .btn is the primary button */\n.btn-real {\n  color: red;\n}\n`,
        },
      ],
    );
    const cssBefore = await readFile(
      path.join(projectPath, 'src/styles.css'),
      'utf8',
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'btn',
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    // CSS file untouched — the comment's `.btn` was correctly ignored AND
    // the live `.btn-real` rule was NOT incorrectly matched. The edit
    // falls through to the style-prop fallback on the JSX element.
    expect(
      await readFile(path.join(projectPath, 'src/styles.css'), 'utf8'),
    ).toBe(cssBefore);
    const updatedJsx = await readFile(appPath, 'utf8');
    expect(updatedJsx).toMatch(/style=\{\{[^}]*color[^}]*['"]#3b82f6['"][^}]*\}\}/);
  });

  it('dry-run leaves the CSS untouched and populates result.diff', async () => {
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="btn">x</button>`,
      [
        {
          relPath: 'src/styles.css',
          content: `.btn {\n  color: red;\n}\n`,
        },
      ],
    );
    const cssBefore = await readFile(
      path.join(projectPath, 'src/styles.css'),
      'utf8',
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'btn',
        property: 'color',
        value: '#3b82f6',
      }),
      true,
    );

    expect(result.error).toBeUndefined();
    expect(typeof result.diff).toBe('string');
    expect(result.diff).toContain('---');
    expect(result.diff).toContain('+++');
    expect(result.diff).toContain('red');
    expect(result.diff).toContain('#3b82f6');
    expect(
      await readFile(path.join(projectPath, 'src/styles.css'), 'utf8'),
    ).toBe(cssBefore);
  });

  it('rejects an unsafe value and leaves the file unchanged', async () => {
    const { projectPath, appPath } = await writeProject(
      tmp,
      `<button className="btn">x</button>`,
      [
        {
          relPath: 'src/styles.css',
          content: `.btn {\n  color: red;\n}\n`,
        },
      ],
    );
    const cssBefore = await readFile(
      path.join(projectPath, 'src/styles.css'),
      'utf8',
    );

    const { applyEdit } = await import(
      '@main/services/style-adapters/VanillaCssAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath: appPath,
        className: 'btn',
        property: 'color',
        // `red; }` is the canonical adversarial value — it could close
        // the declaration and the block, allowing an attacker to inject
        // a new rule. The adapter MUST refuse it.
        value: 'red; }',
      }),
      false,
    );

    expect(result.error).toBeTruthy();
    expect(
      await readFile(path.join(projectPath, 'src/styles.css'), 'utf8'),
    ).toBe(cssBefore);
  });
});
