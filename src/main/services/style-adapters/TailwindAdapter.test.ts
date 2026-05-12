// Integration tests for the Tailwind StyleAdapter. We write a real JSX
// file to a tmpdir project, invoke `applyEdit`, then read the file back
// to confirm the splice landed exactly where we expected. No mocks of
// the adapter itself — only `electron` (to keep transitive imports happy
// under vitest) so the adapter exercises its actual @babel/parser path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { DesignWriteBackEdit } from '@shared/design';

// `@shared/logger` is consumed by the adapter; it pulls in `electron`
// transitively in real builds. Mirror the established test pattern.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

// ─── helpers ───────────────────────────────────────────────────────────────

const APP_TSX_HEADER = `import React from 'react';\n\nexport default function App() {\n  `;
// The 4th line starts with two spaces + `return `. Length of `  return `
// is 9 chars, so `<` sits at column 9 (0-based). The adapter tolerates
// ±8 drift so either 9 or 10 works.
const RETURN_PREFIX = '  return ';
const RETURN_LINE = 4;
const RETURN_COL = RETURN_PREFIX.length; // 9 (0-based of `<`)

function makeAppTsx(jsx: string): string {
  return `${APP_TSX_HEADER}return ${jsx};\n}\n`;
}

async function writeProject(
  tmp: string,
  jsx: string,
): Promise<{ projectPath: string; filePath: string }> {
  const projectPath = tmp;
  await mkdir(path.join(projectPath, 'src'), { recursive: true });
  await writeFile(
    path.join(projectPath, 'package.json'),
    JSON.stringify({
      name: 'test-project',
      version: '0.0.0',
      dependencies: { react: '^19.0.0' },
      devDependencies: { tailwindcss: '^3.4.0' },
    }),
    'utf8',
  );
  await writeFile(
    path.join(projectPath, 'tailwind.config.ts'),
    `export default { content: ['./src/**/*.tsx'], theme: {}, plugins: [] };\n`,
    'utf8',
  );
  const filePath = path.join(projectPath, 'src', 'App.tsx');
  await writeFile(filePath, makeAppTsx(jsx), 'utf8');
  return { projectPath, filePath };
}

