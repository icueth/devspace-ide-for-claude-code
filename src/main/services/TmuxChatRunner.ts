// TmuxChatRunner — spawn one claude --print invocation inside a detached
// tmux session whose stdout/stderr are redirected to disk. The renderer-
// side parser tails the JSONL file so closing/reopening the app doesn't
// kill the in-flight chat turn — the tmux session keeps running even
// after the electron process exits.
//
// Layout on disk (per run):
//   <runDir>/
//     env.sh      — env vars exported before claude runs
//     prompt.txt  — stdin payload (full chat history + instruction)
//     out.jsonl   — claude --output-format stream-json output
//     stderr.log  — claude stderr (surfaced on non-zero exit)
//     done        — exit code (single line). Created only after claude
//                   finishes, used as the "completion" sentinel.
//
// Resume semantics: on app boot, ChatService scans every thread's
// `activeRun` field, calls attachToRun() with the saved dir + session
// name, and gets a stream of lines + a result promise just like a fresh
// startRun(). Cancellation kills the tmux session and the watcher polls
// settle to a final result within ~1 polling interval.

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { resolveTmuxBinary, tmuxSocketArgs } from '@main/services/ClaudeCliLauncher';
import { createLogger } from '@shared/logger';

const execFileP = promisify(execFile);
const logger = createLogger('TmuxChatRunner');

const POLL_MS = 100; // file growth + done-file polling interval

export interface ChatRunResult {
  exitCode: number | null;
  cancelled: boolean;
  // null on success; populated with stderr tail or "killed externally"
  // message when something went wrong.
  error: string | null;
}

export interface ChatRunHandle {
  // Tmux session name (e.g. "devspace-chatrun-<hash>"). Pass to
  // attachToRun() to re-establish a watcher across app restarts.
  sessionName: string;
  // Directory containing prompt.txt / out.jsonl / done. Persisted so the
  // app can resume tail on next boot.
  runDir: string;
  // Resolves once claude exits inside tmux (done file appears) OR the
  // tmux session dies (cancelled).
  promise: Promise<ChatRunResult>;
  // Whether the run is being driven by tmux (true) or a plain spawn
  // fallback (false). Fallback runs DO NOT survive app close — caller
  // can decide whether to warn the user.
  detached: boolean;
  // Kill the tmux session (or fallback spawn) so cancelActive works.
  kill: () => Promise<void>;
}

export interface StartRunOptions {
  // Used to build a unique, descriptive session name. We don't actually
  // do anything project-aware here beyond the name.
  projectId: string;
  threadId: string;
  // Caller-allocated id (short, alphanumeric); appended to the session
  // name + becomes the leaf segment of runDir.
  runId: string;
  // Working directory the claude binary should run in. Same cwd as the
  // chat thread's project.
  cwd: string;
  // Resolved absolute path to the `claude` binary.
  claudeBin: string;
  // CLI args (e.g. ['--print', '--output-format', 'stream-json', ...]).
  args: string[];
  // Shell env. Written verbatim into env.sh and sourced before exec.
  env: NodeJS.ProcessEnv;
  // The chat prompt — full conversation history + tail instruction.
  prompt: string;
  // Called for every complete JSONL line emitted by claude. Caller wires
  // this into the same handleLine() it used for the in-process spawn.
  onLine: (line: string) => void;
  // Where to root run dirs. Caller passes <projectPath>/.devspace/chat
  // so artifacts live with the rest of the chat state.
  runRoot: string;
}

export interface AttachRunOptions {
  sessionName: string;
  runDir: string;
  onLine: (line: string) => void;
}

// ─── helpers ────────────────────────────────────────────────────────────────

