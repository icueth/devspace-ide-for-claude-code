// Integration tests for the styled-components StyleAdapter. We write a
// real JS/TSX file with a styled-components declaration to a tmpdir
// project, invoke `applyEdit`, then read the file back to confirm the
// template literal was spliced precisely. No mocks of the adapter
// itself — only `electron` to keep transitive `@shared/logger` imports
// happy under vitest's node environment.
//
// The adapter's contract (see header of StyledComponentsAdapter.ts):
//   1. `source.styledComponent.ref` (or fallback `source.ownerRef`)
//      points at the declaration's TaggedTemplateExpression.
//   2. We rewrite the CSS body of that tagged template, preserving
//      every interpolation byte-for-byte. Edits that would straddle an
//      interpolation are refused with an error.
//   3. Tag must be a recognized styled-components form
//      (`styled.div`, `styled(Base)`, `styled.div.attrs({...})`). Bare
//      `css\`...\`` / `keyframes\`...\`` are refused.
//   4. Values pass an allowlist regex; anything outside it (backtick,
//      `${`, `;`, etc.) is rejected.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { DesignWriteBackEdit } from '@shared/design';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// ─── helpers ───────────────────────────────────────────────────────────────

async function writeProject(
  tmp: string,
  fileName: string,
  source: string,
): Promise<{ projectPath: string; filePath: string }> {
  const projectPath = tmp;
  await mkdir(path.join(projectPath, 'src'), { recursive: true });
  await writeFile(
    path.join(projectPath, 'package.json'),
    JSON.stringify({
      name: 'test-project',
      version: '0.0.0',
      dependencies: { react: '^19.0.0', 'styled-components': '^6.0.0' },
    }),
    'utf8',
  );
  const filePath = path.join(projectPath, 'src', fileName);
  await writeFile(filePath, source, 'utf8');
  return { projectPath, filePath };
}

/**
 * Find the 1-based line / 0-based column of a substring in `source`.
 * Used to point `styledComponent.ref` at the start of the
 * TaggedTemplateExpression — the tag itself, NOT a `styled` keyword
 * elsewhere on the page (e.g. inside an `import` statement).
 */
function locateSubstring(source: string, needle: string): { line: number; col: number } {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i]!.indexOf(needle);
    if (idx >= 0) return { line: i + 1, col: idx };
  }
  throw new Error(`test fixture missing substring: ${needle}`);
}

/**
 * Convenience for the common case — find the first `styled.<tag>` /
 * `styled(<base>)` declaration site (not an import). Searches for
 * `styled.` or `styled(` so the IMPORT line is skipped.
 */
function locateStyledDecl(source: string): { line: number; col: number } {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip lines that look like imports.
    if (/^\s*import\b/.test(line)) continue;
    const dot = line.indexOf('styled.');
    const call = line.indexOf('styled(');
    const candidates = [dot, call].filter((n) => n >= 0);
    if (candidates.length === 0) continue;
    const idx = Math.min(...candidates);
    return { line: i + 1, col: idx };
  }
  throw new Error('test fixture missing a `styled.<tag>` / `styled(...)` declaration');
}

