// OpenCodeRunner — spawn `opencode run` for one chat turn, stream stdout
// line-by-line through the adapter's parser, and emit ChatEvents to the
// caller. Parallel to LlmChatRunner (HTTP-streaming) and TmuxChatRunner
// (detached tmux session) — this is the synchronous-process branch.
//
// Why a separate runner from TmuxChatRunner:
//   - opencode doesn't need tmux: it's a single short-lived spawn, no
//     long-running interactive state, no need to survive app restart.
//   - opencode CAN take prompts on stdin (preferred — argv has a ~32KB
//     cap on Windows / ~128KB on Linux that a long chat history will
//     trivially blow past). We open stdin and write the prompt there.
//   - opencode's stream-json format is the adapter's parseStreamLine
//     domain; this runner stays format-agnostic and just forwards lines.
//
// Lifecycle:
//   1. Caller (ChatService) calls startOpenCodeRun() with profile +
//      prompt + onEvent + onDone callbacks.
//   2. Runner ensures the per-profile config dir exists on disk (atomic
//      write via the adapter).
//   3. Runner spawns `opencode run --format json` with the prompt piped
//      through stdin, OPENCODE_CONFIG_DIR pointing at the per-profile
//      dir.
//   4. stdout is line-buffered; each line goes through
//      adapter.parseStreamLine; recognized ChatEvents fire onEvent.
//   5. On exit, onDone fires with {cancelled, exitCode, stderr}.
//
// Cancellation: kill() sends SIGTERM, waits up to TERM_TIMEOUT_MS for
// graceful exit, then SIGKILL. Same contract as TmuxChatRunner.

import { spawn, type ChildProcess } from 'node:child_process';

import { getAdapter } from '@main/cli/registry';
import { createLogger } from '@shared/logger';
import type { ChatEvent, CliProfile } from '@shared/types';

const logger = createLogger('OpenCodeRunner');

// Hard cap on captured stderr — prevents a runaway opencode error stream
// from blowing the buffer. Surface only the tail in error events.
const STDERR_CAP_BYTES = 16 * 1024;

// Grace period after SIGTERM before escalating to SIGKILL. opencode
// typically exits cleanly on SIGTERM within ~50ms; 2s is conservative.
const TERM_TIMEOUT_MS = 2000;

// Defensive per-line cap. A line longer than this is almost certainly
// upstream corruption (we never expect single-line JSON > 1MB). Truncate
// to the cap and emit; never grow the buffer unbounded.
const MAX_LINE_BYTES = 1 << 20;

export interface OpenCodeRunResult {
  exitCode: number | null;
  cancelled: boolean;
  stderr: string;
  /** Any error message captured at the spawn boundary (ENOENT, EACCES). */
  spawnError: string | null;
}

export interface OpenCodeRunHandle {
  /** Resolves once the child exits (success, error, or cancel). */
  promise: Promise<OpenCodeRunResult>;
  /** Forwarding cancel — SIGTERM then SIGKILL. Idempotent. */
  kill: () => Promise<void>;
}

export interface StartOpenCodeRunOptions {
  /** The profile bound to this thread — drives config dir + spawn args. */
  profile: CliProfile;
  /** Working directory the CLI should treat as project root. */
  cwd: string;
  /**
   * The serialized chat history + current user turn. Written to opencode
   * stdin verbatim. opencode treats stdin as the message body when no
   * positional argv is supplied to `run`.
   */
  prompt: string;
  /**
   * Fires for each ChatEvent the adapter parsed out of stdout. Throwing
   * inside this callback is logged and ignored — the runner must keep
   * draining stdout regardless.
   */
  onEvent: (event: ChatEvent) => void;
  /** Optional caller-provided AbortSignal. Wires into kill(). */
  signal?: AbortSignal;
}

