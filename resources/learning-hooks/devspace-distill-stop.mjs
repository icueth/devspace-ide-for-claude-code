#!/usr/bin/env node
// DevSpace Stop hook — AUTO native-learning for raw-terminal Claude Code
// sessions OUTSIDE the DevSpace app.
//
// When a `claude` session ends in a plain terminal, the app's PtyPool exit
// handler (which drives the clean Part-A path) never fires — there is no app
// running. This standalone hook is the fallback: it distills THIS project's
// recent diary + memory into durable learnings and writes them straight into
// DevSpace's native file-based memory (~/.devspace/...), so the SessionStart
// inject hook can surface them next time.
//
// It is intentionally dependency-free: no app, no IPC, no imports beyond Node
// builtins. It NEVER throws and ALWAYS exits 0 — a Stop hook that errors must
// not disturb the user's terminal.
//
// ─── CAVEAT (important) ──────────────────────────────────────────────────────
// Learnings written by THIS hook are NOT embedded. They bypass the app's
// createEntry → embed pipeline, so they land as plain markdown that the
// SessionStart hook can inject verbatim, but they are NOT semantic-searchable
// until the DevSpace app next re-indexes that project's memory dir (init/
// rebuild on launch picks them up and embeds them). The app-internal Part-A
// path (maybeAutoDistill → distill → MemoryService.createEntry) embeds
// properly and is the preferred route; this hook is the raw-terminal fallback.
//
// ─── ANTI-RECURSION (critical) ───────────────────────────────────────────────
// This hook itself spawns `claude -p` to do the distillation. That child is a
// Claude session too, so when IT stops, THIS Stop hook would fire again, which
// would spawn another `claude -p`, … → infinite recursion that hammers the
// user's account. The guard: we set DEVSPACE_DISTILLING=1 in the child's env,
// and the very first thing this hook does is bail if DEVSPACE_DISTILLING is
// already set. So the distill child's own Stop event is a no-op.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── anti-recursion guard — MUST be first ────────────────────────────────────
// If we are already inside a distill child (we set this when we spawn claude),
// this Stop event is the child's own — do nothing, or we recurse forever.
if (process.env.DEVSPACE_DISTILLING) {
  process.exit(0);
}

// ─── tunables (kept in lockstep with DistillationService.ts) ─────────────────
const THROTTLE_MS = 30 * 60_000; // mirror AUTO_DISTILL_THROTTLE_MS
const LEARNINGS_START = '<<<LEARNINGS>>>';
const LEARNINGS_END = '<<<END>>>';
const AUTO_COMMIT_CONFIDENCE = 0.6; // only persist learnings at/above this
const MAX_DIARY_FILES = 5;
const MAX_MEMORY_FILES = 12;
const MAX_ITEM_CHARS = 1_200;
const MAX_DIGEST_CHARS = 16_000;
const CLAUDE_TIMEOUT_MS = 5 * 60_000;

const exit0 = () => process.exit(0);

function projectHash(projectDir) {
  return createHash('sha1').update(projectDir).digest('hex').slice(0, 12);
}

// Minimal frontmatter parser — mirrors the app's serializeFile shape:
//   ---\nkey: value\n...\n---\n\n<body>
function parseEntry(raw) {
  const fm = {};
  let body = raw;
  if (raw.startsWith('---')) {
    const idx = raw.indexOf('\n---', 3);
    if (idx >= 0) {
      for (const line of raw.slice(3, idx).split('\n')) {
        const m = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
        if (m) fm[m[1]] = m[2];
      }
      body = raw.slice(idx + 4).replace(/^\n/, '');
    }
  }
  return { fm, body: body.trim() };
}

