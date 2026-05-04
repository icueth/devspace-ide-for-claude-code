import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { createLogger } from '@shared/logger';
import type {
  CodeflowAnalyzeOptions,
  CodeflowCacheMeta,
  CodeflowDoc,
  CodeflowStage,
  CodeflowStatus,
} from '@shared/types';

const logger = createLogger('Codeflow');

// Walk skip list — same skeleton as fs.ts so the two stay in sync conceptually.
// We're more aggressive here because the walk feeds Claude's context and every
// extra file is wasted tokens.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'out',
  'build',
  'target',
  '.next',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  '.devspace',
  // .claude/ is where we WRITE codeflow output. Walking it back into the
  // input would feed Claude its own previous summary on every re-run.
  '.claude',
  'release',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

// File extensions that contribute to the project's "code shape." Used to
// produce the fingerprint and decide whether a watcher event is meaningful.
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs',
  'php', 'lua', 'r', 'jl', 'dart',
  'vue', 'svelte', 'astro',
  'html', 'css', 'scss', 'sass', 'less',
  'sh', 'bash', 'zsh',
  'md', 'mdx',
  'json', 'yaml', 'yml', 'toml',
  'sql', 'graphql', 'gql', 'proto',
]);

// Per-project state. Lifted to a module-level map so a CodeflowTab remount
// (e.g. user closes + reopens the tab) doesn't restart the analysis.
interface ProjectState {
  projectPath: string;
  status: CodeflowStatus;
  child: ChildProcess | null;
  // Webcontents subscribed to status events for this project.
  subscribers: Set<Electron.WebContents>;
  // Set when FileWatcher fires while a job is running, so the user can choose
  // to re-analyze immediately after the current job finishes.
  changedDuringRun: boolean;
}

const states = new Map<string, ProjectState>();

// Where docs (and DevSpace's own state files) live. We picked `.claude/`
// so subsequent `claude` sessions auto-discover the architecture overview
// via the CLAUDE.md pointer we drop alongside.
//
// The headless harness normally hardcodes `.claude/` as a sensitive
// directory and rejects every Write/Edit/Bash heredoc to it. We unblock
// that by passing `--dangerously-skip-permissions` to claude — this is the
// only mode that bypasses the path block, so the user's settings.json
// permission rules don't help here. Tool surface is still tightly scoped
// (`--allowed-tools Read Glob Grep Write Edit`) to keep the blast radius
// small even with permission checks off.
function codeflowDir(projectPath: string): string {
  return path.join(projectPath, '.claude', 'codeflow');
}

function cacheFile(projectPath: string): string {
  return path.join(codeflowDir(projectPath), 'cache.json');
}

function claudeMdFile(projectPath: string): string {
  return path.join(projectPath, '.claude', 'CLAUDE.md');
}

function skillFile(projectPath: string): string {
  return path.join(
    projectPath,
    '.claude',
    'skills',
    'codeflow-context',
    'SKILL.md',
  );
}

function emptyStatus(): CodeflowStatus {
  return {
    stage: 'idle',
    progress: 0,
    message: '',
    error: null,
    cache: null,
    stale: false,
    docs: [],
  };
}

function getOrCreateState(projectPath: string): ProjectState {
  const key = path.resolve(projectPath);
  let state = states.get(key);
  if (!state) {
    state = {
      projectPath: key,
      status: emptyStatus(),
      child: null,
      subscribers: new Set(),
      changedDuringRun: false,
    };
    states.set(key, state);
    // Hydrate from disk on first access so a fresh tab immediately sees prior
    // results without paying for a re-walk.
    void hydrateFromDisk(state).catch((err) => {
      logger.warn(`hydrate failed for ${key}: ${(err as Error).message}`);
    });
  }
  return state;
}

async function hydrateFromDisk(state: ProjectState): Promise<void> {
  const cache = await readCache(state.projectPath);
  if (cache) state.status.cache = cache;
  state.status.docs = await listDocs(state.projectPath);
}

