import * as os from 'node:os';

import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import { createPty } from '@main/services/PtyPool';
import { getStatus } from '@main/services/SetupService';
import { createLogger } from '@shared/logger';
import type { SetupCheck, SetupToolId } from '@shared/setup';
import type { PtySession } from '@shared/types';

const logger = createLogger('ClaudeSetupRunner');

/**
 * Build the install prompt sent to claude. Lists only the tools the
 * deterministic installer couldn't finish, plus verification steps so the
 * model confirms each install succeeded before reporting done.
 */
function buildPrompt(missing: SetupCheck[]): string {
  const lines = missing.map((c) => {
    switch (c.id) {
      case 'brew':
        return '- **Homebrew** — https://brew.sh. Run the official installer non-interactively. Verify `brew --version`.';
      case 'claude':
        return '- **Claude Code CLI** — `curl -fsSL https://claude.ai/install.sh | bash`. Verify `claude --version`.';
      case 'tmux':
        return '- **tmux** — `brew install tmux` (macOS) or `apt install tmux` / `dnf install tmux` (Linux). Verify `tmux -V`.';
      case 'rtk':
        return '- **rtk** — `brew install rtk` on macOS (the Rust Token Killer; not the Rust Type Kit). Confirm with `rtk --version` and `rtk gain` (should not error).';
      case 'jq':
        return '- **jq** — `brew install jq`. Verify `jq --version`.';
      case 'rtkHook':
        return [
          '- **rtk Claude hook** — install at `~/.claude/hooks/rtk-rewrite.sh` and register it as a `PreToolUse` matcher `"Bash"` hook in `~/.claude/settings.json`.',
          '  Use the bundled script if devspace has placed one in `~/.claude/hooks/rtk-rewrite.sh`. Otherwise generate a minimal forwarder that re-invokes `rtk <command>`.',
          '  Back up `~/.claude/settings.json` before editing.',
        ].join('\n');
      case 'mempalace':
        return '- **MemPalace** — skip here; the user has a dedicated Settings → Memory tab for it.';
    }
  });

  return [
    'You are running inside devspace as the user environment installer for Claude Code.',
    '',
    'The deterministic installer left these tools still missing:',
    '',
    ...lines,
    '',
    'Rules:',
    '- Use Bash. Do NOT ask for confirmation — proceed.',
    '- On macOS prefer Homebrew (`brew install …`). On Linux use the distro package manager (`apt-get`, `dnf`, `pacman`). Detect the platform with `uname -s` and the package manager with `command -v`.',
    "- After each install, run the verification command stated above and print its output. If it fails, retry or surface the actual error rather than declaring success.",
    '- Never use `--no-verify`, never disable hooks, never rewrite an unrelated section of `~/.claude/settings.json`.',
    '- When done, print exactly the line: `SETUP-COMPLETE` on its own line, followed by a one-line summary per tool (`tool: ok|failed reason`).',
    '',
    'Start now.',
  ].join('\n');
}

export interface RunClaudeSetupOptions {
  cols?: number;
  rows?: number;
}

export interface RunClaudeSetupResult {
  ok: boolean;
  session?: PtySession;
  error?: string;
}

const SETUP_PROJECT_ID = '__devspace_setup__';

/**
 * Spawn claude with the install prompt as its first user turn. Returns the
 * PTY session id so the renderer can mount an xterm against it.
 *
 * The PTY uses kind 'setup-claude' + a fresh tabId per invocation so it
 * never collides with the dock's claude-cli session.
 */
export async function runClaudeSetup(
  opts: RunClaudeSetupOptions = {},
): Promise<RunClaudeSetupResult> {
  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    return {
      ok: false,
      error:
        'Claude Code CLI not found on PATH. Install Claude Code first (the deterministic installer can do this).',
    };
  }

  // Re-check status fresh so we don't ask Claude to re-install things that
  // the user already fixed manually between clicks.
  const status = await getStatus();
  const missing = status.checks.filter(
    (c): c is SetupCheck =>
      c.id !== 'mempalace' &&
      (c.state === 'missing' || c.state === 'blocked'),
  );

  if (missing.length === 0) {
    return {
      ok: false,
      error: 'Nothing to install — every required tool is already set up.',
    };
  }

  const prompt = buildPrompt(missing);
  const tabId = `setup-${Date.now()}`;
  const cwd = os.homedir();

  logger.info(
    `spawning claude setup (cols=${opts.cols ?? 120} rows=${opts.rows ?? 32}) — ${missing.length} missing tools: ${missing.map((c) => c.id).join(', ')}`,
  );

  const missingIds = missing.map((c) => c.id).join(',');

  const session = await createPty({
    projectId: SETUP_PROJECT_ID,
    kind: 'setup-claude',
    tabId,
    cwd,
    command: claudeBin,
    args: [
      '--dangerously-skip-permissions',
      '--print',
      '--verbose',
      '--allowed-tools',
      'Bash,Read,Edit,Write',
      prompt,
    ],
    cols: opts.cols,
    rows: opts.rows,
  });

  // Best-effort: log the missing-id signature for telemetry/debug. The PTY
  // session itself drives the actual interaction.
  logger.info(`setup session ${session.sessionId} spawned for [${missingIds}]`);

  return { ok: true, session };
}

/**
 * Exposed so the renderer (and tests) can know which tool ids we treat as
 * Claude-resolvable. MemPalace is excluded — it has its own installer.
 */
export function claudeAddressableTools(): SetupToolId[] {
  return ['brew', 'claude', 'tmux', 'rtk', 'jq', 'rtkHook'];
}
