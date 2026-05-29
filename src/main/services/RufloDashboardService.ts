import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { enrichedPath } from '@main/utils/setupPaths';
import { createLogger } from '@shared/logger';
import type {
  RufloAgent,
  RufloDashAgentsResult,
  RufloDashMemoryResult,
  RufloDashSwarmsResult,
  RufloMemoryResult,
  RufloSwarmSession,
} from '@shared/ruflo';

/**
 * Read-only inspector for the Phase 3 overlay drawer (Terminal-mode side
 * panel). All commands shell out to `ruflo …` with a hard 5 s timeout so a
 * wedged binary can't hang the renderer — overlay calls are on-demand from
 * a visible drawer, so a timeout is preferable to an indefinite spinner.
 *
 * Output parsing is intentionally tolerant: `ruflo agent list` and friends
 * print human-readable text (no `--json` flag), so we line-split + skip
 * banner/header/empty rows. Anything the parser can't recognise becomes an
 * empty result with `ok: true` (fail open) — the UI surfaces "no agents"
 * rather than a scary error for a format we haven't seen yet.
 */

const logger = createLogger('RufloDash');

const TIMEOUT_MS = 5_000;
// Cache `which ruflo` so the overlay's repeated mounts don't re-walk PATH
// on every tab switch. 30 s strikes a balance: long enough to amortise the
// cost across a session, short enough that a fresh `brew install ruflo`
// flips the overlay state without an app restart.
const INSTALL_CACHE_TTL_MS = 30_000;

let installCache: { value: boolean; ts: number } | null = null;

// ---------------------------------------------------------------------------
// Binary resolution — same shape as RufloService.whichBin / RufloPlugins
// service so the three stay aligned. Self-contained on purpose (no shared
// helper) per Phase 3 spec.
// ---------------------------------------------------------------------------

async function whichRuflo(): Promise<string | null> {
  const segments = enrichedPath().split(':').filter(Boolean);
  for (const dir of segments) {
    const full = path.join(dir, 'ruflo');
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) {
        // eslint-disable-next-line no-bitwise
        await fsp.access(full, fs.constants.X_OK);
        return full;
      }
    } catch {
      // try next
    }
  }
  return null;
}

export async function isRufloInstalled(): Promise<boolean> {
  const now = Date.now();
  if (installCache && now - installCache.ts < INSTALL_CACHE_TTL_MS) {
    return installCache.value;
  }
  const bin = await whichRuflo();
  const value = bin !== null;
  installCache = { value, ts: now };
  return value;
}

// ---------------------------------------------------------------------------
// Spawn helper with timeout. Returns `{ code, stdout, stderr, timedOut }`.
// On timeout we SIGTERM the child and surface a sentinel that the caller
// maps to `{ ok: false, error: 'Command timed out (5s)' }`.
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runCapture(
  bin: string,
  args: string[],
  cwd?: string,
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, PATH: enrichedPath() },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      finish(-1);
    }, TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      stderr = stderr || err.message;
      finish(-1);
    });
    child.on('exit', (code) => {
      finish(code ?? -1);
    });
  });
}

// ---------------------------------------------------------------------------
// Parsers — exported so tests can pin them without spawning a real binary.
// All accept human-readable stdout (no JSON flag exists for these commands
// per ruflo USERGUIDE 3.7) and degrade gracefully.
// ---------------------------------------------------------------------------

// Strip ANSI escapes so colorized output from a tty-faking ruflo doesn't
// poison the parser. Cheap regex — matches the common CSI sequences ruflo
// emits when it detects a terminal.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function clean(line: string): string {
  return line.replace(ANSI_RE, '').trim();
}

// Heuristic header/banner detection: rows that are obviously dividers,
// titles, or column headers — none of which are real records. Keeping this
// loose lets us absorb ruflo updates that tweak banner copy.
function isHeaderLine(line: string): boolean {
  if (!line) return true;
  if (/^[-=_*]+$/.test(line)) return true;
  if (/^(name|type|id|status|objective)\s*[:|]/i.test(line)) return true;
  if (/^(available|active|swarm|session|agents?)\s*:?\s*$/i.test(line)) {
    return true;
  }
  // Lines that look like ASCII-art borders or column headers.
  if (/^[│┃┊┋┆┇┄┅━┓┛┗┏┻┳┫┣┼┬┴]+/.test(line)) return true;
  // Column header heuristic: two columns of LOWER-case all-ascii words
  // separated by whitespace ("name role", "id objective status"). Real
  // ruflo records always carry punctuation or a hyphen-name in the first
  // column, so this is a safe narrow filter for plain table headers.
  if (
    /^(name|type|id|status|objective|role|kind|session)(\s+(name|type|id|status|objective|role|kind|session))+$/i.test(
      line,
    )
  ) {
    return true;
  }
  return false;
}

export function parseAgentList(stdout: string): RufloAgent[] {
  if (!stdout) return [];
  const out: RufloAgent[] = [];
  for (const raw of stdout.split('\n')) {
    const line = clean(raw);
    if (!line || isHeaderLine(line)) continue;
    // Accept "name — role", "name: role", "name  role" (two+ spaces), or
    // bare "name". Bullet markers (-, *, •) get stripped first.
    const bare = line.replace(/^[\s\-*•·▸▹►]+/, '').trim();
    if (!bare) continue;
    const match =
      /^([\w@.\-/+]+)\s*(?:[—–\-:|]\s*|\s{2,})(.+)$/u.exec(bare) ?? null;
    if (match) {
      out.push({ name: match[1]!, role: match[2]!.trim() });
    } else if (/^[\w@.\-/+]+$/.test(bare)) {
      out.push({ name: bare });
    }
  }
  return out;
}