function buildEdit(opts: {
  filePath: string;
  line?: number;
  col?: number;
  className?: string;
  classOrigin?: 'literal' | 'computed' | 'absent';
  property: string;
  value: string;
  tailwindClass?: string;
}): DesignWriteBackEdit {
  return {
    source: {
      kind: 'user-jsx',
      ref: `${opts.filePath}:${opts.line ?? RETURN_LINE}:${opts.col ?? RETURN_COL}`,
      className: opts.className,
      classOrigin: opts.classOrigin ?? 'literal',
    },
    property: opts.property,
    value: opts.value,
    tailwindClass: opts.tailwindClass,
  };
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('TailwindAdapter.applyEdit', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-tailwind-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('swaps a single conflicting class while leaving siblings intact', async () => {
    const { projectPath, filePath } = await writeProject(
      tmp,
      `<button className="bg-red-500 p-4">x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath,
        className: 'bg-red-500 p-4',
        property: 'background-color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    expect(result.adapter).toBe('tailwind');
    const updated = await readFile(filePath, 'utf8');
    expect(updated).toContain('className="bg-blue-500 p-4"');
    expect(updated).not.toContain('bg-red-500');
  });

  it('respects multi-class strings — only the conflicting prefix is replaced', async () => {
    const { projectPath, filePath } = await writeProject(
      tmp,
      `<button className="bg-red-500 text-white p-4 rounded">x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath,
        className: 'bg-red-500 text-white p-4 rounded',
        property: 'padding',
        value: '8px',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(filePath, 'utf8');
    // 8px → tailwind spacing `2`.
    expect(updated).toContain('className="bg-red-500 text-white p-2 rounded"');
  });

  it('appends the new class when there is no existing class in that group', async () => {
    const { projectPath, filePath } = await writeProject(
      tmp,
      `<button className="font-bold">x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath,
        className: 'font-bold',
        property: 'background-color',
        value: '#ffffff',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(filePath, 'utf8');
    expect(updated).toContain('font-bold');
    expect(updated).toContain('bg-white');
    // Order: original survivor, then appended.
    expect(updated).toMatch(/className="font-bold\s+bg-white"/);
  });

  it('emits arbitrary-value syntax for an off-palette hex', async () => {
    const { projectPath, filePath } = await writeProject(
      tmp,
      `<button className="bg-red-500">x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath,
        className: 'bg-red-500',
        property: 'background-color',
        value: '#7f00ff',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(filePath, 'utf8');
    expect(updated).toContain('className="bg-[#7f00ff]"');
  });

  it('falls back to a style={{...}} write when classOrigin is computed', async () => {
    // `cn(buttonClasses)` is a computed className — the adapter can't
    // safely swap into it, so it adds a style attribute instead.
    const { projectPath, filePath } = await writeProject(
      tmp,
      `<button className={cn(buttonClasses)}>x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath,
        classOrigin: 'computed',
        property: 'color',
        value: '#ff0000',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(filePath, 'utf8');
    // className expression unchanged.
    expect(updated).toContain('className={cn(buttonClasses)}');
    // New style prop added with the computed color.
    expect(updated).toContain('style={{ color:');
    expect(updated).toContain("'#ff0000'");
  });

  it('updates an existing style key in a literal style={{...}} object', async () => {
    const { projectPath, filePath } = await writeProject(
      tmp,
      `<button style={{ color: 'red' }}>x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath,
        classOrigin: 'absent',
        property: 'color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeUndefined();
    const updated = await readFile(filePath, 'utf8');
    // The value-only splice replaces just the StringLiteral. The colon's
    // trailing space plus the replacement's leading space yields two
    // spaces between `color:` and the new value — keep the test loose
    // around whitespace so we don't lock in cosmetic punctuation.
    expect(updated).toMatch(/color:\s+'#3b82f6'/);
    // The old value is gone.
    expect(updated).not.toContain("'red'");
  });

  it('honours dryRun — disk is untouched, diff is populated', async () => {
    const jsx = `<button className="bg-red-500 p-4">x</button>`;
    const { projectPath, filePath } = await writeProject(tmp, jsx);
    const originalContent = await readFile(filePath, 'utf8');

    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath,
        className: 'bg-red-500 p-4',
        property: 'background-color',
        value: '#3b82f6',
      }),
      true,
    );

    expect(result.error).toBeUndefined();
    expect(typeof result.diff).toBe('string');
    expect(result.diff).toContain('---');
    expect(result.diff).toContain('+++');
    expect(result.diff).toContain('bg-red-500');
    expect(result.diff).toContain('bg-blue-500');
    // Disk really did NOT change.
    const afterContent = await readFile(filePath, 'utf8');
    expect(afterContent).toBe(originalContent);
  });

  it('returns an error when the source.ref line/col does not resolve to a JSX element', async () => {
    const { projectPath, filePath } = await writeProject(
      tmp,
      `<button className="bg-red-500">x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const originalContent = await readFile(filePath, 'utf8');
    // Line 2 of our scaffold is the blank line between the import and the
    // function — no JSX there.
    const result = await applyEdit(
      projectPath,
      buildEdit({
        filePath,
        line: 2,
        col: 0,
        className: 'bg-red-500',
        property: 'background-color',
        value: '#3b82f6',
      }),
      false,
    );

    expect(result.error).toBeTruthy();
    expect(result.error?.toLowerCase()).toContain('jsx element not found');
    // No file mutation when the lookup fails.
    expect(await readFile(filePath, 'utf8')).toBe(originalContent);
  });

  it('rejects a source.ref outside the project root', async () => {
    const { projectPath } = await writeProject(
      tmp,
      `<button className="bg-red-500">x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    // /etc/passwd is guaranteed to live outside the tmp project root.
    const result = await applyEdit(
      projectPath,
      {
        source: {
          kind: 'user-jsx',
          ref: `/etc/passwd:1:1`,
          className: 'bg-red-500',
          classOrigin: 'literal',
        },
        property: 'background-color',
        value: '#3b82f6',
      },
      false,
    );

    expect(result.error).toBeTruthy();
    // The error must come from the path-validation layer, not from babel
    // failing to parse /etc/passwd — match the actual messages either way.
    expect(result.error?.toLowerCase()).toMatch(/escape|outside|forbidden|not found|project/);
  });

  it('returns an error when the source.ref file does not exist', async () => {
    const { projectPath } = await writeProject(
      tmp,
      `<button className="bg-red-500">x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const result = await applyEdit(
      projectPath,
      {
        source: {
          kind: 'user-jsx',
          ref: `${projectPath}/src/Missing.tsx:1:1`,
          className: '',
          classOrigin: 'literal',
        },
        property: 'background-color',
        value: '#3b82f6',
      },
      false,
    );

    expect(result.error).toBeTruthy();
    expect(result.error?.toLowerCase()).toMatch(/not found|enoent/);
  });

  it('returns an error when source.ref is missing', async () => {
    const { projectPath } = await writeProject(
      tmp,
      `<button className="bg-red-500">x</button>`,
    );
    const { applyEdit } = await import(
      '@main/services/style-adapters/TailwindAdapter'
    );

    const result = await applyEdit(
      projectPath,
      {
        // Deliberately missing ref to exercise validation. Cast via
        // `unknown` so TS doesn't reject the malformed shape.
        source: { kind: 'user-jsx' } as unknown as DesignWriteBackEdit['source'],
        property: 'background-color',
        value: '#3b82f6',
      },
      false,
    );

    expect(result.error).toBeTruthy();
  });
});
