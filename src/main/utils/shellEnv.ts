/**
 * Interactive shell environment resolver.
 *
 * Spawns the user's login/interactive shell to read its exported environment
 * (PATH, NVM, Homebrew locations, etc.) so tools like `claude` are reachable
 * when devspace is launched from Finder, not just from a terminal.
 *
 * Ported from claude_agent_teams_ui, adapted to drop internal deps.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

import { createLogger } from '@shared/logger';

const logger = createLogger('Utils:shellEnv');

const SHELL_ENV_TIMEOUT_MS = 12_000;

let cachedInteractiveShellEnv: NodeJS.ProcessEnv | null = null;
let shellEnvResolvePromise: Promise<NodeJS.ProcessEnv> | null = null;

function parseNullSeparatedEnv(content: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  const lines = content.split('\0');
  for (const line of lines) {
    if (!line) continue;
    const sep = line.indexOf('=');
    if (sep <= 0) continue;
    parsed[line.slice(0, sep)] = line.slice(sep + 1);
  }
  return parsed;
}

async function readShellEnv(shellPath: string, args: string[]): Promise<NodeJS.ProcessEnv> {
  const envDump = await new Promise<string>((resolve, reject) => {
    const child = spawn(shellPath, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
      timeoutHandle = null;
      child.kill();
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 3000);
      if (!settled) {
        settled = true;
        reject(new Error('shell env resolve timeout'));
      }
    }, SHELL_ENV_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', (err) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once('close', () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
  });
  return parseNullSeparatedEnv(envDump);
}

/**
 * Resolve the user's interactive shell environment. Cached for the process lifetime.
 * Tries `-lic` (login+interactive) first, falls back to `-ic`.
 * Returns `{}` on Windows.
 */
export async function resolveInteractiveShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedInteractiveShellEnv) return cachedInteractiveShellEnv;
  if (shellEnvResolvePromise) return shellEnvResolvePromise;

  if (process.platform === 'win32') {
    cachedInteractiveShellEnv = {};
    return cachedInteractiveShellEnv;
  }

  shellEnvResolvePromise = (async () => {
    const shellPath = process.env.SHELL || '/bin/zsh';
    try {
      const loginEnv = await readShellEnv(shellPath, ['-lic', 'env -0']);
      cachedInteractiveShellEnv = loginEnv;
      return loginEnv;
    } catch (loginError) {
      logger.warn(`login shell env failed: ${(loginError as Error).message}`);
      try {
        const interactiveEnv = await readShellEnv(shellPath, ['-ic', 'env -0']);
        cachedInteractiveShellEnv = interactiveEnv;
        return interactiveEnv;
      } catch (interactiveError) {
        logger.warn(`interactive shell env failed: ${(interactiveError as Error).message}`);
        return {};
      }
    } finally {
      shellEnvResolvePromise = null;
    }
  })();

  return shellEnvResolvePromise;
}

export function clearShellEnvCache(): void {
  cachedInteractiveShellEnv = null;
  shellEnvResolvePromise = null;
}

export function getCachedShellEnv(): NodeJS.ProcessEnv | null {
  return cachedInteractiveShellEnv;
}

/** HOME from the resolved shell env, falling back to Node's homedir. */
export function getShellPreferredHome(): string {
  const fromShell = getCachedShellEnv()?.HOME?.trim();
  return fromShell || os.homedir();
}