export function startOpenCodeRun(
  opts: StartOpenCodeRunOptions,
): OpenCodeRunHandle {
  const adapter = getAdapter('opencode');

  let child: ChildProcess | null = null;
  let cancelled = false;
  let stderrBuf = '';
  let spawnError: string | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let resolved = false;

  // Forward external aborts.
  if (opts.signal) {
    if (opts.signal.aborted) {
      cancelled = true;
    } else {
      opts.signal.addEventListener('abort', () => {
        void killChild();
      }, { once: true });
    }
  }

  async function killChild(): Promise<void> {
    cancelled = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      } catch {
        /* already dead */
      }
    }, TERM_TIMEOUT_MS);
  }

  const promise: Promise<OpenCodeRunResult> = (async (): Promise<OpenCodeRunResult> => {
    // Always finalize regardless of which exit path we take.
    const finalize = (
      exitCode: number | null,
    ): OpenCodeRunResult => ({
      exitCode,
      cancelled,
      stderr: stderrBuf.slice(-STDERR_CAP_BYTES),
      spawnError,
    });

    try {
      await adapter.ensureConfig(opts.profile);
    } catch (err) {
      spawnError = `failed to write profile config: ${(err as Error).message}`;
      logger.warn(spawnError);
      // Surface as an error event so the renderer's chat panel shows
      // the message immediately; then resolve.
      try {
        opts.onEvent({
          kind: 'error',
          message: spawnError,
          ts: Date.now(),
        });
      } catch {
        /* swallow — broadcaster downstream */
      }
      try {
        opts.onEvent({ kind: 'done', ts: Date.now() });
      } catch {
        /* swallow */
      }
      return finalize(null);
    }

    // Code H1: cancellation race fix. If kill() (or signal.abort()) fired
    // during the ensureConfig await, `cancelled === true` but `child` was
    // still null so killChild() bailed without effect. Bail cleanly here
    // BEFORE spawning to avoid stranding the child.
    if (cancelled) {
      try {
        opts.onEvent({ kind: 'done', ts: Date.now() });
      } catch {
        /* swallow */
      }
      return finalize(null);
    }

    const spawnArgs = adapter.buildSpawnArgs(opts.profile, {
      prompt: opts.prompt,
      cwd: opts.cwd,
    });

    try {
      child = spawn(spawnArgs.bin, spawnArgs.args, {
        cwd: opts.cwd,
        env: spawnArgs.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      spawnError = `spawn failed: ${(err as Error).message}`;
      logger.warn(spawnError);
      try {
        opts.onEvent({ kind: 'error', message: spawnError, ts: Date.now() });
        opts.onEvent({ kind: 'done', ts: Date.now() });
      } catch {
        /* swallow */
      }
      return finalize(null);
    }

    // Code H1 (companion): if abort fired AFTER spawn but before we
    // installed exit handlers, SIGTERM the freshly-spawned child so the
    // exit-event promise below finalizes via the natural cancelled path.
    if (cancelled) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }

    // Pipe the prompt through stdin. opencode `run` (without positional
    // args) reads the message body from stdin. Closing stdin signals
    // end-of-message.
    try {
      if (child.stdin) {
        child.stdin.on('error', (err) => {
          // Broken pipe / EPIPE — child may have exited early. Don't
          // crash the runner; the exit handler will surface the
          // non-zero exit code.
          logger.warn(`stdin error: ${(err as Error).message}`);
        });
        child.stdin.write(opts.prompt);
        child.stdin.end();
      }
    } catch (err) {
      logger.warn(`stdin write failed: ${(err as Error).message}`);
    }

    // Line-buffered stdout. Defensive against partial multi-byte UTF-8
    // sequences — buffer raw bytes until a newline arrives.
    let stdoutBuf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      // Process every complete line. A pathological line longer than
      // MAX_LINE_BYTES gets truncated to keep memory bounded.
      while (true) {
        const nl = stdoutBuf.indexOf('\n');
        if (nl === -1) {
          if (stdoutBuf.length > MAX_LINE_BYTES) {
            // Force-flush truncated line and drop the rest until next newline.
            const line = stdoutBuf.slice(0, MAX_LINE_BYTES);
            stdoutBuf = '';
            emitLine(line);
          }
          break;
        }
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        emitLine(line);
      }
    });

    function emitLine(line: string): void {
      if (!adapter.parseStreamLine) return;
      let event: ChatEvent | null = null;
      try {
        event = adapter.parseStreamLine(line);
      } catch (err) {
        logger.warn(
          `parseStreamLine threw on "${line.slice(0, 80)}…": ${(err as Error).message}`,
        );
        return;
      }
      if (!event) return;
      try {
        opts.onEvent(event);
      } catch (err) {
        logger.warn(`onEvent threw: ${(err as Error).message}`);
      }
    }

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk;
      // Bound the buffer — keep only the last STDERR_CAP_BYTES.
      if (stderrBuf.length > STDERR_CAP_BYTES * 2) {
        stderrBuf = stderrBuf.slice(-STDERR_CAP_BYTES);
      }
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      const onSettle = (code: number | null): void => {
        if (resolved) return;
        resolved = true;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        // Flush any trailing partial line that doesn't end with \n.
        if (stdoutBuf.trim()) emitLine(stdoutBuf);
        resolve(code);
      };
      child!.on('exit', (code) => onSettle(code));
      child!.on('error', (err) => {
        spawnError = `child error: ${err.message}`;
        logger.warn(spawnError);
        onSettle(null);
      });
    });

    // Synthesize a `done` event so the renderer always sees a terminal
    // signal — opencode SHOULD emit one but a broken upstream version
    // could omit it.
    try {
      opts.onEvent({ kind: 'done', ts: Date.now() });
    } catch {
      /* swallow */
    }

    return finalize(exitCode);
  })();

  const handle: OpenCodeRunHandle = {
    promise,
    kill: async () => {
      await killChild();
      await promise.catch(() => undefined);
    },
  };

  // SEC-HIGH-5: register the handle so `before-quit` can reap it. Auto-
  // remove on natural completion so the registry doesn't grow unbounded
  // across long sessions.
  ACTIVE_RUNS.add(handle);
  promise.finally(() => {
    ACTIVE_RUNS.delete(handle);
  });

  return handle;
}

// SEC-HIGH-5: orphan-reap registry. Without this, force-quit / before-quit
// leaves spawned opencode children reparented to PID 1, still holding
// outbound TCP to the configured LLM endpoint with the apiKey in headers.
const ACTIVE_RUNS = new Set<OpenCodeRunHandle>();

/**
 * Snapshot of in-flight opencode child handles for graceful shutdown.
 * `main/index.ts` calls this from the `before-quit` handler and awaits
 * each handle's kill() with a bounded timeout (2.5s app exit cap).
 */
export function getActiveOpenCodeRuns(): readonly OpenCodeRunHandle[] {
  return [...ACTIVE_RUNS];
}

/** Best-effort shutdown of all spawned opencode children. */
export async function shutdownAllOpenCode(): Promise<void> {
  const live = [...ACTIVE_RUNS];
  await Promise.all(
    live.map((h) => h.kill().catch(() => undefined)),
  );
}
