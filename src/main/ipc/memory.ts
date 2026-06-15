// IPC registration for the memory subsystem (v0.19.0). Mirrors the
// design.ts pattern: each handler validates input shape, calls the
// MemoryService function, and maps thrown errors back to renderer-
// friendly strings. The MEMORY_EVENTS channel is the broadcast hook for
// MemoryEvent — subscribers are added lazily on first IPC call from a
// renderer so the dashboard / inbox / inject preamble paths all share
// one event stream.

import { ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import { distill } from '@main/services/DistillationService';
import { assertInWorkspace } from '@main/utils/pathScope';
import {
  buildInjectPreamble,
  buildRecallContext,
  createEntry,
  deleteEntry,
  dismissInbox,
  getDiary,
  getEntry,
  getSettings,
  getStats,
  init as initMemory,
  listDiary,
  listEntries,
  listInbox,
  listProjects,
  openDir,
  proposeFromTurn,
  pruneGhostProjects,
  resolveInbox,
  search,
  setSettings,
  subscribe as subscribeWebContents,
  togglePin,
  updateEntry,
  writeDiary,
} from '@main/services/MemoryService';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  MemoryScope,
  MemorySettings,
  MemoryType,
} from '@shared/types';

const logger = createLogger('MemoryIpc');

// Renderer-supplied projectPath must resolve under an OPEN workspace.
// Per-scope: throws if the renderer hands us an arbitrary absolute path
// outside any project the user has added. Returns the resolved path on
// success so callers can use the canonicalized form. Pass-through when
// projectPath is null/undefined (callers handle global scope themselves).
async function gateProjectPath(p: string | undefined | null): Promise<string | undefined> {
  if (!p) return undefined;
  return assertInWorkspace(p);
}

// Wire a webContents into the broadcast subscriber set on the first IPC
// call from that renderer. Same single-shot pattern as ChatTranscript:
// the destroy hook tears down membership, so we never leak listeners on
// HMR / project switch.
function setupSubscriber(event: IpcMainInvokeEvent): void {
  subscribeWebContents(event.sender);
}

// Type-narrowing helpers — IPC arguments arrive as `unknown` from a
// hostile renderer perspective, so we re-validate each payload before
// handing it to the service.
function asString(x: unknown): string {
  if (typeof x !== 'string') throw new Error('expected string argument');
  return x;
}

function asOptString(x: unknown): string | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== 'string') throw new Error('expected string argument');
  return x;
}

function asScope(x: unknown): MemoryScope {
  if (x !== 'project' && x !== 'global') {
    throw new Error(`invalid scope: ${String(x)}`);
  }
  return x;
}

function asType(x: unknown): MemoryType {
  if (
    x !== 'user' &&
    x !== 'feedback' &&
    x !== 'project' &&
    x !== 'reference' &&
    x !== 'lesson' &&
    x !== 'workflow'
  ) {
    throw new Error(`invalid type: ${String(x)}`);
  }
  return x;
}

function asOptType(x: unknown): MemoryType | undefined {
  if (x === undefined || x === null) return undefined;
  return asType(x);
}

function asStringArrayOpt(x: unknown): string[] | undefined {
  if (x === undefined || x === null) return undefined;
  if (!Array.isArray(x)) throw new Error('expected array of strings');
  return x.filter((s): s is string => typeof s === 'string');
}

