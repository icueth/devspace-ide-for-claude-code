// IPC registration for the forge subsystem (v0.24.0). Mirrors the
// devlog/memory IPC pattern: each handler validates input shape, gates
// projectPath through assertInWorkspace, then calls the ForgeService
// function. Errors surface via electron's invoke rejection.
//
// The FORGE_EVENTS channel is the broadcast for ForgeEvent. We register
// the subscriber lazily on the first IPC call per webContents and tear
// it down on `destroyed`. Several handlers (generateDraft / saveDraft /
// cancelDraft / deleteDraft / updateDraft / getDraft) receive only a
// draftId — the service walks open workspaces to find the owning
// project. Handlers with projectPath in the payload still gate via
// assertInWorkspace.

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import {
  cancelDraft,
  createDraft,
  deleteDraft,
  discoverMatches,
  dismissSuggestion,
  generateDraft,
  getDraft,
  getDraftById,
  getSettings,
  init as initForge,
  listCatalog,
  listDrafts,
  listStats,
  listSuggestions,
  listUses,
  recordSignal,
  recordUse,
  saveDraft,
  setSettings,
  subscribeEvents,
  updateDraft,
} from '@main/services/ForgeService';
import { assertInWorkspace } from '@main/utils/pathScope';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  ForgeEvent,
  ForgeKind,
  ForgeScope,
  ForgeSettings,
  ForgeSignal,
} from '@shared/types';

const logger = createLogger('ForgeIpc');

// One subscriber unsub per webContents; cleaned on `destroyed`.
const subscribers = new WeakMap<WebContents, () => void>();