function buildEdit(opts: {
  filePath: string;
  line: number;
  col: number;
  property: string;
  value: string;
}): DesignWriteBackEdit {
  return {
    source: {
      kind: 'user-jsx',
      ref: `${opts.filePath}:1:0`,           // consumer ref — unused by this adapter
      styledComponent: {
        displayName: 'Button',
        ref: `${opts.filePath}:${opts.line}:${opts.col}`,
      },
      classOrigin: 'literal',
    },
    property: opts.property,
    value: opts.value,
  };
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('StyledComponentsAdapter.applyEdit', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-sc-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rewrites a property inside a `styled.div` declaration', async () => {
    const source = [
      `import styled from 'styled-components';`,
      ``,
      `const Button = styled.div\`background: red;\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'Button.tsx', source);
    const { line, col } = locateStyledDecl(source);

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({ filePath, line, col, property: 'background', value: '#3b82f6' }),
      false,
    );

    expect(result.error).toBeUndefined();
    expect(result.adapter).toBe('styled-components');
    const updated = await readFile(filePath, 'utf8');
    expect(updated).toContain('#3b82f6');
    expect(updated).not.toContain('red');
  });

  it('rewrites a property inside a `styled(Base)` declaration', async () => {
    const source = [
      `import styled from 'styled-components';`,
      `import { BaseButton } from './BaseButton';`,
      ``,
      `const Button = styled(BaseButton)\`color: red;\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'Button.tsx', source);
    const { line, col } = locateStyledDecl(source);

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({ filePath, line, col, property: 'color', value: '#3b82f6' }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(filePath, 'utf8');
    expect(updated).toContain('#3b82f6');
    expect(updated).not.toContain('color: red');
  });

  it('rewrites a property inside a `styled.div.attrs({...})` declaration', async () => {
    const source = [
      `import styled from 'styled-components';`,
      ``,
      `const Button = styled.div.attrs({ role: 'button' })\`color: red;\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'Button.tsx', source);
    const { line, col } = locateStyledDecl(source);

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({ filePath, line, col, property: 'color', value: '#3b82f6' }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(filePath, 'utf8');
    expect(updated).toContain('#3b82f6');
    // The `.attrs({ role: 'button' })` call must be untouched.
    expect(updated).toContain(`.attrs({ role: 'button' })`);
  });

  it('appends a new property when missing from the declaration', async () => {
    const source = [
      `import styled from 'styled-components';`,
      ``,
      `const Button = styled.div\`color: red;\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'Button.tsx', source);
    const { line, col } = locateStyledDecl(source);

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({ filePath, line, col, property: 'padding', value: '4px' }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(filePath, 'utf8');
    // Both the original color AND the new padding survive.
    expect(updated).toContain('color: red');
    expect(updated).toMatch(/padding:\s*4px/);
  });

  it('preserves untouched interpolations when editing a different property', async () => {
    // The `${theme.primary}` placeholder MUST survive byte-for-byte
    // because the adapter splices around it. We edit `background` only;
    // the color interpolation stays.
    const source = [
      `import styled from 'styled-components';`,
      `import { theme } from './theme';`,
      ``,
      `const Button = styled.div\`color: \${theme.primary}; background: red;\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'Button.tsx', source);
    const { line, col } = locateStyledDecl(source);

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({ filePath, line, col, property: 'background', value: '#3b82f6' }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(filePath, 'utf8');
    expect(updated).toContain('${theme.primary}');
    expect(updated).toContain('#3b82f6');
    expect(updated).not.toContain('background: red');
  });

  it('refuses to overwrite a property whose value is an interpolation', async () => {
    const source = [
      `import styled from 'styled-components';`,
      ``,
      `const dynamic = '#ff0000';`,
      `const Button = styled.div\`color: \${dynamic};\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'Button.tsx', source);
    const { line, col } = locateStyledDecl(source);
    const original = await readFile(filePath, 'utf8');

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({ filePath, line, col, property: 'color', value: '#3b82f6' }),
      false,
    );

    expect(result.error).toBeTruthy();
    // File untouched on rejection.
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('refuses an Emotion `css\\`...\\`` tagged template', async () => {
    const source = [
      `import { css } from '@emotion/react';`,
      ``,
      `const buttonStyles = css\`color: red;\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'styles.ts', source);
    // Position the styledComponent.ref ON the css tagged template.
    const { line, col } = locateSubstring(source, 'css`');

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({ filePath, line, col, property: 'color', value: '#3b82f6' }),
      false,
    );

    expect(result.error).toBeTruthy();
    expect(result.error?.toLowerCase()).toContain('styled-components declaration');
  });

  it('refuses a `keyframes\\`...\\`` tagged template', async () => {
    const source = [
      `import { keyframes } from 'styled-components';`,
      ``,
      `const fadeIn = keyframes\`from { opacity: 0; } to { opacity: 1; }\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'anim.ts', source);
    const { line, col } = locateSubstring(source, 'keyframes`');

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({ filePath, line, col, property: 'opacity', value: '0.5' }),
      false,
    );

    expect(result.error).toBeTruthy();
    expect(result.error?.toLowerCase()).toContain('styled-components declaration');
  });

  it('dry-run leaves disk untouched and populates result.diff', async () => {
    const source = [
      `import styled from 'styled-components';`,
      ``,
      `const Button = styled.div\`background: red;\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'Button.tsx', source);
    const original = await readFile(filePath, 'utf8');
    const { line, col } = locateStyledDecl(source);

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({ filePath, line, col, property: 'background', value: '#3b82f6' }),
      true,
    );

    expect(result.error).toBeUndefined();
    expect(typeof result.diff).toBe('string');
    expect(result.diff).toContain('---');
    expect(result.diff).toContain('+++');
    expect(result.diff).toContain('red');
    expect(result.diff).toContain('#3b82f6');
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('rejects an unsafe value containing a backtick / `${` / `;`', async () => {
    const source = [
      `import styled from 'styled-components';`,
      ``,
      `const Button = styled.div\`color: red;\`;`,
      ``,
    ].join('\n');
    const { projectPath, filePath } = await writeProject(tmp, 'Button.tsx', source);
    const original = await readFile(filePath, 'utf8');
    const { line, col } = locateStyledDecl(source);

    const { applyEdit } = await import(
      '@main/services/style-adapters/StyledComponentsAdapter'
    );
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath,
        line,
        col,
        property: 'color',
        // `red`;}` — contains a backtick AND a semicolon AND a `}`,
        // all of which the value allowlist rejects.
        value: 'red`;}',
      }),
      false,
    );

    expect(result.error).toBeTruthy();
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });
});
