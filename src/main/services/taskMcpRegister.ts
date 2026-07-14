import * as os from 'node:os';
import * as path from 'node:path';

import { flowControlSocketPath } from '@main/services/flowControl';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
} from '@main/services/McpService';
import { taskControlSocketPath } from '@main/services/taskControl';
import { taskMcpServerPath } from '@main/utils/taskMcpPaths';
import type { McpStdioServer } from '@shared/types';

const SERVER_NAME = 'devspace-tasks';

function worktreesRoot(): string {
  return path.join(os.homedir(), '.devspace', 'worktrees') + path.sep;
}

// Ensure the main-chat claude rooted at `projectPath` can fork tasks by tool
// call: upsert a stdio MCP server entry into <projectPath>/.mcp.json that spawns
// the bundled task MCP server via electron-as-node (no external node needed).
//
// Recursion guard (structural): task agents run with cwd under
// ~/.devspace/worktrees, so we skip those — a task's own agent never gets the
// create-task tool, and can't spawn an unbounded tree of sub-tasks.
export async function ensureTaskMcpRegistered(projectPath: string): Promise<void> {
  try {
    if (!projectPath || (projectPath + path.sep).startsWith(worktreesRoot())) {
      return;
    }
    const server: McpStdioServer = {
      transport: 'stdio',
      command: process.execPath,
      args: [taskMcpServerPath()],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DEVSPACE_PROJECT_PATH: projectPath,
        DEVSPACE_TASK_SOCK: taskControlSocketPath(),
        // Agent Flow's own socket — same bundled server, second subsystem.
        DEVSPACE_FLOW_SOCK: flowControlSocketPath(),
      },
    };

    // Upsert: rewrite when absent, when the command path drifted (dev electron →
    // packaged app), or when the injected env drifted — the env check is what
    // migrates the entries written before a new socket was added, which would
    // otherwise keep spawning the server without it (the flow tools would then
    // silently talk to a default path that may not be where DevSpace listens).
    const existing = (await listMcpServers(projectPath)).find(
      (e) => e.name === SERVER_NAME,
    );
    const prev = existing?.server.transport === 'stdio' ? existing.server : undefined;
    const envMatches =
      !!prev &&
      Object.entries(server.env ?? {}).every(([k, v]) => prev.env?.[k] === v);
    if (existing && prev?.command === server.command && envMatches) return;
    if (existing) await deleteMcpServer('project', existing.filePath, SERVER_NAME);
    await createMcpServer('project', projectPath, SERVER_NAME, server);
  } catch (e) {
    // Best-effort — a registration failure must never block opening a CLI tab.
    console.error('[tasks] mcp auto-register failed:', (e as Error).message);
  }
}