export function parseSwarmSessions(stdout: string): RufloSwarmSession[] {
  if (!stdout) return [];
  const out: RufloSwarmSession[] = [];
  for (const raw of stdout.split('\n')) {
    const line = clean(raw);
    if (!line || isHeaderLine(line)) continue;
    const bare = line.replace(/^[\s\-*•·▸▹►]+/, '').trim();
    if (!bare) continue;
    // Expected shape per USERGUIDE: "<id>  <objective>  [<status>]" but
    // versions vary. Strategy: peel id (first token), optional bracketed
    // status, remainder = objective.
    const idMatch = /^([\w.\-:/]+)\s*(.*)$/.exec(bare);
    if (!idMatch) continue;
    const id = idMatch[1]!;
    let rest = idMatch[2]!.trim();
    let status: string | undefined;
    const statusMatch = /\[([^\]]+)\]\s*$/.exec(rest);
    if (statusMatch) {
      status = statusMatch[1]!.trim();
      rest = rest.slice(0, statusMatch.index).trim();
    }
    out.push({
      id,
      objective: rest || undefined,
      status,
    });
  }
  return out;
}

export function parseMemoryResults(stdout: string): RufloMemoryResult[] {
  if (!stdout) return [];
  const out: RufloMemoryResult[] = [];
  for (const raw of stdout.split('\n')) {
    const line = clean(raw);
    if (!line || isHeaderLine(line)) continue;
    const bare = line.replace(/^[\s\-*•·▸▹►]+/, '').trim();
    if (!bare) continue;
    // Format per USERGUIDE 3.7: "[ns] score=0.87 text…". Both prefixes are
    // optional; the text is whatever remains. We strip them greedily so a
    // pretty-printer change on ruflo's side still yields usable results.
    let text = bare;
    let namespace: string | undefined;
    let score: number | undefined;
    const nsMatch = /^\[([^\]]+)\]\s*/.exec(text);
    if (nsMatch) {
      namespace = nsMatch[1]!.trim();
      text = text.slice(nsMatch[0].length);
    }
    const scoreMatch = /^score\s*[=:]\s*([0-9.]+)\s*/i.exec(text);
    if (scoreMatch) {
      const n = Number(scoreMatch[1]);
      if (Number.isFinite(n)) score = n;
      text = text.slice(scoreMatch[0].length);
    }
    text = text.trim();
    if (!text) continue;
    out.push({ text, score, namespace });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API. Each entry resolves a binary, spawns the command, and maps the
// result onto a tagged shape. We avoid throwing on a non-zero exit code so
// the overlay can surface inline row-level errors without an error boundary.
// ---------------------------------------------------------------------------

export async function listAgents(): Promise<RufloDashAgentsResult> {
  const bin = await whichRuflo();
  if (!bin) {
    return { ok: false, agents: [], error: 'ruflo not installed' };
  }
  const res = await runCapture(bin, ['agent', 'list']);
  if (res.timedOut) {
    return { ok: false, agents: [], error: 'Command timed out (5s)' };
  }
  if (res.code !== 0) {
    const err = (res.stderr || res.stdout).trim() || `ruflo exited ${res.code}`;
    return { ok: false, agents: [], error: err };
  }
  const agents = parseAgentList(res.stdout);
  if (agents.length === 0 && res.stdout.trim()) {
    // Fail open — the binary spoke but we couldn't recognise its dialect.
    // Warn so we can spot dialect drift in logs.
    logger.warn(
      `agent list parser yielded 0 records from ${res.stdout.length} bytes`,
    );
  }
  return { ok: true, agents };
}

export async function listSwarms(
  projectPath: string,
): Promise<RufloDashSwarmsResult> {
  if (!projectPath) {
    return { ok: false, sessions: [], error: 'projectPath required' };
  }
  const bin = await whichRuflo();
  if (!bin) {
    return { ok: false, sessions: [], error: 'ruflo not installed' };
  }
  const res = await runCapture(bin, ['hive-mind', 'sessions'], projectPath);
  if (res.timedOut) {
    return { ok: false, sessions: [], error: 'Command timed out (5s)' };
  }
  if (res.code !== 0) {
    const err = (res.stderr || res.stdout).trim() || `ruflo exited ${res.code}`;
    return { ok: false, sessions: [], error: err };
  }
  const sessions = parseSwarmSessions(res.stdout);
  if (sessions.length === 0 && res.stdout.trim()) {
    logger.warn(
      `hive-mind sessions parser yielded 0 records from ${res.stdout.length} bytes`,
    );
  }
  return { ok: true, sessions };
}

export async function searchMemory(
  projectPath: string,
  query: string,
  limit = 10,
): Promise<RufloDashMemoryResult> {
  if (!projectPath) {
    return { ok: false, results: [], error: 'projectPath required' };
  }
  if (!query) {
    return { ok: false, results: [], error: 'query required' };
  }
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const bin = await whichRuflo();
  if (!bin) {
    return { ok: false, results: [], error: 'ruflo not installed' };
  }
  const res = await runCapture(
    bin,
    ['memory', 'search', '-q', query, '--limit', String(safeLimit)],
    projectPath,
  );
  if (res.timedOut) {
    return { ok: false, results: [], error: 'Command timed out (5s)' };
  }
  if (res.code !== 0) {
    const err = (res.stderr || res.stdout).trim() || `ruflo exited ${res.code}`;
    return { ok: false, results: [], error: err };
  }
  const results = parseMemoryResults(res.stdout);
  return { ok: true, results };
}

/** Test-only: clear the install cache between vitest cases. */
export function __resetForTests(): void {
  installCache = null;
}