async function readCache(projectPath: string): Promise<CodeflowCacheMeta | null> {
  try {
    const raw = await fs.promises.readFile(cacheFile(projectPath), 'utf8');
    const parsed = JSON.parse(raw) as CodeflowCacheMeta & { fileHashes?: unknown };
    if (
      typeof parsed?.lastAnalyzedAt === 'number' &&
      typeof parsed?.fingerprint === 'string'
    ) {
      // Strip fileHashes before returning — that map is internal-only.
      return {
        projectPath: parsed.projectPath ?? projectPath,
        lastAnalyzedAt: parsed.lastAnalyzedAt,
        fileCount: parsed.fileCount ?? 0,
        fingerprint: parsed.fingerprint,
      };
    }
  } catch {
    /* missing or corrupt — treat as no cache */
  }
  return null;
}

async function writeCache(
  projectPath: string,
  meta: CodeflowCacheMeta,
): Promise<void> {
  await fs.promises.mkdir(codeflowDir(projectPath), { recursive: true });
  await fs.promises.writeFile(cacheFile(projectPath), JSON.stringify(meta, null, 2));
  // Note: we deliberately do NOT auto-write a .gitignore here. .claude/ is
  // shared team config — most users want to commit the codeflow docs so the
  // team's Claude Code sessions all benefit from the same architecture
  // overview. Users who don't can add `.claude/codeflow/cache.json` to their
  // root .gitignore manually.
}

const CLAUDE_MD_BEGIN = '<!-- BEGIN devspace-codeflow (auto-managed) -->';
const CLAUDE_MD_END = '<!-- END devspace-codeflow -->';

/**
 * Write a guarded block to `.claude/CLAUDE.md` that points Claude Code at
 * the generated docs. Idempotent: if the markers already exist we replace
 * the block; otherwise we append. Anything outside the markers is left
 * untouched, so the user can keep their own CLAUDE.md content alongside.
 */
async function writeClaudePointer(
  projectPath: string,
  meta: CodeflowCacheMeta,
): Promise<void> {
  const block = [
    CLAUDE_MD_BEGIN,
    '## Architecture docs (codeflow)',
    '',
    'Generated by DevSpace → Codeflow tab. Read these BEFORE answering questions about how this codebase is structured or how a feature works — they reference real files with `path:line`.',
    '',
    '- `.claude/codeflow/codebase.md` — architecture overview, stack, layout, key entry points.',
    '- `.claude/codeflow/flow-*.md` — per-feature step-by-step traces (one file per major flow).',
    '- `.claude/codeflow/function-map.md` *(when present)* — high-traffic hubs, cross-subsystem bridges, per-file exported-function index from the function-level call graph.',
    '- `.claude/codeflow/function-graph.json` *(when present)* — raw nodes + edges of the function call graph; grep this when you need exact callers/callees of a specific function.',
    '',
    `Last generated: ${new Date(meta.lastAnalyzedAt).toISOString().slice(0, 10)} (${meta.fileCount} files). Re-run via DevSpace → Codeflow → Re-analyze.`,
    CLAUDE_MD_END,
    '',
  ].join('\n');

  await fs.promises.mkdir(path.dirname(claudeMdFile(projectPath)), {
    recursive: true,
  });

  let existing = '';
  try {
    existing = await fs.promises.readFile(claudeMdFile(projectPath), 'utf8');
  } catch {
    /* no existing file */
  }

  let next: string;
  if (existing.includes(CLAUDE_MD_BEGIN) && existing.includes(CLAUDE_MD_END)) {
    // Replace existing block in place.
    const re = new RegExp(
      `${escapeRegExp(CLAUDE_MD_BEGIN)}[\\s\\S]*?${escapeRegExp(CLAUDE_MD_END)}\\n?`,
    );
    next = existing.replace(re, block);
  } else {
    // Append, separated by a blank line if the file already had content.
    next = existing.length === 0 ? block : `${existing.trimEnd()}\n\n${block}`;
  }

  if (next !== existing) {
    await fs.promises.writeFile(claudeMdFile(projectPath), next);
  }
}

/**
 * Write the codeflow-context skill. When Claude is asked an architecture or
 * flow question, this skill makes it pull in the relevant docs FIRST instead
 * of guessing. Skills are project-scoped under `.claude/skills/<slug>/`.
 */
