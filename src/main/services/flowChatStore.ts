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

export async function loadChat(projectPath: string): Promise<FlowChatMessage[]> {
  try {
    const raw: unknown = JSON.parse(
      await fs.promises.readFile(chatFile(projectPath), 'utf8'),
    );
    if (!Array.isArray(raw)) return [];
    return raw.filter(isMessage).slice(-HISTORY_CAP);
  } catch {
    return []; // missing or corrupt — a chat with no history, not an error
  }
}

/** Persist (capped) and return exactly what was written — the caller's new truth. */
export async function saveChat(
  projectPath: string,
  messages: FlowChatMessage[],
): Promise<FlowChatMessage[]> {
  const capped = messages.slice(-HISTORY_CAP);
  await atomicWriteAsync(chatFile(projectPath), JSON.stringify(capped, null, 2));
  return capped;
}

export async function clearChat(projectPath: string): Promise<void> {
  await fs.promises.rm(chatFile(projectPath), { force: true });
}