// POSIX single-quote escape — wraps the input in single quotes and
// replaces inner ' with '\''.
function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Build the shell command that runs inside `tmux new-session -d ... sh -c '<cmd>'`.
//   1. Source env.sh (so PATH etc. matches the user's interactive shell)
//   2. Exec claude with the stdin/stdout/stderr redirections
//   3. Write the exit code to done file (this is what the watcher polls for)
//
// Using `; echo $? > done` (not `&&`) so the sentinel always gets written
// even when claude exits non-zero — otherwise the watcher would hang.
function buildShellCommand(
  claudeBin: string,
  args: string[],
  runDir: string,
): string {
  const promptFile = path.join(runDir, 'prompt.txt');
  const outFile = path.join(runDir, 'out.jsonl');
  const errFile = path.join(runDir, 'stderr.log');
  const doneFile = path.join(runDir, 'done');
  const envFile = path.join(runDir, 'env.sh');

  const claudeQuoted = shquote(claudeBin);
  const argsQuoted = args.map(shquote).join(' ');

  return [
    `. ${shquote(envFile)}`,
    `${claudeQuoted} ${argsQuoted} < ${shquote(promptFile)} > ${shquote(outFile)} 2> ${shquote(errFile)}`,
    `echo $? > ${shquote(doneFile)}`,
  ].join(' ; ');
}

// Serialize env into a POSIX-sourceable file. Skip keys with control
// chars or invalid identifier names so sh -c doesn't choke. Values are
// single-quoted defensively.
function buildEnvScript(env: NodeJS.ProcessEnv): string {
  const lines: string[] = ['#!/bin/sh', '# devspace chat run env'];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(k)) continue;
    lines.push(`export ${k}=${shquote(v)}`);
  }
  return `${lines.join('\n')}\n`;
}

