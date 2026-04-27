import { app } from 'electron';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/logger';
import type { Workspace } from '@shared/types';

const logger = createLogger('WorkspaceService');

interface StoreShape {
  version: 1;
  activeId: string | null;
  workspaces: Workspace[];
}

const EMPTY_STORE: StoreShape = { version: 1, activeId: null, workspaces: [] };

function storePath(): string {
  return path.join(app.getPath('userData'), 'workspaces.json');
}

function hashPath(absPath: string): string {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 12);
}

async function readStore(): Promise<StoreShape> {
  try {
    const buf = await fs.promises.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(buf) as Partial<StoreShape>;
    if (!parsed.workspaces) return { ...EMPTY_STORE };
    return {
      version: 1,
      activeId: parsed.activeId ?? null,
      workspaces: parsed.workspaces,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('workspaces.json read failed:', (err as Error).message);
    }
    return { ...EMPTY_STORE };
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  await atomicWriteAsync(storePath(), JSON.stringify(store, null, 2));
}

export async function listWorkspaces(): Promise<{
  active: Workspace | null;
  workspaces: Workspace[];
}> {
  const store = await readStore();
  const active = store.workspaces.find((w) => w.id === store.activeId) ?? null;
  const sorted = [...store.workspaces].sort((a, b) => b.lastOpened - a.lastOpened);
  return { active, workspaces: sorted };
}

export async function addWorkspace(absPath: string): Promise<Workspace> {
  const normalized = path.resolve(absPath);
  const store = await readStore();

  const existing = store.workspaces.find((w) => w.path === normalized);
  if (existing) {
    existing.lastOpened = Date.now();
    store.activeId = existing.id;
    await writeStore(store);
    return existing;
  }

  const workspace: Workspace = {
    id: hashPath(normalized),
    path: normalized,
    name: path.basename(normalized) || normalized,
    lastOpened: Date.now(),
  };
  store.workspaces.push(workspace);
  store.activeId = workspace.id;
  await writeStore(store);
  return workspace;
}

export async function setActiveWorkspace(id: string): Promise<Workspace | null> {
  const store = await readStore();
  const ws = store.workspaces.find((w) => w.id === id);
  if (!ws) return null;
  ws.lastOpened = Date.now();
  store.activeId = id;
  await writeStore(store);
  return ws;
}
