import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { enrichedPath } from '@main/utils/setupPaths';
import { createLogger } from '@shared/logger';
import type {
  RufloInitProgressEvent,
  RufloInitResult,
  RufloInitStage,
  RufloProjectStatus,
} from '@shared/ruflo';

const logger = createLogger('Ruflo');

// ---------------------------------------------------------------------------
// Subscriber list — matches SetupService's emit pattern but uses a plain
// callback API (IPC layer wires renderer broadcast). Lets tests subscribe
// without an Electron WebContents.
// ---------------------------------------------------------------------------

type ProgressListener = (ev: RufloInitProgressEvent) => void;
const listeners = new Set<ProgressListener>();

export function subscribeInitProgress(cb: ProgressListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(ev: RufloInitProgressEvent): void {
  for (const cb of listeners) {
    try {
      cb(ev);
    } catch (err) {
      logger.warn(`progress listener threw: ${(err as Error).message}`);
    }
  }
}

function step(
  projectPath: string,
  stage: RufloInitStage,
  message: string,
): void {
  logger.info(`[${stage}] ${message}`);
  emit({ projectPath, stage, message, done: false });
}

// ---------------------------------------------------------------------------
// Global init lock + child tracking so before-quit can SIGTERM any in-flight
// ruflo child. One init at a time across ALL projects (npm cache + npx
// download contention makes parallel runs unreliable).
// ---------------------------------------------------------------------------

let initInFlight = false;
let activeChild: ChildProcess | null = null;

function killActiveChild(): void {
  const child = activeChild;
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* best-effort */
  }
}

// Attach once: ensures the npx process doesn't outlive the app on quit.
// Same shape as DevServerService's cleanup — process.on instead of
// app.on('before-quit') so the service stays Electron-free for tests.
let cleanupAttached = false;
function attachExitCleanup(): void {
  if (cleanupAttached) return;
  cleanupAttached = true;
  process.on('exit', killActiveChild);
}

async function whichBin(name: string): Promise<string | null> {
  // Walk PATH (enriched with common bin dirs) the same way SetupService does.
  // Avoiding `which` keeps detection deterministic across login-shell flavors.
  const segments = enrichedPath().split(':').filter(Boolean);
  for (const dir of segments) {
    const full = path.join(dir, name);
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

// ---------------------------------------------------------------------------
// Detection — pure read, never spawns.
// ---------------------------------------------------------------------------

export async function getProjectStatus(
  projectPath: string,
): Promise<RufloProjectStatus> {
  if (!projectPath || typeof projectPath !== 'string') {
    return { projectPath: projectPath ?? '', initialized: false };
  }
  const configDir = path.join(projectPath, '.claude-flow');
  const claudeMd = path.join(projectPath, 'CLAUDE.md');
  const claudeDir = path.join(projectPath, '.claude');

  // fs.existsSync is sync but cheap (3 stats); avoiding async/await here keeps
  // sidebar refreshes snappy when the user switches projects.
  const initialized = fs.existsSync(configDir);
  const hasClaudeMd = fs.existsSync(claudeMd);
  const hasClaudeDir = fs.existsSync(claudeDir);

  return {
    projectPath,
    initialized,
    configDir: initialized ? configDir : undefined,
    hasClaudeMd,
    hasClaudeDir,
  };
}

// ---------------------------------------------------------------------------
// Init — spawn `npx ruflo@latest init`, stream output, return status.
// ---------------------------------------------------------------------------

export async function initProject(
  projectPath: string,
): Promise<RufloInitResult> {
  if (!projectPath || typeof projectPath !== 'string') {
    return {
      ok: false,
      status: { projectPath: projectPath ?? '', initialized: false },
      error: 'projectPath required',
    };
  }
  if (initInFlight) {
    return {
      ok: false,
      status: await getProjectStatus(projectPath),
      error: 'Another Ruflo init is running',
    };
  }
  initInFlight = true;
  attachExitCleanup();

  const finish = async (
    stage: RufloInitStage,
    message: string,
    error?: string,
  ): Promise<RufloInitResult> => {
    const status = await getProjectStatus(projectPath);
    emit({ projectPath, stage, message, done: true, error });
    return { ok: stage === 'done', status, error };
  };

  try {
    step(projectPath, 'preflight', `Starting Ruflo init in ${projectPath}…`);

    // Project must exist before spawning npx — otherwise the child errors with
    // an opaque "no such file or directory" that's hard to surface in the UI.
    try {
      const st = await fsp.stat(projectPath);
      if (!st.isDirectory()) {
        return await finish(
          'error',
          `Not a directory: ${projectPath}`,
          'projectPath is not a directory',
        );
      }
    } catch {
      return await finish(
        'error',
        `Project path does not exist: ${projectPath}`,
        'projectPath does not exist',
      );
    }

    const npxBin = await whichBin('npx');
    if (!npxBin) {
      return await finish(
        'error',
        'Node.js / npm required (npx not found on PATH).',
        'Node.js / npm required',
      );
    }

    step(projectPath, 'install', `${npxBin} ruflo@latest init`);

    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(npxBin, ['ruflo@latest', 'init'], {
        cwd: projectPath,
        env: { ...process.env, PATH: enrichedPath() },
      });
      activeChild = child;

      const forward = (chunk: Buffer | string): void => {
        const text = String(chunk).trimEnd();
        if (!text) return;
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          emit({
            projectPath,
            stage: 'install',
            message: line,
            done: false,
          });
        }
      };
      child.stdout?.on('data', forward);
      child.stderr?.on('data', forward);
      child.on('error', (err) => {
        activeChild = null;
        reject(err);
      });
      child.on('exit', (c) => {
        activeChild = null;
        resolve(c ?? -1);
      });
    });

    if (code !== 0) {
      return await finish(
        'error',
        `npx ruflo init exited ${code}`,
        `npx ruflo init exited ${code}`,
      );
    }

    step(projectPath, 'verify', 'Verifying .claude-flow/…');
    const status = await getProjectStatus(projectPath);
    if (!status.initialized) {
      return await finish(
        'error',
        'Ruflo finished but .claude-flow/ was not created.',
        '.claude-flow/ missing after init',
      );
    }
    return await finish('done', 'Ruflo initialized.');
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`init failed: ${message}`);
    return await finish('error', message, message);
  } finally {
    activeChild = null;
    initInFlight = false;
  }
}

/** Test-only: reset module-level lock between vitest cases. */
export function __resetForTests(): void {
  killActiveChild();
  activeChild = null;
  initInFlight = false;
  listeners.clear();
}