export function registerMemoryIpc(): void {
  // Kick off init in the background. Handlers each call ensureInit()
  // internally so this is purely a warm-up; if it fails, the per-handler
  // call will surface the error.
  initMemory().catch((err) => {
    logger.warn(`memory init failed: ${(err as Error).message}`);
  });

  ipcMain.handle(IPC.MEMORY_LIST_PROJECTS, (event) => {
    setupSubscriber(event);
    return listProjects();
  });

  ipcMain.handle(IPC.MEMORY_PRUNE_GHOSTS, (event) => {
    setupSubscriber(event);
    return pruneGhostProjects();
  });

  ipcMain.handle(
    IPC.MEMORY_LIST_ENTRIES,
    async (event, input: {
      scope: unknown;
      projectPath?: unknown;
      type?: unknown;
      pinnedOnly?: unknown;
    }) => {
      setupSubscriber(event);
      return listEntries({
        scope: asScope(input?.scope),
        projectPath: await gateProjectPath(asOptString(input?.projectPath)),
        type: asOptType(input?.type),
        pinnedOnly: input?.pinnedOnly === true,
      });
    },
  );

  ipcMain.handle(IPC.MEMORY_GET_ENTRY, (event, id: unknown) => {
    setupSubscriber(event);
    return getEntry(asString(id));
  });

  ipcMain.handle(
    IPC.MEMORY_CREATE_ENTRY,
    async (event, input: {
      scope: unknown;
      projectPath?: unknown;
      type: unknown;
      slug?: unknown;
      description: unknown;
      body: unknown;
      tags?: unknown;
    }) => {
      setupSubscriber(event);
      return createEntry({
        scope: asScope(input?.scope),
        projectPath: await gateProjectPath(asOptString(input?.projectPath)),
        type: asType(input?.type),
        slug: asOptString(input?.slug),
        description: asString(input?.description),
        body: typeof input?.body === 'string' ? input.body : '',
        tags: asStringArrayOpt(input?.tags),
      });
    },
  );

  ipcMain.handle(
    IPC.MEMORY_UPDATE_ENTRY,
    (event, input: {
      id: unknown;
      description?: unknown;
      body?: unknown;
      tags?: unknown;
    }) => {
      setupSubscriber(event);
      return updateEntry({
        id: asString(input?.id),
        description: asOptString(input?.description),
        body: asOptString(input?.body),
        tags: asStringArrayOpt(input?.tags),
      });
    },
  );

  ipcMain.handle(IPC.MEMORY_DELETE_ENTRY, (event, id: unknown) => {
    setupSubscriber(event);
    return deleteEntry(asString(id));
  });

  ipcMain.handle(IPC.MEMORY_TOGGLE_PIN, (event, id: unknown) => {
    setupSubscriber(event);
    return togglePin(asString(id));
  });

  ipcMain.handle(
    IPC.MEMORY_SEARCH,
    async (event, input: {
      query: unknown;
      scope?: unknown;
      projectPath?: unknown;
      types?: unknown;
      tags?: unknown;
      limit?: unknown;
    }) => {
      setupSubscriber(event);
      const types = Array.isArray(input?.types)
        ? input.types
            .filter((t): t is string => typeof t === 'string')
            .map(asType)
        : undefined;
      const limit =
        typeof input?.limit === 'number' && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(100, Math.floor(input.limit)))
          : undefined;
      return search({
        query: asString(input?.query),
        scope:
          input?.scope === 'project' || input?.scope === 'global'
            ? input.scope
            : undefined,
        projectPath: await gateProjectPath(asOptString(input?.projectPath)),
        types,
        tags: asStringArrayOpt(input?.tags),
        limit,
      });
    },
  );

  ipcMain.handle(IPC.MEMORY_GET_STATS, (event) => {
    setupSubscriber(event);
    return getStats();
  });

  ipcMain.handle(
    IPC.MEMORY_LIST_INBOX,
    async (event, projectPath: unknown) => {
      setupSubscriber(event);
      return listInbox(await gateProjectPath(asOptString(projectPath)));
    },
  );

  ipcMain.handle(
    IPC.MEMORY_RESOLVE_INBOX,
    (event, input: {
      inboxId: unknown;
      type: unknown;
      slug?: unknown;
      description?: unknown;
      body?: unknown;
    }) => {
      setupSubscriber(event);
      return resolveInbox({
        inboxId: asString(input?.inboxId),
        type: asType(input?.type),
        slug: asOptString(input?.slug),
        description: asOptString(input?.description),
        body: asOptString(input?.body),
      });
    },
  );

  ipcMain.handle(IPC.MEMORY_DISMISS_INBOX, (event, inboxId: unknown) => {
    setupSubscriber(event);
    return dismissInbox(asString(inboxId));
  });

  ipcMain.handle(
    IPC.MEMORY_PROPOSE_FROM_TURN,
    async (event, input: {
      projectPath: unknown;
      threadId: unknown;
      userMessage: unknown;
      assistantMessage: unknown;
    }) => {
      setupSubscriber(event);
      return proposeFromTurn({
        projectPath: await assertInWorkspace(asString(input?.projectPath)),
        threadId: asString(input?.threadId),
        userMessage: asString(input?.userMessage),
        assistantMessage: asString(input?.assistantMessage),
      });
    },
  );

  ipcMain.handle(
    IPC.MEMORY_LIST_DIARY,
    async (event, input: {
      scope: unknown;
      projectPath?: unknown;
      from?: unknown;
      to?: unknown;
    }) => {
      setupSubscriber(event);
      return listDiary({
        scope: asScope(input?.scope),
        projectPath: await gateProjectPath(asOptString(input?.projectPath)),
        from: asOptString(input?.from),
        to: asOptString(input?.to),
      });
    },
  );

  ipcMain.handle(
    IPC.MEMORY_GET_DIARY,
    async (event, date: unknown, projectPath: unknown) => {
      setupSubscriber(event);
      return getDiary(asString(date), await gateProjectPath(asOptString(projectPath)));
    },
  );

  ipcMain.handle(
    IPC.MEMORY_WRITE_DIARY,
    async (event, input: {
      date: unknown;
      scope: unknown;
      projectPath?: unknown;
      body: unknown;
    }) => {
      setupSubscriber(event);
      return writeDiary({
        date: asString(input?.date),
        scope: asScope(input?.scope),
        projectPath: await gateProjectPath(asOptString(input?.projectPath)),
        body: typeof input?.body === 'string' ? input.body : '',
      });
    },
  );

  ipcMain.handle(
    IPC.MEMORY_BUILD_RECALL_CONTEXT,
    async (event, input: { query: unknown; projectPath?: unknown; limit?: unknown }) => {
      setupSubscriber(event);
      const limit =
        typeof input?.limit === 'number' && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(10, Math.floor(input.limit)))
          : undefined;
      return buildRecallContext({
        query: asString(input?.query),
        projectPath: await gateProjectPath(asOptString(input?.projectPath)),
        limit,
      });
    },
  );

  ipcMain.handle(
    IPC.MEMORY_BUILD_INJECT_PREAMBLE,
    async (event, projectPath: unknown) => {
      setupSubscriber(event);
      return buildInjectPreamble(await assertInWorkspace(asString(projectPath)));
    },
  );

  ipcMain.handle(
    IPC.MEMORY_DISTILL,
    async (event, projectPath: unknown) => {
      setupSubscriber(event);
      // distill() never throws — it returns a DistillSummary with a status —
      // so we can surface the result directly to the renderer.
      return distill(await assertInWorkspace(asString(projectPath)));
    },
  );

  ipcMain.handle(IPC.MEMORY_GET_SETTINGS, (event) => {
    setupSubscriber(event);
    return getSettings();
  });

  ipcMain.handle(
    IPC.MEMORY_SET_SETTINGS,
    (event, patch: Partial<MemorySettings>) => {
      setupSubscriber(event);
      return setSettings(patch ?? {});
    },
  );

  ipcMain.handle(
    IPC.MEMORY_OPEN_DIR,
    async (event, scope: unknown, projectPath: unknown) => {
      setupSubscriber(event);
      const { path: dir } = await openDir(
        asScope(scope),
        await gateProjectPath(asOptString(projectPath)),
      );
      // Opening the dir in the OS file manager mirrors the codeflow
      // openDir handler — best-effort, errors only surface in logs.
      try {
        await shell.openPath(dir);
      } catch (err) {
        logger.warn(`openPath failed for ${dir}: ${(err as Error).message}`);
      }
      // Renderer contract is Promise<void> — `dir` is internal only.
    },
  );
}