async function writeSkill(projectPath: string): Promise<void> {
  const dir = path.dirname(skillFile(projectPath));
  await fs.promises.mkdir(dir, { recursive: true });
  // SKILL.md MUST start with YAML frontmatter — Claude Code's skill loader
  // looks for `---\nname:\n…` literally at offset 0. An earlier version
  // wrapped the body in `<!-- BEGIN devspace-codeflow-skill -->` markers
  // and the skill never registered because the parser couldn't see the
  // frontmatter behind the comment. Skills are entirely DevSpace-owned, so
  // we don't need a guarded block — overwrite cleanly each run.
  const body = [
    '---',
    'name: codeflow-context',
    'description: Use when the user asks how this codebase is structured, how a feature works, where something lives, or "trace the flow for X". Reads the architecture overview and per-flow docs before answering so the response references real files at real lines.',
    '---',
    '',
    '# When to use',
    '',
    'Trigger this skill BEFORE answering any of these:',
    '- "How does X work?"',
    '- "Where is Y handled?"',
    '- "Walk me through the Z flow."',
    '- "What\'s the architecture / structure / layout?"',
    '- Any onboarding-style question about this project.',
    '',
    '# How to use',
    '',
    '1. Read `.claude/codeflow/codebase.md` for the architecture overview, stack, and key entry points.',
    '2. If the question is about a specific feature, look for a matching `.claude/codeflow/flow-<slug>.md`. Use `Glob` to list `.claude/codeflow/flow-*.md` if unsure which slug.',
    '3. For function-level questions ("what calls X", "who depends on Y"), check `.claude/codeflow/function-map.md` for hubs / bridges, or grep `.claude/codeflow/function-graph.json` (if present) for exact callers/callees.',
    '4. Quote the doc\'s `path:line` references when explaining — they were generated against the actual files in this repo.',
    '5. If the docs feel out of date, mention that the user should run **DevSpace → Codeflow → Re-analyze** to refresh.',
    '',
    '# Notes',
    '',
    '- The docs are auto-generated by DevSpace running Claude Code itself against the project files; they are not hand-written and may go stale after big refactors.',
    '- File path references inside the docs are repo-relative.',
    '',
  ].join('\n');
  // Always overwrite — the skill itself doesn't carry user content, so we
  // don't need the BEGIN/END guard logic that CLAUDE.md uses.
  await fs.promises.writeFile(skillFile(projectPath), body);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listDocs(projectPath: string): Promise<CodeflowDoc[]> {
  const dir = codeflowDir(projectPath);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const docs: CodeflowDoc[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = await fs.promises.stat(full);
      docs.push({
        name: entry.name,
        path: full,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      /* skip unreadable */
    }
  }
  // Stable order: codebase.md first, then flow-* alphabetical.
  docs.sort((a, b) => {
    if (a.name === 'codebase.md') return -1;
    if (b.name === 'codebase.md') return 1;
    return a.name.localeCompare(b.name);
  });
  return docs;
}

interface FileEntry {
  rel: string;
  size: number;
  mtimeMs: number;
}

// What we hand to the codeflow visualization iframe. Includes file content
// because codeflow's parser runs its own AST/regex extraction client-side.
export interface CodeflowFileWithContent {
  path: string;
  content: string;
}

// Hard cap on visualization payload. 2000 files matches codeflow's own
// HARD_LIMIT, so we don't ship more than codeflow will ever look at. 5MB per
// file matches the FS_READ_FILE limit elsewhere.
const VIZ_MAX_FILES = 2000;
const VIZ_MAX_FILE_BYTES = 1 * 1024 * 1024;

async function gitListFiles(projectRoot: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    const paths = stdout.split('\0').filter(Boolean);
    if (paths.length === 0) return null;
    return paths;
  } catch {
    return null;
  }
}

async function walkProject(projectPath: string): Promise<FileEntry[]> {
  // Preferred path: trust git's view of the project (tracked + untracked
  // but not gitignored). This is the cleanest way to keep node_modules,
  // vendor/, generated protobufs, terraform plan caches, and any
  // project-specific noise out of Claude's prompt without us
  // hand-curating per ecosystem.
  const tracked = await gitListFiles(projectPath);
  if (tracked) {
    const out: FileEntry[] = [];
    for (const rel of tracked) {
      if (out.length >= 5000) break;
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      if (!CODE_EXTS.has(ext)) continue;
      try {
        const stat = await fs.promises.stat(path.join(projectPath, rel));
        if (!stat.isFile()) continue;
        out.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* skip unreadable / deleted-since-listing */
      }
    }
    return out;
  }

  // Fallback path: not a git repo (or git failed). Hand-curated SKIP_DIRS
  // walk — less precise but won't crash on non-git projects.
  const out: FileEntry[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= 5000) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 5000) return;
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(
          path.join(dir, entry.name),
          rel ? `${rel}/${entry.name}` : entry.name,
        );
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (!CODE_EXTS.has(ext)) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        try {
          const stat = await fs.promises.stat(path.join(dir, entry.name));
          out.push({ rel: relPath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  await walk(projectPath, '');
  return out;
}

function fingerprint(files: FileEntry[]): string {
  // Sort for stable hash regardless of fs traversal order.
  const sorted = [...files].sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash('sha256');
  for (const f of sorted) {
    h.update(`${f.rel}\0${f.size}\0${Math.floor(f.mtimeMs)}\n`);
  }
  return h.digest('hex');
}

function broadcast(state: ProjectState): void {
  for (const wc of state.subscribers) {
    if (!wc.isDestroyed()) {
      wc.send('codeflow:progress', {
        projectPath: state.projectPath,
        status: state.status,
      });
    }
  }
}

function setStage(
  state: ProjectState,
  stage: CodeflowStage,
  message: string,
  progress: number,
): void {
  state.status.stage = stage;
  state.status.message = message;
  state.status.progress = progress;
  state.status.error = stage === 'error' ? state.status.error : null;
  broadcast(state);
}

export function subscribeStatus(
  projectPath: string,
  wc: Electron.WebContents,
): CodeflowStatus {
  const state = getOrCreateState(projectPath);
  state.subscribers.add(wc);
  wc.once('destroyed', () => state.subscribers.delete(wc));
  return state.status;
}

export function unsubscribeStatus(
  projectPath: string,
  wc: Electron.WebContents,
): void {
  const state = states.get(path.resolve(projectPath));
  if (state) state.subscribers.delete(wc);
}

/**
 * Mark a project as stale because FileWatcher reported changes. Wired up by
 * the IPC layer so we don't have to import FileWatcher directly here (avoiding
 * a cyclic import). Idempotent.
 */
export function markStale(projectPath: string): void {
  const key = path.resolve(projectPath);
  const state = states.get(key);
  if (!state) return;
  if (state.status.stage === 'walking' ||
      state.status.stage === 'overview' ||
      state.status.stage === 'flows') {
    state.changedDuringRun = true;
    return;
  }
  if (!state.status.stale) {
    state.status.stale = true;
    broadcast(state);
  }
}

export async function getStatus(projectPath: string): Promise<CodeflowStatus> {
  const state = getOrCreateState(projectPath);
  // Refresh docs list lazily — cheap fs.readdir, but worth doing here so a
  // late-arriving docs file (Claude wrote it after the user cancelled) shows
  // up next time the panel asks for status.
  state.status.docs = await listDocs(projectPath);
  state.status.cache = await readCache(projectPath);
  return state.status;
}

export async function cancelAnalyze(projectPath: string): Promise<void> {
  const state = states.get(path.resolve(projectPath));
  if (!state || !state.child) return;
  try {
    state.child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  // Don't await exit here — the spawn handler updates state.stage to
  // 'cancelled' when the process actually dies.
}

export async function analyzeProject(
  projectPath: string,
  opts: CodeflowAnalyzeOptions = {},
): Promise<void> {
  const state = getOrCreateState(projectPath);
  if (state.child) {
    logger.warn(`analyze already running for ${projectPath}`);
    return;
  }

  state.changedDuringRun = false;
  state.status.error = null;
  state.status.stale = false;

  setStage(state, 'walking', 'Scanning project files…', 0.05);
  const files = await walkProject(projectPath);
  const fp = fingerprint(files);

  // Short-circuit when nothing changed since last analysis (unless --force).
  const cache = await readCache(projectPath);
  if (!opts.force && cache && cache.fingerprint === fp) {
    state.status.cache = cache;
    state.status.docs = await listDocs(projectPath);
    setStage(
      state,
      'done',
      `No changes detected (${files.length} files). Re-analyze to force.`,
      1,
    );
    return;
  }

  await fs.promises.mkdir(codeflowDir(projectPath), { recursive: true });

  // Stage 1 — codebase overview.
  try {
    setStage(state, 'overview', 'Generating codebase.md (architecture overview)…', 0.2);
    await runClaude(state, buildOverviewPrompt(projectPath, files), 'codebase');
  } catch (err) {
    return failJob(state, `overview: ${(err as Error).message}`);
  }
  // runClaude mutates state.status.stage to 'cancelled' from the spawn exit
  // handler when the process is killed; TS narrowing from setStage above
  // doesn't see that, so cast and check.
  if ((state.status.stage as CodeflowStage) === 'cancelled') return;

  // Stage 2 — per-feature flow docs. Cheaper second call: claude already has
  // the codebase.md it wrote, so it can build on that without re-exploring.
  try {
    setStage(state, 'flows', 'Generating flow-*.md (feature flows)…', 0.6);
    await runClaude(state, buildFlowsPrompt(projectPath, files), 'flows');
  } catch (err) {
    return failJob(state, `flows: ${(err as Error).message}`);
  }
  if ((state.status.stage as CodeflowStage) === 'cancelled') return;

  const meta: CodeflowCacheMeta = {
    projectPath,
    lastAnalyzedAt: Date.now(),
    fileCount: files.length,
    fingerprint: fp,
  };
  await writeCache(projectPath, meta);
  // Wire the docs into Claude Code's auto-loaded context: a guarded block in
  // .claude/CLAUDE.md that points at the docs, and a project-scoped skill
  // that tells Claude to read them when asked architecture questions.
  // Both are best-effort — if a write fails (read-only fs, etc.) the
  // analysis still counts as successful.
  await writeClaudePointer(projectPath, meta).catch((err) => {
    logger.warn(`failed to update .claude/CLAUDE.md: ${(err as Error).message}`);
  });
  await writeSkill(projectPath).catch((err) => {
    logger.warn(`failed to write codeflow-context skill: ${(err as Error).message}`);
  });
  state.status.cache = meta;
  state.status.docs = await listDocs(projectPath);
  state.status.stale = state.changedDuringRun;
  setStage(
    state,
    'done',
    `Analyzed ${files.length} files · ${state.status.docs.length} docs generated.`,
    1,
  );
}

function failJob(state: ProjectState, message: string): void {
  state.status.error = message;
  state.status.stage = 'error';
  state.status.message = message;
  state.status.progress = 0;
  state.child = null;
  broadcast(state);
}

// Per-stage progress bands. Each runClaude call moves the bar from `min` to
// `max` based on how many tool calls Claude has made — gives the user a
// visible heartbeat instead of 30 silent seconds at the same percentage.
const STAGE_BANDS: Record<'codebase' | 'flows', { min: number; max: number }> = {
  codebase: { min: 0.2, max: 0.58 },
  flows: { min: 0.6, max: 0.95 },
};

async function runClaude(
  state: ProjectState,
  prompt: string,
  label: 'codebase' | 'flows',
): Promise<void> {
  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    throw new Error(
      "claude binary not found on PATH — install Claude Code CLI to use codeflow.",
    );
  }

  const env = await resolveInteractiveShellEnv();

  return new Promise<void>((resolve, reject) => {
    // We pipe the prompt through stdin instead of passing as a positional
    // argument. Some claude versions choke on `-p <flags...> <prompt>`
    // because the parser binds an inline `-p <next-arg>` and then fails on
    // the unrecognized remainder. stdin is unambiguous regardless of version.
    //
    // stream-json + --verbose makes claude emit one JSON event per line so we
    // can show "Reading src/main/index.ts" instead of a silent spinner — that
    // 30+ second wait felt like the process was hung otherwise.
    const args = [
      '--print',
      // bypass-permissions is the only mode that gets past the harness's
      // hardcoded `.claude/` sensitive-directory block. settings.local.json
      // allow-rules don't help — Anthropic's safety net runs before the
      // user's permission config. Coupled with --allowed-tools below this
      // is a contained "trust me, just write the docs I asked for" mode.
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--verbose',
      // Tightly scope tool surface so even with permissions off Claude
      // can't shell out, fetch the web, or run anything we didn't ask
      // for. Flag name is the kebab-case form — newer claude versions
      // ignore the camelCase `--allowedTools`.
      '--allowed-tools',
      'Read Glob Grep Write Edit',
    ];

    logger.info(`spawning claude (${label}) cwd=${state.projectPath}`);
    const child = spawn(claudeBin, args, {
      cwd: state.projectPath,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    state.child = child;
    child.stdin?.write(prompt);
    child.stdin?.end();

    const band = STAGE_BANDS[label];
    let toolCount = 0;
    // Soft denominator — assume ~25 tool calls per stage; if claude does more,
    // progress just creeps closer to (but never reaches) the band ceiling.
    const updateProgress = () => {
      const span = band.max - band.min;
      const frac = 1 - Math.exp(-toolCount / 25);
      state.status.progress = Math.min(band.min + span * frac, band.max);
    };

    let lineBuf = '';
    let stderrBuf = '';
    // Captured for the post-run debug log so users can see what Claude
    // did (or didn't do) when no files appear. Bounded so we don't keep
    // the entire stream-json output in memory for large runs.
    const eventLog: string[] = [];
    const MAX_LOGGED_EVENTS = 200;
    let resultText = '';

    const handleEvent = (raw: string) => {
      let evt: unknown;
      try {
        evt = JSON.parse(raw);
      } catch {
        return; // non-JSON line (claude shouldn't emit any in stream mode, but be defensive)
      }
      // Keep a bounded record of every event for the debug log. We capture
      // the type + brief shape, never the full prompt (which could be huge).
      if (eventLog.length < MAX_LOGGED_EVENTS) {
        const e = evt as { type?: string; subtype?: string };
        eventLog.push(
          `${e.type ?? '?'}${e.subtype ? `:${e.subtype}` : ''}  ${describeEvent(evt) ?? ''}`,
        );
      }
      // Capture the final result so the log can show Claude's last words on
      // a silent run.
      const r = (evt as { type?: string; result?: string });
      if (r.type === 'result' && typeof r.result === 'string') {
        resultText = r.result;
      }
      const message = describeEvent(evt);
      if (!message) return;

      // Tool-use events are the heartbeat. Text-only assistant messages just
      // refresh the line so the user sees Claude reasoning between tool calls.
      const e = evt as { type?: string; message?: { content?: { type: string }[] } };
      if (e?.type === 'assistant') {
        const hasToolUse = e.message?.content?.some((c) => c.type === 'tool_use');
        if (hasToolUse) {
          toolCount += 1;
          updateProgress();
        }
      }

      state.status.message = message;
      broadcast(state);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString('utf8');
      // Stream-json is newline-delimited. Process complete lines, keep the
      // partial tail for the next chunk.
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (line) handleEvent(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      state.child = null;
      reject(err);
    });
    child.on('exit', (code, signal) => {
      state.child = null;
      // Flush any trailing line (some claude versions don't end with \n).
      if (lineBuf.trim()) handleEvent(lineBuf.trim());

      // Always write a debug log alongside the docs so a user reporting
      // "generate ran but no files appeared" can open one file and see
      // exactly what Claude did. Bounded — never the full prompt or
      // megabytes of streamed text.
      const logPath = path.join(codeflowDir(state.projectPath), '.run.log');
      const logBody = [
        `# codeflow debug log`,
        `stage: ${label}`,
        `time: ${new Date().toISOString()}`,
        `exit: code=${code} signal=${signal}`,
        `tool_calls: ${toolCount}`,
        ``,
        `## stream-json events (last ${eventLog.length})`,
        eventLog.join('\n'),
        ``,
        `## stderr (last 2k)`,
        stderrBuf.slice(-2048),
        ``,
        `## final result text (last 2k)`,
        resultText.slice(-2048),
        ``,
      ].join('\n');
      fs.promises
        .mkdir(codeflowDir(state.projectPath), { recursive: true })
        .then(() => fs.promises.writeFile(logPath, logBody))
        .catch(() => undefined);

      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        state.status.stage = 'cancelled';
        state.status.message = 'Cancelled.';
        broadcast(state);
        resolve();
        return;
      }
      if (code !== 0) {
        const trimmed = stderrBuf.trim() || resultText.slice(-500) || lineBuf.trim().slice(-500);
        reject(new Error(`claude exited ${code}${trimmed ? `: ${trimmed}` : ''}`));
        return;
      }
      // Snap to band ceiling so the bar doesn't visually regress when the
      // next stage starts below the previous "in-progress" mark.
      state.status.progress = band.max;
      broadcast(state);
      logger.info(
        `claude (${label}) ok in ${state.projectPath} (${toolCount} tool calls). debug log: ${logPath}`,
      );
      resolve();
    });
  });
}

/**
 * Convert a single stream-json event to a one-line human-readable message.
 * Returns null when the event isn't user-facing (system init, cost summary,
 * empty deltas). The renderer shows the most recent message under the
 * progress bar so the user can see what Claude is doing right now.
 */
function describeEvent(evt: unknown): string | null {
  if (!evt || typeof evt !== 'object') return null;
  const e = evt as {
    type?: string;
    subtype?: string;
    message?: {
      content?: Array<
        | { type: 'text'; text?: string }
        | {
            type: 'tool_use';
            name?: string;
            input?: Record<string, unknown>;
          }
        | { type: 'tool_result'; content?: unknown }
      >;
    };
    result?: string;
  };

  if (e.type === 'assistant' && e.message?.content) {
    // Prefer the first tool_use call — that's the most "doing-something"
    // signal. Fall back to the first text fragment.
    for (const block of e.message.content) {
      if (block.type === 'tool_use') {
        return describeToolUse(block.name, block.input);
      }
    }
    for (const block of e.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const first = block.text.split('\n')[0]?.trim();
        if (first) return truncate(first, 160);
      }
    }
  }

  if (e.type === 'result' && typeof e.result === 'string') {
    const first = e.result.split('\n')[0]?.trim();
    if (first) return truncate(first, 160);
  }

  return null;
}

function describeToolUse(
  name: string | undefined,
  input: Record<string, unknown> | undefined,
): string {
  const i = input ?? {};
  const fp = (i.file_path as string) || (i.path as string) || '';
  const pattern = (i.pattern as string) || (i.query as string) || '';
  const cmd = (i.command as string) || '';

  // Show paths relative to project root when possible — full absolute paths
  // are noisy and clip the message.
  const shortPath = (p: string): string => {
    if (!p) return '';
    const idx = p.indexOf('.claude/codeflow/');
    if (idx >= 0) return p.slice(idx);
    const segs = p.split('/');
    if (segs.length > 4) return `…/${segs.slice(-3).join('/')}`;
    return p;
  };

  switch (name) {
    case 'Read':
      return `📖 Reading ${shortPath(fp) || '?'}`;
    case 'Write':
      return `✍️  Writing ${shortPath(fp) || '?'}`;
    case 'Edit':
      return `✏️  Editing ${shortPath(fp) || '?'}`;
    case 'Glob':
      return `🔎 Glob ${truncate((i.pattern as string) || '?', 80)}`;
    case 'Grep':
      return `🔍 Grep "${truncate(pattern, 60)}"${
        i.path ? ` in ${shortPath(i.path as string)}` : ''
      }`;
    case 'Bash':
      return `▶︎ Bash ${truncate(cmd, 100)}`;
    default:
      return name ? `🔧 ${name}` : '🔧 Tool call';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function buildOverviewPrompt(projectPath: string, files: FileEntry[]): string {
  const fileList = files
    .map((f) => f.rel)
    .slice(0, 800) // Hard cap so very large monorepos don't blow context
    .join('\n');
  const projectName = path.basename(projectPath);

  return [
    `You are documenting the codebase at "${projectName}" so a new contributor can ramp up fast.`,
    '',
    'Use Read/Glob/Grep to explore. Use Write to create exactly one file:',
    '`./.claude/codeflow/codebase.md`',
    '',
    'codebase.md must contain (~150-300 lines of markdown):',
    '- ## Overview — one paragraph: what this project does, who runs it, language/framework.',
    '- ## Stack — bullet list of major libraries/runtimes with versions where evident.',
    '- ## Layout — annotated tree of the top 2 directory levels with what each contains.',
    '- ## Architecture — how the layers connect (e.g. main → ipc → services → frontend). Include a small ASCII diagram.',
    '- ## Key entry points — bullet list of the most important files with `path/to/file.ext:line` and what they do.',
    '- ## Conventions — patterns that recur (e.g. "all IPC channels live in shared/ipc-channels.ts").',
    '',
    'Be specific to THIS codebase. Do not invent generic advice. Quote real symbols, real file paths.',
    '',
    `Files in scope (${files.length} total, top 800 shown):`,
    fileList,
  ].join('\n');
}

function buildFlowsPrompt(projectPath: string, files: FileEntry[]): string {
  const projectName = path.basename(projectPath);
  return [
    `Continue documenting "${projectName}". You already wrote ./.claude/codeflow/codebase.md — read it first for context.`,
    '',
    'Identify 3-7 major user-facing features or data flows. Examples for an IDE:',
    '"open project", "edit file", "run claude cli", "git commit". Pick whatever the actual codebase has.',
    '',
    'For each flow, Write one file at `./.claude/codeflow/flow-<slug>.md` (slug = kebab-case feature name).',
    '',
    'Each flow file (~80-200 lines) should contain:',
    '- ## What — one paragraph plain-English summary.',
    '- ## Trigger — what user action or event starts it.',
    '- ## Path — numbered step-by-step trace of the flow through the code, with `file.ext:line` references for each step. Include both happy path and the most likely error branch.',
    '- ## Touched files — bullet list of files involved.',
    '- ## Notes — gotchas, perf concerns, hidden coupling.',
    '',
    'Use Read/Glob/Grep liberally. Reference real symbols. Skip generic flows that aren\'t actually present.',
    `Total files in repo: ${files.length}.`,
  ].join('\n');
}

/**
 * Walk the project and return every code file's content for the codeflow
 * visualization iframe. Capped to 2000 files / 1MB each to keep the payload
 * shippable across the IPC bridge — large monorepos beyond that bound get
 * the truncated subset, which is still enough for a usable graph.
 */
export async function walkWithContent(
  projectPath: string,
): Promise<CodeflowFileWithContent[]> {
  const meta = await walkProject(projectPath);
  const limited = meta.slice(0, VIZ_MAX_FILES);
  const out: CodeflowFileWithContent[] = [];
  for (const entry of limited) {
    if (entry.size > VIZ_MAX_FILE_BYTES) {
      // Skip individual giants (minified bundles, vendored blobs) — including
      // their content would balloon the payload without helping the graph.
      out.push({ path: entry.rel, content: '' });
      continue;
    }
    try {
      const content = await fs.promises.readFile(
        path.join(projectPath, entry.rel),
        'utf8',
      );
      out.push({ path: entry.rel, content });
    } catch {
      out.push({ path: entry.rel, content: '' });
    }
  }
  return out;
}

export async function readDoc(absPath: string): Promise<string> {
  const stat = await fs.promises.stat(absPath);
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error(`Doc too large (${stat.size} bytes) — open it manually.`);
  }
  return fs.promises.readFile(absPath, 'utf8');
}

export async function listProjectDocs(projectPath: string): Promise<CodeflowDoc[]> {
  return listDocs(projectPath);
}

export function codeflowDirFor(projectPath: string): string {
  return codeflowDir(projectPath);
}
