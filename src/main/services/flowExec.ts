// Agent Flow — headless node execution.
//
// A headless node is `claude -p` (print / non-interactive): it runs the brief
// in the project cwd and prints the response to stdout, which becomes the
// node's captured output and the downstream node's context.
//
// NEVER `claude --bg`: that backgrounds the work and returns a stub immediately
// (no model output ever reaches us) — see DistillationService.ts:22-28. Print
// mode uses the user's normal Claude Code login, not the Agent SDK credit pool.
//
// Differs from DistillationService.runClaudePrint in the three things a flow
// node needs: a `cwd` (the project — the agent must see the repo), per-node
// auth env, and an external kill handle so stopRun can cancel work in flight.

import { spawn } from 'node:child_process';

import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import { OUTPUT_CAP } from '@main/services/flowSessions';
import { enrichedPath } from '@main/utils/setupPaths';
import { createLogger } from '@shared/logger';

const logger = createLogger('FlowExec');

// A flow node is a real unit of agent work (research, implement, test), not a
// one-shot summarization — so the ceiling is generous. It exists only to stop a
// wedged child pinning a run in 'running' forever.
const EXEC_TIMEOUT_MS = 15 * 60_000;

export interface FlowExecResult {
  ok: boolean;
  text: string;
  error?: string;
}

export interface FlowExecHandle {
  /** Resolves when the child exits / times out / is killed. Never rejects. */
  done: Promise<FlowExecResult>;
  /** Cancel the child (stopRun). Idempotent; safe after exit. */
  kill(): void;
}

// The ANTHROPIC_* vars a profile may set. Cleared from the inherited env before
// the profile's own pairs are applied, so a key in the user's global shell env
// can't silently override the node's chosen credentials (same reasoning as the
// `env -u` wrapper in ClaudeCliLauncher).
const ANTHROPIC_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
];

/**
 * Start `claude -p` in `cwd` with the prompt on stdin (no shell quoting, any
 * length) and capture stdout. `envPairs` are "KEY=VALUE" strings — exactly what
 * ClaudeAuthService.resolveAuthEnvPairs returns for the node's auth profile
 * (empty = the user's subscription login).
 *
 * --dangerously-skip-permissions: a flow node is an agent doing real work in
 * the user's repo, and print mode has no human to answer a tool prompt — it
 * would deadlock or silently refuse. Same trust boundary the interactive CLI
 * panes already run on (ClaudeCliLauncher.ts:138-144): the user designed this
 * flow and pointed it at this project.
 *
 * `model` (phase 2) is the node's `--model`: an argv flag, not ANTHROPIC_MODEL,
 * because the env var is ignored on a subscription login while the flag works
 * on both. Absent = the CLI's default model.
 *
 * Never throws: every failure (no binary, spawn error, non-zero exit, timeout,
 * kill) resolves to `{ ok: false, error }` so the engine maps it to a failed
 * node instead of an unhandled rejection.
 */
export async function startClaudePrintIn(
  cwd: string,
  prompt: string,
  envPairs: string[] = [],
  model?: string,
): Promise<FlowExecHandle> {
  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    return {
      done: Promise.resolve({ ok: false, text: '', error: 'claude not found on PATH' }),
      kill: () => undefined,
    };
  }

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: enrichedPath() };
  for (const v of ANTHROPIC_VARS) delete env[v];
  for (const pair of envPairs) {
    const eq = pair.indexOf('=');
    if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  let killChild = (): void => undefined;

  const done = new Promise<FlowExecResult>((resolve) => {
    let settled = false;
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: FlowExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    const args = ['-p', '--dangerously-skip-permissions'];
    if ((model ?? '').trim()) args.push('--model', (model as string).trim());

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(claudeBin, args, { cwd, env });
    } catch (err) {
      finish({ ok: false, text: '', error: (err as Error).message });
      return;
    }

    killChild = (): void => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, text: '', error: 'stopped' });
    };

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, text: '', error: `timed out after ${EXEC_TIMEOUT_MS / 60_000}m` });
    }, EXEC_TIMEOUT_MS);

    // Cap at accumulation, not at exit — a chatty child can otherwise buffer
    // hundreds of MB in the main process across its 15-minute lifetime; only
    // the tail feeds downstream prompts anyway (same cap as PTY capture).
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout = (stdout + d.toString()).slice(-OUTPUT_CAP);
    });
    child.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4_000);
    });
    child.on('error', (err) => finish({ ok: false, text: '', error: err.message }));
    child.on('close', (code) => {
      if (killed) return; // kill() already settled with 'stopped'
      finish({
        ok: code === 0,
        text: stdout,
        error: code !== 0 ? stderr.trim() || `exit ${code}` : undefined,
      });
    });

    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch (err) {
      logger.warn(`flow node stdin write failed: ${(err as Error).message}`);
      // Don't settle — let the child's own exit/error drive the result.
    }
  });

  return { done, kill: () => killChild() };
}
