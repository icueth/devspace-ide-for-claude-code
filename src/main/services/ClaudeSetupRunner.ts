import * as os from 'node:os';

import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import { createPty } from '@main/services/PtyPool';
import { getStatus } from '@main/services/SetupService';
import { ensureFolderTrusted } from '@main/utils/claudeTrust';
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
        return '- **rtk** — `brew tap rtk-ai/rtk && brew install rtk` on macOS (the Rust Token Killer; not the Rust Type Kit). Confirm with `rtk --version` and `rtk gain` (should not error).';
      case 'jq':
        return '- **jq** — `brew install jq`. Verify `jq --version`.';
      case 'rtkHook':
        return [
          '- **rtk Claude hook** — install at `~/.claude/hooks/rtk-rewrite.sh` and register it as a `PreToolUse` matcher `"Bash"` hook in `~/.claude/settings.json`.',
          '  Back up `~/.claude/settings.json` before editing. Use `jq` to edit JSON safely — do not regex-replace.',
          '  Generate a minimal forwarder script that calls `exec rtk "$@"` and re-emit the rewritten bash command.',
          '  De-duplicate by `command` so re-runs do not multiply entries.',
        ].join('\n');
      case 'learningHooks':
        return [
          '- **DevSpace learning hooks** — copy `devspace-learnings.mjs` and `devspace-distill-stop.mjs` into `~/.claude/hooks/` (these ship with DevSpace under its resources/learning-hooks/ — prefer the deterministic installer, which already has them).',
          '  Register `devspace-learnings.mjs` as a `SessionStart` hook and `devspace-distill-stop.mjs` as a `Stop` hook in `~/.claude/settings.json`.',
          '  Back up `~/.claude/settings.json` first. Use `jq` to edit JSON safely — do not regex-replace. De-duplicate by filename so re-runs do not multiply entries; never disturb existing SessionStart/Stop hooks.',
        ].join('\n');
      case 'opencode':
        return '- **OpenCode** — `npm install -g opencode-ai`. Verify `opencode --version`.';
      case 'codex':
        return '- **Codex CLI** — `npm install -g @openai/codex`. Verify `codex --version`.';
      case 'gemini':
        return '- **Gemini CLI** — `npm install -g @google/gemini-cli`. Verify `GEMINI_CLI_NO_RELAUNCH=1 gemini --version` (set that env var, Gemini can hang re-execing otherwise).';
      case 'antigravity':
        return '- **Antigravity CLI (agy)** — `curl -fsSL https://antigravity.google/cli/install.sh | bash` (installs to ~/.local/bin). Verify `~/.local/bin/agy --version`.';
      case 'mempalace':
        return [
          '- **MemPalace** — install the binary: `uv tool install mempalace` (run `brew install uv` first if `uv` is missing). Verify `mempalace --version`.',
          '  This gives every CLI the shared memory brain. The full Claude plugin + session hooks + vault are best set up from DevSpace → Settings → Memory (bundled installer) — mention that to the user when done.',
        ].join('\n');
    }
  });

  return [
    'You are running inside devspace as the user environment installer for Claude Code.',
    'You are launched as an interactive session with `--dangerously-skip-permissions`, so the Bash tool will execute without per-command approval prompts.',
    '',
    'The deterministic installer left these tools still missing:',
    '',
    ...lines,
    '',
    'Rules:',
    '- Use the Bash tool. Work step-by-step: install one tool, run its verification command, print the output, then move on.',
    '- On macOS prefer Homebrew (`brew install …`). On Linux detect the package manager via `command -v apt-get / dnf / pacman` and use the right one.',
    '- After each install, run the verification command stated above and print its actual output. Never claim success without observed output.',
    '- If a step fails, surface the real error (exit code + stderr) instead of declaring success. Retry once if it looks transient (network blip); otherwise stop and report.',
    '- Never use `--no-verify`, never disable hooks, never rewrite an unrelated section of `~/.claude/settings.json` — only touch `hooks.PreToolUse`.',
    '- When every listed tool is verified (or you cannot proceed), print exactly this on its own line: `SETUP-COMPLETE`, then one line per tool: `<tool>: ok` or `<tool>: failed <reason>`.',
    '',
    'Start now — install the first missing tool above.',
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
    (c): c is SetupCheck => c.state === 'missing' || c.state === 'blocked',
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

  // Interactive mode (no --print) — so the spawned claude stays alive long
  // enough for the user to watch the install in xterm, type follow-ups if
  // it stalls, and Ctrl+C to abort. `--dangerously-skip-permissions` lets
  // Bash run brew/curl without per-command approval prompts.
  //
  // The prompt is passed as a positional argument: claude prefills it as the
  // first user message and starts working immediately on launch.
  // Pre-accept Claude's "trust this folder" dialog for the setup cwd — without
  // this the session loops on the trust prompt instead of running the prefilled
  // install (pressing Enter just re-shows the dialog).
  await ensureFolderTrusted(cwd);
  const session = await createPty({
    projectId: SETUP_PROJECT_ID,
    kind: 'setup-claude',
    tabId,
    cwd,
    command: claudeBin,
    args: ['--dangerously-skip-permissions', prompt],
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
 * Claude-resolvable — now the full set: base tools + every AI CLI + MemPalace.
 */
export function claudeAddressableTools(): SetupToolId[] {
  return [
    'brew',
    'claude',
    'tmux',
    'rtk',
    'jq',
    'rtkHook',
    'learningHooks',
    'opencode',
    'codex',
    'gemini',
    'antigravity',
    'mempalace',
  ];
}
