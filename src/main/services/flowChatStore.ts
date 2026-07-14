// Agent Flow — lead-chat persistence.
//
// Plain, curatable JSON at <projectPath>/.devspace/flows/chat.json — same
// contract as the rest of the flow state: the user can read it, hand-edit it,
// delete it, and nothing here is fatal if they get it wrong (a corrupt file
// degrades to "no history", never to a crashed panel).
//
// The filename is FIXED. No caller input (message text, ids) ever reaches the
// path, so there is nothing to traverse with — the only variable is projectPath,
// which is workspace-checked at the IPC boundary (assertInWorkspace).

import * as fs from 'node:fs';
import * as path from 'node:path';

import { flowsDir } from '@main/services/flowStore';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import type { FlowChatMessage } from '@shared/flowTypes';

/** Messages kept on disk (and stuffed into the next prompt). Oldest drop first. */
export const HISTORY_CAP = 200;

export function chatFile(projectPath: string): string {
  return path.join(flowsDir(projectPath), 'chat.json');
}

/**
 * A print-mode turn that was in flight when the file was last written. The
 * process itself outlives the app (TmuxChatRunner detaches it), so this marker
 * is what lets the next boot re-attach to it instead of losing the reply —
 * FlowChatService.history() resumes from it. Internal to this file's format,
 * NOT part of the shared FlowChat contract.
 */
export interface ActiveRun {
  sessionName: string;
  runDir: string;
}

/** On-disk shape. A bare array is the phase-2 format and still reads fine. */
interface ChatFile {
  messages: FlowChatMessage[];
  activeRun?: ActiveRun;
}

function isMessage(v: unknown): v is FlowChatMessage {
  const m = v as Partial<FlowChatMessage> | null;
  return (
    !!m &&
    typeof m.id === 'string' &&
    (m.role === 'user' || m.role === 'lead') &&
    typeof m.text === 'string' &&
    typeof m.at === 'number'
  );
}

function isActiveRun(v: unknown): v is ActiveRun {
  const r = v as Partial<ActiveRun> | null;
  return !!r && typeof r.sessionName === 'string' && typeof r.runDir === 'string';
}

async function readFile(projectPath: string): Promise<ChatFile> {
  try {
    const raw: unknown = JSON.parse(
      await fs.promises.readFile(chatFile(projectPath), 'utf8'),
    );
    // Legacy: the file used to be the message array itself.
    const list: unknown = Array.isArray(raw) ? raw : (raw as ChatFile)?.messages;
    const messages = Array.isArray(list) ? list.filter(isMessage).slice(-HISTORY_CAP) : [];
    const run = Array.isArray(raw) ? undefined : (raw as ChatFile)?.activeRun;
    return isActiveRun(run) ? { messages, activeRun: run } : { messages };
  } catch {
    return { messages: [] }; // missing or corrupt — no history, not an error
  }
}

export async function loadChat(projectPath: string): Promise<FlowChatMessage[]> {
  return (await readFile(projectPath)).messages;
}

/** The in-flight turn recorded by the last write, if any. */
export async function loadActiveRun(projectPath: string): Promise<ActiveRun | null> {
  return (await readFile(projectPath)).activeRun ?? null;
}

/**
 * Persist (capped) and return exactly what was written — the caller's new truth.
 *
 * `activeRun`: undefined keeps whatever the file already says (the common case),
 * null clears the marker, an object sets it. Passing it here rather than through
 * a second write keeps "the reply landed" and "the turn is over" in ONE atomic
 * write — a crash between them would otherwise resume a finished turn and
 * duplicate its reply.
 */
export async function saveChat(
  projectPath: string,
  messages: FlowChatMessage[],
  activeRun?: ActiveRun | null,
): Promise<FlowChatMessage[]> {
  const capped = messages.slice(-HISTORY_CAP);
  const current = activeRun === undefined ? (await readFile(projectPath)).activeRun : activeRun;
  const file: ChatFile = { messages: capped, ...(current ? { activeRun: current } : {}) };
  await atomicWriteAsync(chatFile(projectPath), JSON.stringify(file, null, 2));
  return capped;
}

/** Record (or clear) the in-flight turn without touching the transcript. */
export async function saveActiveRun(
  projectPath: string,
  activeRun: ActiveRun | null,
): Promise<void> {
  const { messages } = await readFile(projectPath);
  await saveChat(projectPath, messages, activeRun);
}

export async function clearChat(projectPath: string): Promise<void> {
  await fs.promises.rm(chatFile(projectPath), { force: true });
}
