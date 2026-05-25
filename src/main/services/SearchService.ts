import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type {
  SearchMatch,
  SearchOptions,
  SearchResult,
} from '@shared/types';

const logger = createLogger('SearchService');

const MAX_DEFAULT = 500;

// Memoize the resolved rg binary path after the first successful lookup so we
// don't run a synchronous fs.existsSync() sweep over every PATH directory on
// EVERY search (that scan blocks the main JS thread). The resolved path is
// stable for the process lifetime; a failed lookup is NOT cached so a later
// search retries once rg becomes installed/available.
let cachedRgPath: string | null = null;

async function findRg(): Promise<string | null> {
  if (cachedRgPath !== null) return cachedRgPath;
  const env = await resolveInteractiveShellEnv();
  const path = env.PATH ?? process.env.PATH ?? '';
  if (!path) return null;
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/rg${ext}`;
      if (fs.existsSync(candidate)) {
        cachedRgPath = candidate;
        return candidate;
      }
    }
  }
  return null;
}

/** Test-only: reset the memoized rg path between cases. */
export function __resetRgPathCacheForTests(): void {
  cachedRgPath = null;
}

interface RgMatchRange {
  start: number;
  end: number;
}

interface RgMatch {
  path: { text: string };
  lines: { text: string };
  line_number: number;
  absolute_offset: number;
  submatches: Array<{ match: { text: string }; start: number; end: number }>;
}

function parseRgLine(line: string, cwd: string): SearchMatch | null {
  try {
    const obj = JSON.parse(line) as { type: string; data: RgMatch };
    if (obj.type !== 'match') return null;
    const d = obj.data;
    const abs = d.path.text.startsWith('/') ? d.path.text : `${cwd}/${d.path.text}`;
    const ranges: RgMatchRange[] = d.submatches.map((m) => ({
      start: m.start,
      end: m.end,
    }));
    return {
      file: abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs,
      absolutePath: abs,
      line: d.line_number,
      column: d.submatches[0]?.start ?? 0,
      lineText: d.lines.text.replace(/\n$/, ''),
      ranges,
    };
  } catch {
    return null;
  }
}

export async function grepProject(
  cwd: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const start = Date.now();
  const maxResults = opts.maxResults ?? MAX_DEFAULT;
  const trimmed = query.trim();
  if (!trimmed) {
    return { matches: [], truncated: false, engine: 'ripgrep', elapsedMs: 0 };
  }

  const rg = await findRg();
  if (!rg) {
    logger.warn('ripgrep not found on PATH — search disabled');
    return { matches: [], truncated: false, engine: 'node', elapsedMs: 0 };
  }

  const args = [
    '--json',
    '--hidden',
    '--follow',
    '--max-count',
    String(Math.max(10, Math.floor(maxResults / 3))),
    '-g',
    '!node_modules/**',
    '-g',
    '!.git/**',
    '-g',
    '!dist/**',
    '-g',
    '!dist-electron/**',
    '-g',
    '!out/**',
    '-g',
    '!target/**',
    '-g',
    '!build/**',
  ];
  if (!opts.regex) args.push('--fixed-strings');
  if (!opts.caseSensitive) args.push('--smart-case');
  if (opts.wholeWord) args.push('--word-regexp');
  for (const g of opts.includeGlobs ?? []) args.push('-g', g);
  for (const g of opts.excludeGlobs ?? []) args.push('-g', `!${g}`);
  args.push('--', trimmed, cwd);

  return new Promise<SearchResult>((resolve) => {
    const matches: SearchMatch[] = [];
    let truncated = false;
    const child = spawn(rg, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LANG: 'en_US.UTF-8' },
    });

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      stdoutBuf += chunk.toString('utf8');
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        const m = parseRgLine(line, cwd);
        if (m) {
          matches.push(m);
          if (matches.length >= maxResults) {
            truncated = true;
            try {
              child.kill('SIGTERM');
            } catch {
              /* ignore */
            }
            break;
          }
        }
      }
    });

    child.stderr.on('data', (buf: Buffer) => {
      const s = buf.toString('utf8').trim();
      if (s) logger.warn(`rg stderr: ${s.slice(0, 200)}`);
    });

    child.once('close', () => {
      resolve({
        matches,
        truncated,
        engine: 'ripgrep',
        elapsedMs: Date.now() - start,
      });
    });

    child.once('error', (err) => {
      logger.warn(`rg spawn failed: ${err.message}`);
      resolve({
        matches,
        truncated,
        engine: 'ripgrep',
        elapsedMs: Date.now() - start,
      });
    });
  });
}
