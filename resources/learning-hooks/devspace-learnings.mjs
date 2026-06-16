#!/usr/bin/env node
// DevSpace SessionStart hook — injects THIS project's distilled learnings +
// curated memory into the Claude session, so the model actually uses them
// during the chat (the same pattern MemPalace uses for its memory).
//
// Output: Claude Code SessionStart hook JSON whose
// hookSpecificOutput.additionalContext is merged into the model's context.
// Reads DevSpace's native file-based memory directly (~/.devspace/...), so it
// has no dependency on the running app or any IPC. Never throws — a hook that
// errors must not break the user's session.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function emit(ctx) {
  if (ctx) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: ctx,
        },
      }),
    );
  }
  process.exit(0);
}

function parseEntry(raw, fallbackName) {
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
  return {
    type: fm.type || 'memory',
    desc: fm.description || fm.name || fallbackName,
    body: body.trim(),
  };
}

try {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const hash = createHash('sha1').update(projectDir).digest('hex').slice(0, 12);
  const memDir = join(homedir(), '.devspace', 'projects', hash, 'memory');

  let files;
  try {
    files = readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {
    emit(''); // no memory dir for this project — nothing to inject
  }

  const LEARNING_TYPES = new Set(['lesson', 'workflow', 'preference', 'feedback']);
  const learnings = [];
  const memory = [];
  for (const f of files) {
    let raw;
    try {
      raw = readFileSync(join(memDir, f), 'utf8');
    } catch {
      continue;
    }
    const e = parseEntry(raw, f.replace(/\.md$/, ''));
    (LEARNING_TYPES.has(e.type) ? learnings : memory).push(e);
  }

  if (learnings.length === 0 && memory.length === 0) emit('');

  const fmt = (e) => {
    const oneLine = e.body.replace(/\s+/g, ' ').trim();
    const detail = oneLine && oneLine !== e.desc ? ` — ${oneLine.slice(0, 360)}` : '';
    return `- [${e.type}] ${e.desc}${detail}`;
  };

  const sections = [];
  if (learnings.length) {
    sections.push(
      'Distilled learnings for this project (apply them; do not relearn):\n' +
        learnings.slice(0, 25).map(fmt).join('\n'),
    );
  }
  if (memory.length) {
    sections.push('Project memory notes:\n' + memory.slice(0, 15).map(fmt).join('\n'));
  }

  emit(
    'DevSpace native memory for this codebase — treat as established context:\n\n' +
      sections.join('\n\n'),
  );
} catch {
  emit(''); // never break the session
}