function trimItemText(raw) {
  const collapsed = (raw ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (collapsed.length <= MAX_ITEM_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_ITEM_CHARS)}…`;
}

// Same slug rules as MemoryService.slugify: lowercase, non-alnum → '-', trim
// dashes, max 80 chars, ensure it starts with an alnum.
function slugify(input) {
  if (typeof input !== 'string') return 'entry';
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (base.length === 0) return 'entry';
  if (!/^[a-z0-9]/.test(base)) return ('e-' + base.slice(0, 78)).replace(/-+$/, '');
  return base;
}

// Build the same bounded, most-recent-first digest the app builds, but reading
// diary + memory markdown straight off disk (no MemoryService). Returns a list
// of { label, text } items. Diary first (most recent dates), then recently-
// modified memory entries, all under the global char budget.
function buildDigestItems(hash) {
  const projDir = join(homedir(), '.devspace', 'projects', hash);
  const items = [];

  // Diary: YYYY-MM-DD.md, newest dates first (filename sorts lexicographically
  // = chronologically).
  try {
    const diaryDir = join(projDir, 'diary');
    const diaryFiles = readdirSync(diaryDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, MAX_DIARY_FILES);
    for (const f of diaryFiles) {
      let raw;
      try {
        raw = readFileSync(join(diaryDir, f), 'utf8');
      } catch {
        continue;
      }
      const { body } = parseEntry(raw);
      const text = trimItemText(body);
      if (text) items.push({ label: `diary ${f.replace(/\.md$/, '')}`, text });
    }
  } catch {
    /* no diary dir — fine */
  }

  // Memory: <type>_<slug>.md (skip the generated MEMORY.md index). Sort by mtime
  // desc so "recent" means recently-touched memory.
  try {
    const memDir = join(projDir, 'memory');
    const memFiles = readdirSync(memDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md') && d.name !== 'MEMORY.md')
      .map((d) => {
        let mtime = 0;
        try {
          mtime = statSync(join(memDir, d.name)).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { name: d.name, mtime };
      })
      // Most-recently-modified first so "recent" memory means recent.
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_MEMORY_FILES);
    for (const { name } of memFiles) {
      let raw;
      try {
        raw = readFileSync(join(memDir, name), 'utf8');
      } catch {
        continue;
      }
      const { fm, body } = parseEntry(raw);
      const desc = fm.description || fm.name || name.replace(/\.md$/, '');
      const text = trimItemText(`${desc}\n${body}`);
      if (text) items.push({ label: `memory (${fm.type || 'memory'}): ${desc}`, text });
    }
  } catch {
    /* no memory dir — fine */
  }

  // Apply the global char budget, keeping items in collection order (diary-
  // recent first), mirroring the app's bounded digest.
  const bounded = [];
  let used = 0;
  for (const it of items) {
    const cost = it.label.length + it.text.length + 8;
    if (used + cost > MAX_DIGEST_CHARS) break;
    bounded.push(it);
    used += cost;
  }
  return bounded;
}

// Same prompt contract the app uses (kind/title/body/confidence between the
// sentinel markers). Kept aligned with DistillationService.buildDistillPrompt.
function buildPrompt(items) {
  const body = items
    .map((it, i) => `[${i + 1}] ${it.label}\n${it.text}`)
    .join('\n\n---\n\n');
  return [
    "You are distilling durable LEARNINGS from a developer's recent activity",
    'on one project. Below is a bounded, most-recent-first digest of their',
    'diary entries and recent memory notes.',
    '',
    'Produce a FEW (0–5) high-quality, durable learnings that will help future',
    'work on this project. Each learning is one of:',
    "  - 'lesson'      — a non-obvious insight / gotcha / thing that went wrong",
    "                    or right and why (so it isn't repeated/relearned).",
    "  - 'preference'  — a way the developer wants work done (style, process,",
    '                    tooling) that should shape future behavior.',
    "  - 'workflow'    — a recurring multi-step procedure worth shortcutting.",
    '',
    'STRICT GROUNDING RULE: every learning MUST be directly supported by the',
    'digest below. Do NOT invent, generalize beyond the evidence, or restate',
    'generic best practices. If the digest does not support any durable',
    'learning, return an EMPTY array. Few and high-quality beats many.',
    '',
    'Output ONLY a JSON array between the exact sentinel markers below, with no',
    'prose before or after the closing marker. Each element:',
    '  { "kind": "lesson"|"preference"|"workflow",',
    '    "title": short imperative title (<= 80 chars),',
    '    "body": 1-3 sentences explaining the learning and why it matters,',
    '    "confidence": number 0..1 (how strongly the digest supports this) }',
    '',
    LEARNINGS_START,
    '[ ... ]',
    LEARNINGS_END,
    '',
    '=== ACTIVITY DIGEST ===',
    body || '(no recent activity)',
    '=== END DIGEST ===',
  ].join('\n');
}

// Parse the JSON learnings block out of (possibly noisy) stdout. Mirrors
// DistillationService.parseLearnings: last start sentinel, first end after it,
// narrow to the outermost [ … ], tolerate malformed → [].
function parseLearnings(text) {
  if (typeof text !== 'string' || !text) return [];
  const startIdx = text.lastIndexOf(LEARNINGS_START);
  if (startIdx === -1) return [];
  const afterStart = startIdx + LEARNINGS_START.length;
  const endIdx = text.indexOf(LEARNINGS_END, afterStart);
  if (endIdx === -1) return [];
  const block = text.slice(afterStart, endIdx).trim();
  if (!block) return [];
  const first = block.indexOf('[');
  const last = block.lastIndexOf(']');
  if (first === -1 || last === -1 || last < first) return [];
  let parsed;
  try {
    parsed = JSON.parse(block.slice(first, last + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = raw.kind;
    if (kind !== 'lesson' && kind !== 'preference' && kind !== 'workflow') continue;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const body = typeof raw.body === 'string' ? raw.body.trim() : '';
    if (!title || !body) continue;
    let confidence = typeof raw.confidence === 'number' ? raw.confidence : NaN;
    if (!Number.isFinite(confidence)) continue;
    confidence = Math.max(0, Math.min(1, confidence));
    out.push({
      kind,
      title: title.slice(0, 200),
      body: body.slice(0, 4_000),
      confidence,
    });
  }
  return out;
}

// 'preference' persists as 'feedback' (the type the inject preamble reads),
// matching DistillationService.memoryTypeForKind.
function memoryTypeForKind(kind) {
  if (kind === 'preference') return 'feedback';
  if (kind === 'workflow') return 'workflow';
  return 'lesson';
}

// Serialize an entry in the EXACT shape MemoryService.serializeFile writes, so
// the file round-trips through the app's parser unchanged.
function serializeEntry({ slug, description, type, body, now }) {
  const lines = ['---'];
  lines.push(`name: ${slug}`);
  lines.push(`description: ${description.replace(/\n/g, ' ')}`);
  lines.push(`type: ${type}`);
  lines.push('tags: [distilled]');
  lines.push(`createdAt: ${now}`);
  lines.push(`updatedAt: ${now}`);
  lines.push('pinned: false');
  lines.push('---', '', body.endsWith('\n') ? body : body + '\n');
  return lines.join('\n');
}

// Run `claude -p`, feeding the prompt on stdin, with DEVSPACE_DISTILLING=1 set
// so the child's own Stop event hits the anti-recursion guard above. Resolves
// { ok, text }. Never rejects.
function runClaudePrint(prompt) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawn('claude', ['-p'], {
        env: { ...process.env, DEVSPACE_DISTILLING: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ ok: false, text: '', error: String(err && err.message) });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, text: '', error: 'timed out' });
    }, CLAUDE_TIMEOUT_MS);
    let stdout = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('error', (err) => finish({ ok: false, text: '', error: String(err && err.message) }));
    child.on('close', (code) => finish({ ok: code === 0, text: stdout }));
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* let close/error drive the result */
    }
  });
}

async function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const hash = projectHash(projectDir);
  const projDir = join(homedir(), '.devspace', 'projects', hash);
  const markerPath = join(projDir, '.last-distill');
  const now = Date.now();

  // Throttle — reuse the SAME marker the app's maybeAutoDistill uses, so the
  // app-internal and terminal paths share one window per project.
  try {
    const raw = readFileSync(markerPath, 'utf8').trim();
    const last = Number.parseInt(raw, 10);
    if (Number.isFinite(last) && last > 0 && now - last < THROTTLE_MS) {
      exit0();
      return;
    }
  } catch {
    /* no marker yet — proceed */
  }

  // Gather. Nothing to learn from → no-op (don't even spend a claude run).
  const items = buildDigestItems(hash);
  if (items.length === 0) {
    exit0();
    return;
  }

  // Stamp the marker BEFORE spawning claude, so a concurrent terminal exit is
  // throttled out instead of double-firing (mirrors maybeAutoDistill).
  try {
    mkdirSync(projDir, { recursive: true });
    writeFileSync(markerPath, String(now), 'utf8');
  } catch {
    /* best-effort — a write failure just weakens the throttle briefly */
  }

  // Distill via real claude (with the anti-recursion env set on the child).
  const run = await runClaudePrint(buildPrompt(items));
  if (!run.ok) {
    exit0();
    return;
  }

  const learnings = parseLearnings(run.text).filter(
    (l) => l.confidence >= AUTO_COMMIT_CONFIDENCE,
  );
  if (learnings.length === 0) {
    exit0();
    return;
  }

  // Write each learning as a markdown file into the memory dir, de-duping by
  // slug (skip if a file with that slug already exists for that type).
  const memDir = join(projDir, 'memory');
  try {
    mkdirSync(memDir, { recursive: true });
  } catch {
    exit0();
    return;
  }
  for (const l of learnings) {
    const type = memoryTypeForKind(l.kind);
    const slug = slugify(l.title);
    const file = join(memDir, `${type}_${slug}.md`);
    if (existsSync(file)) continue; // de-dup by slug
    try {
      writeFileSync(
        file,
        serializeEntry({ slug, description: l.title, type, body: l.body, now }),
        'utf8',
      );
    } catch {
      /* skip this one — keep going */
    }
  }

  exit0();
}

// Top-level guard: this hook must NEVER throw and ALWAYS exit 0.
main().then(exit0, exit0);
