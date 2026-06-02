// BackgroundClaudeRunner — v0.37.
//
// Spawns `claude --bg --exec '<text>'` as a detached child (NOT a PTY) so
// it can run independently of any open Claude CLI tab. Each spawn gets a
// run id, captures stdout + stderr to a per-run log file under
// ~/.devspace/bg-runs/<runId>.log, and tracks lifecycle state in an
// in-memory map.
//
// Scope choices:
//   - child_process.spawn — no need for a TTY, claude --bg never expects
//     interactive input. Detached + ignored stdin so an electron quit
//     doesn't tear down the child (the user explicitly wanted a
//     background run).
//   - one log file per run, append-only, capped to MAX_LOG_BYTES so a
//     runaway logger can't fill the home directory.
//   - in-memory map only — restarts of the app forget runs and orphan
//     the children. Acceptable for v0.37 (thinner version per spec); a
//     persisted manifest is the v0.37.1 TODO.
//
// TODO(v0.37.1): full "Background runs" rail with live tail + per-row
// kill + status badges. The spawn + IPC + picker entry land in v0.37;
// the rail UI is deferred to keep the v0.37 surface tight.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import type {
  BackgroundRunMeta,
  BackgroundRunStatus,
} from '@shared/types';

export type { BackgroundRunMeta, BackgroundRunStatus };

const logger = createLogger('BackgroundClaudeRunner');

// 32 MB per run — generous for tool-heavy sessions but bounded so a runaway
// claude can't OOM the disk. Excess writes are silently dropped after
// emitting a single truncation marker into the log.
const MAX_LOG_BYTES = 32 * 1024 * 1024;
// Hard upper bound on commands so a typo paste can't get smuggled through.
const MAX_COMMAND_BYTES = 32 * 1024;

interface BackgroundRunInternal extends BackgroundRunMeta {
  child?: ChildProcess;
  // Open write stream — closed in cleanup so a kill doesn't leak the FD.
  out?: fs.WriteStream;
  // Total bytes written so far. Tracked separately from disk size so we
  // can apply the truncation cap without an extra fs.stat round-trip.
  written: number;
  // Set true once we emitted the "log capped" marker, so the rest of the
  // output goes to /dev/null without spamming the marker line.
  capped: boolean;
}

const RUNS = new Map<string, BackgroundRunInternal>();

function bgRunsDir(): string {
  return path.join(os.homedir(), '.devspace', 'bg-runs');
}

