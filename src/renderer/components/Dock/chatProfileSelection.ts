import type { ChatThread, ChatThreadMeta, LlmChatProfile } from '@shared/types';

/**
 * Resolve which profile id the chat panel's provider dropdown should
 * highlight for a given (thread, profiles) pair.
 *
 * Rules:
 *   • No thread → null (Claude default).
 *   • Thread has no llmProfileId → null (Claude default).
 *   • Thread has llmProfileId AND that id still exists in `profiles`
 *     → return that id (the dropdown selects that option).
 *   • Thread has a STALE llmProfileId (profile was deleted) → null,
 *     so the dropdown falls back to Claude instead of showing a ghost
 *     entry the user can't act on.
 */
export function resolveProfileSelection(
  thread: { llmProfileId?: string } | ChatThread | ChatThreadMeta | null | undefined,
  profiles: ReadonlyArray<Pick<LlmChatProfile, 'id'>>,
): string | null {
  if (!thread) return null;
  const id = thread.llmProfileId;
  if (!id) return null;
  return profiles.some((p) => p.id === id) ? id : null;
}

/**
 * Lookup helper for the option-label badge — returns the profile's
 * display name or the sentinel string 'unknown LLM' when the id points
 * at a deleted profile. Kept pure so the chat panel + future thread
 * list renderers can share it without duplicating the fallback.
 */
export function profileNameForBadge(
  llmProfileId: string | undefined,
  profiles: ReadonlyArray<Pick<LlmChatProfile, 'id' | 'name'>>,
): string | null {
  if (!llmProfileId) return null;
  const hit = profiles.find((p) => p.id === llmProfileId);
  return hit ? hit.name : 'unknown LLM';
}
