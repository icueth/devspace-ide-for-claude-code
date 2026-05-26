/**
 * Unit tests for parseGitLogNumstat — the pure parser behind the Phase 2
 * (v0.34) git churn + ownership intelligence pass in CodeflowGraphAnalyzer.
 *
 * All fixtures are hand-built strings mimicking the output of:
 *   git log --no-merges --numstat --format='C%x00%an' --since='<N> days ago'
 * The NUL byte (\0) separates the literal 'C' marker from the author name on
 * each commit header line. Runs in the vitest node environment.
 */

import { describe, expect, it } from 'vitest';

import { parseGitLogNumstat } from '@main/services/CodeflowGraphAnalyzer';

// Helper: build a commit header line `C\0<author>`.
function header(author: string): string {
  return `C\0${author}`;
}

describe('parseGitLogNumstat', () => {
  it('returns an empty map for empty input', () => {
    expect(parseGitLogNumstat('').size).toBe(0);
    expect(parseGitLogNumstat('\n\n').size).toBe(0);
  });

  it('aggregates churn, adds, and dels across multiple commits', () => {
    const log = [
      header('Alice'),
      '10\t2\tsrc/a.ts',
      '5\t0\tsrc/b.ts',
      '',
      header('Alice'),
      '3\t1\tsrc/a.ts',
      '',
    ].join('\n');

    const stats = parseGitLogNumstat(log);

    const a = stats.get('src/a.ts')!;
    expect(a.churn).toBe(2); // touched by two commits
    expect(a.adds).toBe(13); // 10 + 3
    expect(a.dels).toBe(3); // 2 + 1
    expect(a.authors.get('Alice')).toBe(2);

    const b = stats.get('src/b.ts')!;
    expect(b.churn).toBe(1);
    expect(b.adds).toBe(5);
    expect(b.dels).toBe(0);
  });

  it('treats binary `-` adds/dels as 0 without breaking churn', () => {
    const log = [
      header('Bob'),
      '-\t-\tassets/logo.png',
      '4\t1\tsrc/c.ts',
      '',
    ].join('\n');

    const stats = parseGitLogNumstat(log);

    const png = stats.get('assets/logo.png')!;
    expect(png.churn).toBe(1);
    expect(png.adds).toBe(0);
    expect(png.dels).toBe(0);

    const c = stats.get('src/c.ts')!;
    expect(c.adds).toBe(4);
    expect(c.dels).toBe(1);
  });

  it('resolves brace rename path forms to the final path', () => {
    const log = [
      header('Carol'),
      '6\t2\tsrc/{old => new}/file.ts',
      '1\t0\t{ => added}/created.ts',
      '',
    ].join('\n');

    const stats = parseGitLogNumstat(log);

    expect(stats.has('src/new/file.ts')).toBe(true);
    expect(stats.get('src/new/file.ts')!.adds).toBe(6);
    // `{ => added}` collapses to `added`, no doubled slash.
    expect(stats.has('added/created.ts')).toBe(true);
    expect(stats.get('added/created.ts')!.adds).toBe(1);
  });

  it('strips the leading slash from a root-promotion brace rename', () => {
    // Git emits `{src => }/file.ts` when a file is promoted to the repo root.
    // The brace collapse leaves `/file.ts`; without the leading-slash strip it
    // would never match the root-relative node id `file.ts` (lost attribution).
    const log = [
      header('Erin'),
      '4\t1\t{src => }/file.ts',
      '',
    ].join('\n');

    const stats = parseGitLogNumstat(log);

    expect(stats.has('file.ts')).toBe(true);
    expect(stats.has('/file.ts')).toBe(false);
    expect(stats.get('file.ts')!.adds).toBe(4);
  });

  it('resolves arrow rename path forms (no braces) to the RHS path', () => {
    const log = [
      header('Dave'),
      '8\t3\told/path.ts => new/path.ts',
      '',
    ].join('\n');

    const stats = parseGitLogNumstat(log);

    expect(stats.has('new/path.ts')).toBe(true);
    expect(stats.has('old/path.ts')).toBe(false);
    expect(stats.get('new/path.ts')!.adds).toBe(8);
    expect(stats.get('new/path.ts')!.dels).toBe(3);
  });

  it('tracks multi-author ownership counts per file', () => {
    const log = [
      header('Alice'),
      '10\t0\tsrc/shared.ts',
      '',
      header('Alice'),
      '2\t1\tsrc/shared.ts',
      '',
      header('Bob'),
      '4\t0\tsrc/shared.ts',
      '',
    ].join('\n');

    const stats = parseGitLogNumstat(log);

    const shared = stats.get('src/shared.ts')!;
    expect(shared.churn).toBe(3); // 3 distinct commits
    expect(shared.authors.size).toBe(2);
    expect(shared.authors.get('Alice')).toBe(2);
    expect(shared.authors.get('Bob')).toBe(1);

    // Ownership share derivation (mirrors buildGraph logic): Alice owns 2/3.
    let topOwner: string | undefined;
    let top = 0;
    for (const [author, commits] of shared.authors) {
      if (commits > top) {
        top = commits;
        topOwner = author;
      }
    }
    expect(topOwner).toBe('Alice');
    expect(top / shared.churn).toBeCloseTo(2 / 3);
  });

  it('counts a file once per commit even if it has multiple author commits', () => {
    // Same file, same author, separate commits — each adds to churn.
    const log = [
      header('Eve'),
      '1\t0\tsrc/x.ts',
      '',
      header('Eve'),
      '1\t0\tsrc/x.ts',
      '',
    ].join('\n');

    const stats = parseGitLogNumstat(log);
    const x = stats.get('src/x.ts')!;
    expect(x.churn).toBe(2);
    expect(x.authors.get('Eve')).toBe(2);
  });

  it('handles an empty commit (header with no numstat body)', () => {
    const log = [header('Frank'), '', header('Frank'), '2\t0\tsrc/y.ts', ''].join(
      '\n',
    );
    const stats = parseGitLogNumstat(log);
    expect(stats.size).toBe(1);
    expect(stats.get('src/y.ts')!.churn).toBe(1);
  });

  it('tolerates CRLF line endings', () => {
    const log = [header('Grace'), '3\t1\tsrc/z.ts', ''].join('\r\n');
    const stats = parseGitLogNumstat(log);
    expect(stats.get('src/z.ts')!.adds).toBe(3);
    expect(stats.get('src/z.ts')!.dels).toBe(1);
  });
});
