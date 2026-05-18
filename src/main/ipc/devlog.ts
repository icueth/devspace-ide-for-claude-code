// IPC registration for the devlog subsystem (v0.24.0). Mirrors the
// memory IPC pattern: each handler validates input shape, gates
// projectPath through assertInWorkspace, then calls the
// DevlogService function. Errors are surfaced via electron's invoke
// rejection (callers in renderer/lib/api.ts wrap with `await`).
//
// The DEVLOG_EVENTS channel is the broadcast for DevlogEvent. We
// register the subscriber lazily on the first IPC call per
// webContents — same trick as MemoryService — and tear it down on
// the renderer's `destroyed` event so we never leak listeners on
// HMR / project switch.

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import {
  appendDailyLog,
  buildInjectPreamble,
  createEntry,
  deleteEntry,
  getEntry,
  getSettings,
  init as initDevlog,
  listEntries,
  openDir,
  pruneByRetention,
  setSettings,
  subscribeEvents,
  updateEntry,
} from '@main/services/DevlogService';
import { assertInWorkspace } from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  DevlogEntryType,
  DevlogEvent,
  DevlogPlanStatus,
  DevlogSettings,
  DevlogVerdict,
} from '@shared/types';

const logger = createLogger('DevlogIpc');

// One subscriber unsub per webContents; cleaned on `destroyed`.
const subscribers = new WeakMap<WebContents, () => void>();

function setupSubscriber(event: IpcMainInvokeEvent): void {
  const wc = event.sender;
  if (subscribers.has(wc)) return;
  const unsub = subscribeEvents((ev: DevlogEvent) => {
    if (!wc.isDestroyed()) {
      wc.send(IPC.DEVLOG_EVENTS, ev);
    }
  });
  subscribers.set(wc, unsub);
  wc.once('destroyed', () => {
    const fn = subscribers.get(wc);
    if (fn) {
      try {
        fn();
      } catch (err) {
        logger.warn(`unsub on destroy threw: ${(err as Error).message}`);
      }
    }
    subscribers.delete(wc);
  });
}

// ─── argument coercers ─────────────────────────────────────────────────────

function asString(x: unknown): string {
  if (typeof x !== 'string') throw new Error('expected string argument');
  return x;
}

function asOptString(x: unknown): string | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== 'string') throw new Error('expected string argument');
  return x;
}

function asType(x: unknown): DevlogEntryType {
  if (x !== 'plan' && x !== 'agent' && x !== 'result' && x !== 'log') {
    throw new Error(`invalid devlog type: ${String(x)}`);
  }
  return x;
}

function asOptType(x: unknown): DevlogEntryType | undefined {
  if (x === undefined || x === null) return undefined;
  return asType(x);
}

function asStatus(x: unknown): DevlogPlanStatus | undefined {
  if (x === undefined || x === null) return undefined;
  if (x !== 'in_progress' && x !== 'done' && x !== 'abandoned') {
    throw new Error(`invalid status: ${String(x)}`);
  }
  return x;
}

function asVerdict(x: unknown): DevlogVerdict | undefined {
  if (x === undefined || x === null) return undefined;
  if (x !== 'success' && x !== 'partial' && x !== 'failed') {
    throw new Error(`invalid verdict: ${String(x)}`);
  }
  return x;
}

async function gateProjectPath(p: unknown): Promise<string> {
  return assertInWorkspace(asString(p));
}

export function registerDevlogIpc(): void {
  // Warm the defaults file cache. If the read fails, subsequent
  // per-handler calls re-attempt — init() is idempotent.
  initDevlog().catch((err) => {
    logger.warn(`devlog init failed: ${(err as Error).message}`);
  });

  ipcMain.handle(
    IPC.DEVLOG_LIST,
    async (event, input: { projectPath: unknown; type?: unknown }) => {
      setupSubscriber(event);
      return listEntries({
        projectPath: await gateProjectPath(input?.projectPath),
        type: asOptType(input?.type),
      });
    },
  );

  ipcMain.handle(
    IPC.DEVLOG_GET,
    async (event, input: { projectPath: unknown; entryId: unknown }) => {
      setupSubscriber(event);
      return getEntry({
        projectPath: await gateProjectPath(input?.projectPath),
        entryId: asString(input?.entryId),
      });
    },
  );

  ipcMain.handle(
    IPC.DEVLOG_CREATE,
    async (event, input: {
      projectPath: unknown;
      type: unknown;
      title: unknown;
      body: unknown;
      status?: unknown;
      verdict?: unknown;
      subagentType?: unknown;
      version?: unknown;
      threadId?: unknown;
      toolUseId?: unknown;
    }) => {
      setupSubscriber(event);
      return createEntry({
        projectPath: await gateProjectPath(input?.projectPath),
        type: asType(input?.type),
        title: asString(input?.title),
        body: typeof input?.body === 'string' ? input.body : '',
        status: asStatus(input?.status),
        verdict: asVerdict(input?.verdict),
        subagentType: asOptString(input?.subagentType),
        version: asOptString(input?.version),
        threadId: asOptString(input?.threadId),
        toolUseId: asOptString(input?.toolUseId),
      });
    },
  );

  ipcMain.handle(
    IPC.DEVLOG_UPDATE,
    async (event, input: {
      projectPath: unknown;
      entryId: unknown;
      title?: unknown;
      body?: unknown;
      status?: unknown;
    }) => {
      setupSubscriber(event);
      return updateEntry({
        projectPath: await gateProjectPath(input?.projectPath),
        entryId: asString(input?.entryId),
        title: asOptString(input?.title),
        body: asOptString(input?.body),
        status: asStatus(input?.status),
      });
    },
  );

  ipcMain.handle(
    IPC.DEVLOG_DELETE,
    async (event, input: { projectPath: unknown; entryId: unknown }) => {
      setupSubscriber(event);
      return deleteEntry({
        projectPath: await gateProjectPath(input?.projectPath),
        entryId: asString(input?.entryId),
      });
    },
  );

  ipcMain.handle(
    IPC.DEVLOG_APPEND_LOG,
    async (event, input: { projectPath: unknown; text: unknown }) => {
      setupSubscriber(event);
      return appendDailyLog({
        projectPath: await gateProjectPath(input?.projectPath),
        text: asString(input?.text),
      });
    },
  );

  ipcMain.handle(
    IPC.DEVLOG_BUILD_INJECT,
    async (event, projectPath: unknown) => {
      setupSubscriber(event);
      // buildInjectPreamble must never throw — defensively gate the
      // projectPath but swallow gate failures too so chat finalize can't
      // wedge on an invalid workspace.
      try {
        const p = await gateProjectPath(projectPath);
        return await buildInjectPreamble(p);
      } catch (err) {
        logger.warn(
          `buildInjectPreamble denied for ${String(projectPath)}: ${(err as Error).message}`,
        );
        return '';
      }
    },
  );

  ipcMain.handle(IPC.DEVLOG_GET_SETTINGS, (event) => {
    setupSubscriber(event);
    return getSettings();
  });

  ipcMain.handle(
    IPC.DEVLOG_SET_SETTINGS,
    (event, patch: Partial<DevlogSettings>) => {
      setupSubscriber(event);
      return setSettings(patch ?? {});
    },
  );

  ipcMain.handle(
    IPC.DEVLOG_OPEN_DIR,
    async (event, projectPath: unknown) => {
      setupSubscriber(event);
      return openDir(await gateProjectPath(projectPath));
    },
  );

  // Internal helper — not in the renderer surface but useful for ops:
  // the chat boot path may call pruneByRetention on first inject. Kept
  // here so callers don't have to import the service directly.
  void pruneByRetention;
}
