import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import type { ClaudeAuthProfile } from '@shared/types';

// Per-session auth profiles for the built-in `claude` CLI. The built-in
// `subscription` profile (OAuth login, no env) is synthetic + always first;
// user-defined API profiles live in a 0o600 secret file (they hold keys).

function storeFile(): string {
  return path.join(os.homedir(), '.devspace', 'claude-auth.json');
}

export const SUBSCRIPTION_PROFILE: ClaudeAuthProfile = {
  id: 'subscription',
  name: 'Subscription (login)',
  kind: 'subscription',
  createdAt: 0,
};

async function loadStored(): Promise<ClaudeAuthProfile[]> {
  try {
    const raw = await fs.promises.readFile(storeFile(), 'utf8');
    const parsed = JSON.parse(raw) as { profiles?: ClaudeAuthProfile[] };
    return (parsed.profiles ?? []).filter(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        p.id !== 'subscription' &&
        p.kind === 'api',
    );
  } catch {
    return [];
  }
}

async function saveStored(profiles: ClaudeAuthProfile[]): Promise<void> {
  // SECRET file — apiKey / authToken live here. 0o600 + 0o700 dir so another
  // user on a shared machine can't read the keys (mirrors LlmConfigService).
  await atomicWriteAsync(storeFile(), JSON.stringify({ profiles }, null, 2), {
    mode: 0o600,
    dirMode: 0o700,
  });
}

// Strip secrets — the renderer never needs the raw key (kind === 'api' already
// tells it a key is configured). Used for everything that crosses IPC.
function sanitize(p: ClaudeAuthProfile): ClaudeAuthProfile {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    createdAt: p.createdAt,
  };
}

// subscription first, then API profiles oldest → newest. Secrets stripped.
export async function listAuthProfiles(): Promise<ClaudeAuthProfile[]> {
  const stored = (await loadStored()).sort((a, b) => a.createdAt - b.createdAt);
  return [SUBSCRIPTION_PROFILE, ...stored.map(sanitize)];
}

// Create or update an API profile. A blank apiKey on an existing profile keeps
// the stored key (so the UI can edit name/baseUrl without re-pasting). Returns
// the sanitized profile.
export async function saveAuthProfile(input: {
  id?: string;
  name: string;
  apiKey: string;
  baseUrl?: string;
  authToken?: string;
}): Promise<ClaudeAuthProfile> {
  const stored = await loadStored();
  const id = input.id && input.id !== 'subscription' ? input.id : randomUUID();
  const existing = stored.find((p) => p.id === id);
  const apiKey = input.apiKey.trim() || existing?.apiKey || '';
  if (!apiKey) throw new Error('apiKey required');
  const profile: ClaudeAuthProfile = {
    id,
    name: input.name.trim().slice(0, 64) || 'API',
    kind: 'api',
    apiKey: apiKey.slice(0, 8192),
    baseUrl: input.baseUrl?.trim() || undefined,
    authToken: input.authToken?.trim() || existing?.authToken || undefined,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  await saveStored(
    existing ? stored.map((p) => (p.id === id ? profile : p)) : [...stored, profile],
  );
  return sanitize(profile);
}

export async function deleteAuthProfile(id: string): Promise<void> {
  if (id === 'subscription') return;
  await saveStored((await loadStored()).filter((p) => p.id !== id));
}

// Resolve a profile id to ANTHROPIC_* `KEY=value` env pairs for the launcher.
// subscription / unknown / missing → [] (claude uses its own login).
export async function resolveAuthEnvPairs(profileId?: string): Promise<string[]> {
  if (!profileId || profileId === 'subscription') return [];
  const p = (await loadStored()).find((x) => x.id === profileId);
  if (!p || p.kind !== 'api' || !p.apiKey) return [];
  const pairs = [`ANTHROPIC_API_KEY=${p.apiKey}`];
  if (p.baseUrl) pairs.push(`ANTHROPIC_BASE_URL=${p.baseUrl}`);
  if (p.authToken) pairs.push(`ANTHROPIC_AUTH_TOKEN=${p.authToken}`);
  return pairs;
}