async function tmuxHasSession(
  tmuxBin: string,
  sessionName: string,
): Promise<boolean> {
  try {
    await execFileP(tmuxBin, [
      ...tmuxSocketArgs(),
      'has-session',
      '-t',
      sessionName,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxKillSession(
  tmuxBin: string,
  sessionName: string,
): Promise<void> {
  try {
    await execFileP(tmuxBin, [
      ...tmuxSocketArgs(),
      'kill-session',
      '-t',
      sessionName,
    ]);
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes('no such session') && !msg.includes('session not found')) {
      logger.warn(`kill-session ${sessionName} failed: ${msg}`);
    }
  }
}

interface TailLoopOpts {
  outFile: string;
  doneFile: string;
  sessionName: string;
  tmuxBin: string | null; // null = fallback spawn mode (no tmux check)
  fallbackChild?: { killed: boolean; exitCode: number | null };
  onLine: (line: string) => void;
}

// Start the polling loop that tails out.jsonl and waits for the done file.
// Returns a promise + a stopper + an initialDrain promise. The stopper
// is used by attachToRun's kill() so we can synchronously stop polling
// once tmux is killed. initialDrain resolves after the first drainOnce
// completes — used by attachToRun() to make resume synchronous w.r.t.
// already-written content so the renderer sees the right state when it
// queries listThreads() right after boot.
function startTailLoop(
  opts: TailLoopOpts,
): {
  promise: Promise<ChatRunResult>;
  stop: () => void;
  initialDrain: Promise<void>;
} {
  let stopped = false;
  let offset = 0;
  let partial = '';

  const drainOnce = async (): Promise<void> => {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(opts.outFile);
    } catch {
      return; // out.jsonl not created yet
    }
    if (stat.size <= offset) return;

    const fd = await fs.promises.open(opts.outFile, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await fd.read(buf, 0, buf.length, offset);
      offset = stat.size;
      partial += buf.toString('utf8');
      let nl: number;
      while ((nl = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, nl).trim();
        partial = partial.slice(nl + 1);
        if (line) {
          try {
            opts.onLine(line);
          } catch (err) {
            logger.warn(`onLine handler threw: ${(err as Error).message}`);
          }
        }
      }
    } finally {
      await fd.close();
    }
  };

  // Run the first drain eagerly so attachToRun() callers can await it
  // before exposing the handle. Errors are swallowed — the polling loop
  // will retry the same drain a tick later if the file just wasn't
  // created yet.
  const initialDrain = drainOnce().catch((err) => {
    logger.warn(`initial drain failed: ${(err as Error).message}`);
  });

  const promise = new Promise<ChatRunResult>((resolve) => {
    const tick = async () => {
      if (stopped) {
        // Drain whatever's left then resolve with cancelled state.
        await drainOnce().catch(() => undefined);
        resolve({ exitCode: null, cancelled: true, error: null });
        return;
      }

      try {
        await drainOnce();
      } catch (err) {
        logger.warn(`drain failed: ${(err as Error).message}`);
      }

      // Completion check 1: done file present (claude exited inside tmux).
      try {
        const code = await fs.promises.readFile(opts.doneFile, 'utf8');
        // Drain again — claude might have written the final bytes after
        // our last stat but before exiting.
        await drainOnce().catch(() => undefined);
        const exitCode = parseInt(code.trim(), 10);
        const cancelled = !Number.isFinite(exitCode) || exitCode === 130; // SIGINT
        let error: string | null = null;
        if (!cancelled && exitCode !== 0) {
          try {
            const stderr = await fs.promises.readFile(
              opts.doneFile.replace(/done$/, 'stderr.log'),
              'utf8',
            );
            error = stderr.trim().slice(-500) || `claude exited ${exitCode}`;
          } catch {
            error = `claude exited ${exitCode}`;
          }
        }
        resolve({
          exitCode: Number.isFinite(exitCode) ? exitCode : null,
          cancelled,
          error,
        });
        return;
      } catch {
        /* done not written yet */
      }

      // Completion check 2: tmux session vanished without writing done
      // (kill -9 on the wrapper, manual kill-session, machine reboot).
      // In fallback mode (no tmux) we look at the spawned child instead.
      if (opts.tmuxBin) {
        const alive = await tmuxHasSession(opts.tmuxBin, opts.sessionName);
        if (!alive) {
          await drainOnce().catch(() => undefined);
          resolve({ exitCode: null, cancelled: true, error: null });
          return;
        }
      } else if (opts.fallbackChild) {
        if (opts.fallbackChild.killed) {
          await drainOnce().catch(() => undefined);
          resolve({
            exitCode: opts.fallbackChild.exitCode,
            cancelled: true,
            error: null,
          });
          return;
        }
      }

      setTimeout(tick, POLL_MS);
    };
    // Kick off the poll loop only after the initial drain has settled
    // so we don't race ourselves on the offset / partial buffer.
    void initialDrain.then(() => setTimeout(tick, POLL_MS));
  });

  return {
    promise,
    stop: () => {
      stopped = true;
    },
    initialDrain,
  };
}

// ─── public API ─────────────────────────────────────────────────────────────

// Start a new tmux-backed claude run. Falls back to plain spawn when
// tmux is unavailable; semantics stay identical except the run does NOT
// survive app close in fallback mode.
export async function startChatRun(opts: StartRunOptions): Promise<ChatRunHandle> {
  const runDir = path.join(opts.runRoot, 'runs', opts.threadId, opts.runId);
  await fs.promises.mkdir(runDir, { recursive: true });

  // Write the three input artifacts before spawning so the wrapper
  // never sees a partial prompt/env.
  await fs.promises.writeFile(path.join(runDir, 'prompt.txt'), opts.prompt);
  await fs.promises.writeFile(
    path.join(runDir, 'env.sh'),
    buildEnvScript(opts.env),
    { mode: 0o600 },
  );
  await fs.promises.writeFile(path.join(runDir, 'out.jsonl'), '');
  await fs.promises.writeFile(path.join(runDir, 'stderr.log'), '');

  const shellCmd = buildShellCommand(opts.claudeBin, opts.args, runDir);
  const tmuxBin = await resolveTmuxBinary();

  // Session name: 80-char tmux limit. Prefix + 12 chars of runId is plenty.
  const sessionName = `devspace-chatrun-${opts.runId}`.slice(0, 60);

  if (tmuxBin) {
    // Spawn tmux new-session -d so the tmux server daemonizes the inner
    // shell. The parent process here exits immediately after `tmux new-
    // session` returns, leaving the wrapper running detached.
    await new Promise<void>((resolve, reject) => {
      const tmuxArgs = [
        ...tmuxSocketArgs(),
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        opts.cwd,
        'sh',
        '-c',
        shellCmd,
      ];
      logger.info(
        `tmux new-session -s ${sessionName} cwd=${opts.cwd} runDir=${runDir}`,
      );
      const child = spawn(tmuxBin, tmuxArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let stderr = '';
      child.stderr?.on('data', (b: Buffer) => {
        stderr += b.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tmux new-session failed (${code}): ${stderr.trim()}`));
      });
    });

    const tail = startTailLoop({
      outFile: path.join(runDir, 'out.jsonl'),
      doneFile: path.join(runDir, 'done'),
      sessionName,
      tmuxBin,
      onLine: opts.onLine,
    });

    return {
      sessionName,
      runDir,
      detached: true,
      promise: tail.promise,
      kill: async () => {
        await tmuxKillSession(tmuxBin, sessionName);
        tail.stop();
      },
    };
  }

  // ─── Fallback: no tmux. Spawn shell wrapper directly as electron child.
  // Closing the app WILL kill this run, same as the pre-tmux behavior.
  logger.warn(
    `tmux not available — chat run ${opts.runId} will NOT survive app close`,
  );

  const fallbackState = { killed: false, exitCode: null as number | null };
  const child = spawn('sh', ['-c', shellCmd], {
    cwd: opts.cwd,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', () => undefined); // already redirected to file
  child.on('exit', (code) => {
    fallbackState.exitCode = code;
    if (!fallbackState.killed && code !== 0) {
      // Wrapper crashed before claude could even start — make sure the
      // tail loop terminates. The shell wrapper writes done itself on
      // normal exit, so this branch is for catastrophic failure (out of
      // memory, missing /bin/sh, etc.).
      fallbackState.killed = true;
    }
  });

  const tail = startTailLoop({
    outFile: path.join(runDir, 'out.jsonl'),
    doneFile: path.join(runDir, 'done'),
    sessionName,
    tmuxBin: null,
    fallbackChild: fallbackState,
    onLine: opts.onLine,
  });

  return {
    sessionName,
    runDir,
    detached: false,
    promise: tail.promise,
    kill: async () => {
      fallbackState.killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      tail.stop();
    },
  };
}

// Re-attach a watcher to an existing run. Called on app boot for every
// thread.activeRun. If the tmux session is gone AND no done file exists,
// the run is treated as cancelled and resolves immediately.
//
// IMPORTANT: this awaits the initial out.jsonl drain before returning,
// so by the time the caller hands the handle around, every line that
// claude has already written has been replayed through onLine() into
// the assistant message. The renderer's first listThreads() after boot
// thus reflects the up-to-date partial state, even though it missed
// the broadcasts that happened during replay.
export async function attachToRun(
  opts: AttachRunOptions,
): Promise<ChatRunHandle> {
  const tmuxBin = await resolveTmuxBinary();
  const sessionName = opts.sessionName;
  const runDir = opts.runDir;

  // If we can't find tmux at all, we can still tail the file in case
  // done already got written. Treat it as fallback mode.
  const tail = startTailLoop({
    outFile: path.join(runDir, 'out.jsonl'),
    doneFile: path.join(runDir, 'done'),
    sessionName,
    tmuxBin,
    onLine: opts.onLine,
  });

  // Block on the initial drain so callers can sync their state before
  // exposing the run to subscribers.
  await tail.initialDrain;

  return {
    sessionName,
    runDir,
    detached: !!tmuxBin,
    promise: tail.promise,
    kill: async () => {
      if (tmuxBin) await tmuxKillSession(tmuxBin, sessionName);
      tail.stop();
    },
  };
}

// Generate a short alphanumeric run id (~12 chars) — used by the caller
// to name the run dir + tmux session. Built from a timestamp + small
// randomness to make scanning chronologically friendly.
export function newRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0x1000000).toString(36);
  return `${ts}-${rand}`;
}
