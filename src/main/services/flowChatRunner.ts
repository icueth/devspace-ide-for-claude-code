// Agent Flow — one lead-chat turn.
//
// The lead is a plain `claude --print` invocation via TmuxChatRunner (the same
// detached-tmux runner the main chat and Forge use): the user's normal login,
// NEVER the Agent SDK and NEVER `--bg` (which returns a stub and no model
// output — see DistillationService.ts:22-28).
//
// One turn = one process. Continuity is prompt-stuffing (FlowChatService hands
// us the whole conversation), which is the codebase's proven pattern — and the
// reason StartRunOptions.prompt is documented as "full conversation history +
// tail instruction". No --resume.
//
// MCP: the lead MUST see the flow tools (list_flows / run_flow / flow_status /
// send_flow / stop_flow), and the project's own .mcp.json cannot deliver them —
// it is approval-gated and its `command` points at a packaged app path. So we
// generate a fresh config with the dev-correct electron-as-node command and pass
// it explicitly as --mcp-config. Never --disallowed-tools (ForgeService's
// buildClaudeArgs strips tools; the lead is the opposite case).

import * as os from 'node:os';
import * as path from 'node:path';

import { resolveClaudeBinary } from '@main/services/ClaudeCliLauncher';
import { flowControlSocketPath } from '@main/services/flowControl';
import { projectIdForPath } from '@main/services/ProjectScanner';
import { taskControlSocketPath } from '@main/services/taskControl';
import { newRunId, startChatRun } from '@main/services/TmuxChatRunner';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';
import { taskMcpServerPath } from '@main/utils/taskMcpPaths';
import { createLogger } from '@shared/logger';

const logger = createLogger('FlowChatRunner');

// Wall-clock ceiling for one turn. TmuxChatRunner already force-resolves on a
// 10-minute *stream idle*; this is the second-line guard for a turn that keeps
// dribbling output forever (a tool loop) and would otherwise hold the lock.
const TURN_TIMEOUT_MS = 20 * 60_000;

export interface LeadTurnResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * The lead's MCP config: the bundled task/flow MCP server, spawned through
 * electron-as-node (no external node needed), with the sockets it relays to.
 * Written under ~/.devspace/flow-chat/<projectId>.json — projectId is the sha1
 * ProjectScanner derives from the path, so nothing user-typed lands in a
 * filename. Rewritten every turn: the socket paths and the app path can drift
 * (dev electron → packaged app) and a stale config silently loses the tools.
 */
export async function writeFlowChatMcpConfig(projectPath: string): Promise<string> {
  const file = path.join(
    os.homedir(),
    '.devspace',
    'flow-chat',
    `${projectIdForPath(projectPath)}.json`,
  );
  const config = {
    mcpServers: {
      'devspace-tasks': {
        type: 'stdio',
        command: process.execPath,
        args: [taskMcpServerPath()],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DEVSPACE_PROJECT_PATH: projectPath,
          DEVSPACE_TASK_SOCK: taskControlSocketPath(),
          DEVSPACE_FLOW_SOCK: flowControlSocketPath(),
        },
      },
    },
  };
  await atomicWriteAsync(file, JSON.stringify(config, null, 2));
  return file;
}

/**
 * Run one lead turn to completion. Never throws — every failure (no binary,
 * spawn error, non-zero exit, timeout) comes back as `{ ok: false, error }` so
 * the chat can render it as a readable error bubble instead of a dead panel.
 */
export async function runLeadTurn(
  projectPath: string,
  prompt: string,
): Promise<LeadTurnResult> {
  const claudeBin = await resolveClaudeBinary();
  if (!claudeBin) {
    return { ok: false, text: '', error: '`claude` was not found on your PATH.' };
  }

  let mcpConfig: string;
  try {
    mcpConfig = await writeFlowChatMcpConfig(projectPath);
  } catch (err) {
    return {
      ok: false,
      text: '',
      error: `could not write the lead's MCP config: ${(err as Error).message}`,
    };
  }

  const env = await resolveInteractiveShellEnv();
  // --print with no --output-format: claude writes PLAIN TEXT to stdout, so
  // out.jsonl is the reply itself and every line we collect is reply text.
  const args = ['--print', '--dangerously-skip-permissions', '--mcp-config', mcpConfig];

  const lines: string[] = [];
  let handle;
  try {
    handle = await startChatRun({
      projectId: projectIdForPath(projectPath),
      threadId: 'lead',
      runId: newRunId(),
      cwd: projectPath,
      claudeBin,
      args,
      env,
      prompt,
      onLine: (line) => lines.push(line),
      runRoot: path.join(projectPath, '.devspace', 'flows', 'chat'),
    });
  } catch (err) {
    return {
      ok: false,
      text: '',
      error: `failed to start claude: ${(err as Error).message}`,
    };
  }

  const timer = setTimeout(() => {
    logger.warn(`lead turn exceeded ${TURN_TIMEOUT_MS / 60_000}m — killing`);
    void handle.kill().catch(() => undefined);
  }, TURN_TIMEOUT_MS);
  timer.unref?.();

  try {
    const res = await handle.promise;
    const text = lines.join('\n').trim();
    if (res.cancelled) {
      return {
        ok: false,
        text,
        error: res.error ?? 'the lead turn was cancelled before it answered',
      };
    }
    if (res.exitCode !== 0) {
      return {
        ok: false,
        text,
        error: res.error ?? `claude exited ${res.exitCode ?? '?'}`,
      };
    }
    return { ok: true, text };
  } finally {
    clearTimeout(timer);
  }
}
