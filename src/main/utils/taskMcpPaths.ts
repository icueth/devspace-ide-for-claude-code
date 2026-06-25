import * as path from 'node:path';

import { app } from 'electron';

// The bundled task MCP server script. Packaged builds read from
// process.resourcesPath (mapped via electron-builder `extraResources`); dev
// reads from <appPath>/resources. Mirrors designResourcePaths.ts. The script
// must be a real on-disk file (extraResources puts it OUTSIDE app.asar) because
// the claude CLI spawns it as a separate process.
export function taskMcpServerPath(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'task-mcp')
    : path.join(app.getAppPath(), 'resources', 'task-mcp');
  return path.join(base, 'server.mjs');
}
