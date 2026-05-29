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

// ruflo v3 sprinkles status/log chatter between data ("[INFO] Total: 1
// agents", "✅ Using sql.js", "[WARN] No results found", "Search time: 3ms").
// None are records — skip them in every parser so an empty result stays
// empty instead of yielding garbage rows from the banner text.
function isNoiseLine(line: string): boolean {
  return (
    /^\[(?:INFO|WARN|OK|ERROR|DEBUG)\]/i.test(line) ||
    /^[✅✔❌⚠ℹ]/u.test(line) ||
    /^(?:Search time|Try:|Using sql\.js|Total:|Showing\s+\d+\s+of)/i.test(line)
  );
}

// Heuristic header/banner detection: rows that are obviously dividers,
// titles, or column headers — none of which are real records. Keeping this
// loose lets us absorb ruflo updates that tweak banner copy.
function isHeaderLine(line: string): boolean {
  if (!line) return true;
  if (/^[-=_*]+$/.test(line)) return true;
  if (/^(name|type|id|status|objective)\s*[:|]/i.test(line)) return true;
  if (/^(available|active|swarm|sessions?|agents?)\s*:?\s*$/i.test(line)) {
    return true;
  }
  // v3.10.5 standalone section banners printed above each table / empty
  // message ("Sessions", "Active Agents", "Memory Entries", …).
  if (
    /^(active agents|sessions|memory entries|memory statistics|hive mind status|active swarm|available agent types?)$/i.test(
      line,
    )
  ) {
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

// v3.10.5 renders list output as a bordered ASCII pipe-table:
//   +----+-------+
//   | ID | Type  |
//   +----+-------+
//   |    | coder |
//   +----+-------+
// Border (`+---+`) lines start with '+' so they drop out; the `| a | b |`
// rows become objects keyed by the lower-cased header cells. ruflo
// truncates long cells with a trailing "…"/"..." — kept verbatim.
function parsePipeTable(stdout: string): Array<Record<string, string>> {
  const rows = stdout
    .split('\n')
    .map(clean)
    .filter((l) => l.startsWith('|') && l.endsWith('|'));
  if (rows.length < 2) return [];
  const cells = (l: string): string[] =>
    l
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
  const header = cells(rows[0]!).map((h) => h.toLowerCase());
  const headerKey = header.join('|');
  const records: Array<Record<string, string>> = [];
  for (const line of rows.slice(1)) {
    const vals = cells(line);
    if (vals.every((v) => v === '')) continue;
    // Some tables echo the header row mid-output — not a record.
    if (vals.map((v) => v.toLowerCase()).join('|') === headerKey) continue;
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) rec[h] = vals[i] ?? '';
    });
    records.push(rec);
  }
  return records;
}

export function parseAgentList(stdout: string): RufloAgent[] {
  if (!stdout) return [];
  // v3.10.5 `agent list`: pipe-table (ID, Type, Status, Created, …). The ID
  // column is frequently blank, so fall back to Type for the display name.
  const table = parsePipeTable(stdout);
  if (table.length) {
    const out: RufloAgent[] = [];
    for (const r of table) {
      const id = (r.id ?? '').trim();
      const type = (r.type ?? r.name ?? '').trim();
      const status = (r.status ?? '').trim();
      const name = id || type;
      if (!name) continue;
      const role = id ? type || undefined : status || undefined;
      out.push(role ? { name, role } : { name });
    }
    return out;
  }
  // Legacy (<=3.7) line format: "name — role" / "name: role" / "name  role".
  const out: RufloAgent[] = [];
  for (const raw of stdout.split('\n')) {
    const line = clean(raw);
    if (!line || isHeaderLine(line) || isNoiseLine(line)) continue;
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
  // v3.10.5 `session list`: pipe-table (ID, Name, Status, Agents, Tasks,
  // Last Updated). id ← ID, objective ← Name, status ← Status.
  const table = parsePipeTable(stdout);
  if (table.length) {
    const out: RufloSwarmSession[] = [];
    for (const r of table) {
      const id = (r.id ?? '').trim();
      if (!id) continue;
      const objective = (r.name ?? r.objective ?? '').trim() || undefined;
      const status = (r.status ?? '').trim() || undefined;
      out.push({ id, objective, status });
    }
    return out;
  }
  // Legacy (<=3.7) line format: "<id>  <objective>  [<status>]". Peel id
  // (first token), optional bracketed status, remainder = objective.
  const out: RufloSwarmSession[] = [];
  for (const raw of stdout.split('\n')) {
    const line = clean(raw);
    if (!line || isHeaderLine(line) || isNoiseLine(line)) continue;
    const bare = line.replace(/^[\s\-*•·▸▹►]+/, '').trim();
    if (!bare) continue;
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
    out.push({ id, objective: rest || undefined, status });
  }
  return out;
}

export function parseMemoryResults(stdout: string): RufloMemoryResult[] {
  if (!stdout) return [];
  // v3.10.5 may render hits as a pipe-table — map a value/content/text cell.
  const table = parsePipeTable(stdout);
  if (table.length) {
    const out: RufloMemoryResult[] = [];
    for (const r of table) {
      const text = (r.value ?? r.content ?? r.text ?? r.data ?? '').trim();
      if (!text) continue;
      const namespace =
        (r.namespace ?? r.ns ?? r.key ?? '').trim() || undefined;
      const scoreRaw = (r.score ?? r.similarity ?? '').trim();
      const scoreNum = scoreRaw ? Number(scoreRaw) : NaN;
      out.push({
        text,
        namespace,
        score: Number.isFinite(scoreNum) ? scoreNum : undefined,
      });
    }
    if (out.length) return out;
  }
  // Legacy (<=3.7) line format: "[ns] score=0.87 text…". Both prefixes are
  // optional; the text is whatever remains. ruflo v3 status chatter
  // ([INFO]/✅/[WARN]/Search time/Try:) is skipped via isNoiseLine so an
  // empty search yields [] instead of treating the banner lines as results.
  const out: RufloMemoryResult[] = [];
  for (const raw of stdout.split('\n')) {
    const line = clean(raw);
    if (!line || isHeaderLine(line) || isNoiseLine(line)) continue;
    const bare = line.replace(/^[\s\-*•·▸▹►]+/, '').trim();
    if (!bare) continue;
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
  // v3.10.5 dropped `hive-mind sessions`; `session list` is the current
  // command for enumerating saved swarm / coordination sessions.
  const res = await runCapture(bin, ['session', 'list'], projectPath);
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
      `session list parser yielded 0 records from ${res.stdout.length} bytes`,
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
