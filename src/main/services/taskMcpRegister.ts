import * as os from 'node:os';
import * as path from 'node:path';

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
      },
    };

    // Upsert: only rewrite when absent or when the command path drifted (e.g.
    // dev electron → packaged app), so we self-heal without churning the file.
    const existing = (await listMcpServers(projectPath)).find(
      (e) => e.name === SERVER_NAME,
    );
    const prevCmd =
      existing?.server.transport === 'stdio' ? existing.server.command : undefined;
    if (existing && prevCmd === server.command) return;
    if (existing) await deleteMcpServer('project', existing.filePath, SERVER_NAME);
    await createMcpServer('project', projectPath, SERVER_NAME, server);
  } catch (e) {
    // Best-effort — a registration failure must never block opening a CLI tab.
    console.error('[tasks] mcp auto-register failed:', (e as Error).message);
  }
}