async function ensureBgRunsDir(): Promise<string> {
  const dir = bgRunsDir();
  // 0o700 — log files may carry tool output from the user's project.
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function publicMeta(run: BackgroundRunInternal): BackgroundRunMeta {
  return {
    runId: run.runId,
    command: run.command,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    logPath: run.logPath,
    pid: run.pid,
    logBytes: run.written,
  };
}

/**
 * Spawn `claude --bg --exec '<command>'`. Returns the public run meta as
 * soon as the child has been spawned (or threw, in which case status is
 * 'failed').
 */
export async function startBackgroundRun(
  command: string,
): Promise<BackgroundRunMeta> {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('startBackgroundRun: command must be a non-empty string');
  }
  if (command.length > MAX_COMMAND_BYTES) {
    throw new Error(
      `startBackgroundRun: command exceeds ${MAX_COMMAND_BYTES} bytes`,
    );
  }

  const dir = await ensureBgRunsDir();
  const runId = randomUUID();
  const logPath = path.join(dir, `${runId}.log`);
  const startedAt = Date.now();

  const run: BackgroundRunInternal = {
    runId,
    command,
    status: 'pending',
    startedAt,
    exitCode: null,
    logPath,
    // Public-meta byte count; the live counter is `written` (publicMeta maps
    // logBytes ← written). Seeded at 0 to satisfy the BackgroundRunMeta shape.
    logBytes: 0,
    written: 0,
    capped: false,
  };
  RUNS.set(runId, run);

  try {
    const out = fs.createWriteStream(logPath, {
      mode: 0o600,
      flags: 'a',
    });
    run.out = out;
    out.write(`# claude --bg --exec ${JSON.stringify(command)}\n`);
    out.write(`# started ${new Date(startedAt).toISOString()}\n\n`);

    // detached: true so the child survives a renderer reload. We do NOT
    // call child.unref() — main is the watcher of last resort and needs
    // the close event to flip status to 'done'/'failed'.
    const child = spawn(
      'claude',
      ['--bg', '--exec', command],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // PATH inheritance is fine — same posture as the existing
        // ClaudeCliLauncher: we trust whatever `claude` is on PATH.
        env: process.env,
      },
    );
    run.child = child;
    run.pid = child.pid;
    run.status = 'running';

    const onChunk = (chunk: Buffer): void => {
      const remaining = Math.max(0, MAX_LOG_BYTES - run.written);
      if (remaining === 0) {
        if (!run.capped) {
          run.capped = true;
          try {
            out.write(`\n# [log capped at ${MAX_LOG_BYTES} bytes]\n`);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      try {
        out.write(slice);
        run.written += slice.length;
      } catch (err) {
        logger.warn(`bg run ${runId} write failed: ${(err as Error).message}`);
      }
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (err) => {
      run.status = 'failed';
      run.endedAt = Date.now();
      try {
        out.write(`\n# spawn error: ${err.message}\n`);
      } catch {
        /* ignore */
      }
      try {
        out.end();
      } catch {
        /* ignore */
      }
    });

    child.on('close', (code) => {
      run.exitCode = code;
      run.status = code === 0 ? 'done' : 'failed';
      run.endedAt = Date.now();
      try {
        out.write(`\n# exited ${code}\n`);
      } catch {
        /* ignore */
      }
      try {
        out.end();
      } catch {
        /* ignore */
      }
    });
  } catch (err) {
    run.status = 'failed';
    run.endedAt = Date.now();
    logger.warn(`spawn threw: ${(err as Error).message}`);
  }

  return publicMeta(run);
}

export function listBackgroundRuns(): BackgroundRunMeta[] {
  // Stable order — newest first so the UI shows recent runs at top.
  return Array.from(RUNS.values())
    .map(publicMeta)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Tail the log for a run. `offset` is a byte offset into the file —
 * passing the previous `logBytes` produces a delta read. Bounded by
 * MAX_TAIL_BYTES so a renderer that requests too much can't OOM the
 * main process.
 */
const MAX_TAIL_BYTES = 256 * 1024;
export async function readBackgroundRunLog(
  runId: string,
  offset = 0,
): Promise<{ text: string; bytes: number; status: BackgroundRunStatus }> {
  const run = RUNS.get(runId);
  if (!run) throw new Error(`unknown run: ${runId}`);
  try {
    const fd = await fs.promises.open(run.logPath, 'r');
    try {
      const st = await fd.stat();
      const start = Math.max(0, Math.min(offset, st.size));
      const length = Math.min(MAX_TAIL_BYTES, Math.max(0, st.size - start));
      const buf = Buffer.alloc(length);
      if (length > 0) {
        await fd.read(buf, 0, length, start);
      }
      return {
        text: buf.toString('utf8'),
        bytes: st.size,
        status: run.status,
      };
    } finally {
      await fd.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { text: '', bytes: 0, status: run.status };
    }
    throw err;
  }
}

export function killBackgroundRun(runId: string): boolean {
  const run = RUNS.get(runId);
  if (!run?.child) return false;
  // SIGTERM first; the child handler in node-pty / claude flushes
  // stdout before exiting. We don't follow with SIGKILL — orphaned
  // background runs are rarer than the false-positive double-kill case.
  try {
    run.child.kill('SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// Test-only — clear the runs map so each test starts clean.
export function __resetBgRunnerForTests(): void {
  for (const run of RUNS.values()) {
    try {
      run.out?.end();
    } catch {
      /* ignore */
    }
    try {
      run.child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  RUNS.clear();
}