function setupSubscriber(event: IpcMainInvokeEvent): void {
  const wc = event.sender;
  if (subscribers.has(wc)) return;
  const unsub = subscribeEvents((ev: ForgeEvent) => {
    if (!wc.isDestroyed()) {
      wc.send(IPC.FORGE_EVENTS, ev);
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

function asKind(x: unknown): ForgeKind {
  if (x !== 'skill' && x !== 'agent') {
    throw new Error(`invalid forge kind: ${String(x)}`);
  }
  return x;
}

function asScope(x: unknown): ForgeScope {
  if (x !== 'project' && x !== 'global') {
    throw new Error(`invalid forge scope: ${String(x)}`);
  }
  return x;
}

function asSignal(x: unknown): ForgeSignal {
  if (
    x !== 'thanks' &&
    x !== 'correction' &&
    x !== 'abandoned' &&
    x !== 'commit' &&
    x !== 'explicit-up' &&
    x !== 'explicit-down'
  ) {
    throw new Error(`invalid forge signal: ${String(x)}`);
  }
  return x;
}

async function gateProjectPath(p: unknown): Promise<string> {
  return assertInWorkspace(asString(p));
}

export function registerForgeIpc(): void {
  // Warm the defaults file cache.
  initForge().catch((err) => {
    logger.warn(`forge init failed: ${(err as Error).message}`);
  });

  ipcMain.handle(IPC.FORGE_LIST_DRAFTS, async (event, projectPath: unknown) => {
    setupSubscriber(event);
    return listDrafts(await gateProjectPath(projectPath));
  });

  ipcMain.handle(IPC.FORGE_GET_DRAFT, async (event, draftId: unknown) => {
    setupSubscriber(event);
    return getDraftById(asString(draftId));
  });

  ipcMain.handle(
    IPC.FORGE_CREATE_DRAFT,
    async (event, input: {
      projectPath: unknown;
      kind: unknown;
      scope: unknown;
      slug: unknown;
      brief: unknown;
    }) => {
      setupSubscriber(event);
      return createDraft({
        projectPath: await gateProjectPath(input?.projectPath),
        kind: asKind(input?.kind),
        scope: asScope(input?.scope),
        slug: asString(input?.slug),
        brief: asString(input?.brief),
      });
    },
  );

  ipcMain.handle(
    IPC.FORGE_GENERATE_DRAFT,
    async (event, input: { draftId: unknown }) => {
      setupSubscriber(event);
      // Fire-and-forget — service spawns the run in the background and
      // pushes draft_streaming / draft_ready / draft_error events. The
      // IPC call resolves as soon as the run is scheduled.
      await generateDraft(asString(input?.draftId));
    },
  );

  ipcMain.handle(
    IPC.FORGE_UPDATE_DRAFT,
    async (event, input: {
      draftId: unknown;
      slug?: unknown;
      body?: unknown;
      frontmatter?: unknown;
      userMessage?: unknown;
    }) => {
      setupSubscriber(event);
      // Frontmatter is an arbitrary record — sanitization happens
      // service-side. We just type-narrow it to an object.
      const fm =
        input?.frontmatter && typeof input.frontmatter === 'object'
          ? (input.frontmatter as Record<string, unknown>)
          : undefined;
      return updateDraft({
        draftId: asString(input?.draftId),
        slug: asOptString(input?.slug),
        body: asOptString(input?.body),
        frontmatter: fm as never,
        userMessage: asOptString(input?.userMessage),
      });
    },
  );

  ipcMain.handle(
    IPC.FORGE_SAVE_DRAFT,
    async (event, input: { draftId: unknown }) => {
      setupSubscriber(event);
      return saveDraft(asString(input?.draftId));
    },
  );

  ipcMain.handle(IPC.FORGE_DELETE_DRAFT, async (event, draftId: unknown) => {
    setupSubscriber(event);
    return deleteDraft(asString(draftId));
  });

  ipcMain.handle(IPC.FORGE_CANCEL_DRAFT, async (event, draftId: unknown) => {
    setupSubscriber(event);
    return cancelDraft(asString(draftId));
  });

  ipcMain.handle(IPC.FORGE_LIST_STATS, async (event, projectPath: unknown) => {
    setupSubscriber(event);
    return listStats(await gateProjectPath(projectPath));
  });

  ipcMain.handle(
    IPC.FORGE_RECORD_USE,
    async (event, input: {
      projectPath: unknown;
      key: unknown;
      threadId: unknown;
      messageId: unknown;
    }) => {
      setupSubscriber(event);
      return recordUse({
        projectPath: await gateProjectPath(input?.projectPath),
        key: asString(input?.key),
        threadId: asString(input?.threadId),
        messageId: asString(input?.messageId),
      });
    },
  );

  ipcMain.handle(
    IPC.FORGE_RECORD_SIGNAL,
    async (event, input: {
      projectPath: unknown;
      key: unknown;
      messageId: unknown;
      signal: unknown;
      note?: unknown;
    }) => {
      setupSubscriber(event);
      return recordSignal({
        projectPath: await gateProjectPath(input?.projectPath),
        key: asString(input?.key),
        messageId: asString(input?.messageId),
        signal: asSignal(input?.signal),
        note: asOptString(input?.note),
      });
    },
  );

  ipcMain.handle(
    IPC.FORGE_LIST_USES,
    async (event, input: { projectPath: unknown; key: unknown; limit?: unknown }) => {
      setupSubscriber(event);
      const limit =
        typeof input?.limit === 'number' && Number.isFinite(input.limit)
          ? Math.max(1, Math.floor(input.limit))
          : undefined;
      return listUses({
        projectPath: await gateProjectPath(input?.projectPath),
        key: asString(input?.key),
        limit,
      });
    },
  );

  ipcMain.handle(
    IPC.FORGE_LIST_SUGGESTIONS,
    async (event, projectPath: unknown) => {
      setupSubscriber(event);
      return listSuggestions(await gateProjectPath(projectPath));
    },
  );

  ipcMain.handle(
    IPC.FORGE_DISMISS_SUGGESTION,
    async (event, input: { projectPath: unknown; suggestionId: unknown }) => {
      setupSubscriber(event);
      return dismissSuggestion(
        await gateProjectPath(input?.projectPath),
        asString(input?.suggestionId),
      );
    },
  );

  ipcMain.handle(IPC.FORGE_LIST_CATALOG, async (event) => {
    setupSubscriber(event);
    return listCatalog();
  });

  ipcMain.handle(IPC.FORGE_DISCOVER_MATCHES, async (event, projectPath: unknown) => {
    setupSubscriber(event);
    return discoverMatches(await gateProjectPath(projectPath));
  });

  ipcMain.handle(IPC.FORGE_GET_SETTINGS, (event) => {
    setupSubscriber(event);
    return getSettings();
  });

  ipcMain.handle(
    IPC.FORGE_SET_SETTINGS,
    (event, patch: Partial<ForgeSettings>) => {
      setupSubscriber(event);
      return setSettings(patch ?? {});
    },
  );

  // getDraft is exported by ForgeService but not yet wired to an IPC
  // handler here; reference it so the import isn't flagged unused.
  void getDraft;
}
