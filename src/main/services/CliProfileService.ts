import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import type { CliId, CliProfile } from '@shared/types';

// Per-provider configs for non-Claude CLIs (currently OpenCode) — an
// OpenAI-compatible provider (baseURL/apiKey/model) the CLI launches against.
// Mirrors ClaudeAuthService: secrets in a 0o600 file, never sent to the
// renderer (list/save return sanitized profiles with apiKey blanked).

function storeFile(): string {
  return path.join(os.homedir(), '.devspace', 'cli-profiles.json');
}

async function loadStored(): Promise<CliProfile[]> {
  try {
    const raw = await fs.promises.readFile(storeFile(), 'utf8');
    const parsed = JSON.parse(raw) as { profiles?: CliProfile[] };
    return (parsed.profiles ?? []).filter(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        p.provider &&
        typeof p.provider.baseURL === 'string',
    );
  } catch {
    return [];
  }
}

async function saveStored(profiles: CliProfile[]): Promise<void> {
  // SECRET file — provider.apiKey lives here. 0o600 + 0o700 dir.
  await atomicWriteAsync(storeFile(), JSON.stringify({ profiles }, null, 2), {
    mode: 0o600,
    dirMode: 0o700,
  });
}

function sanitize(p: CliProfile): CliProfile {
  return { ...p, provider: { ...p.provider, apiKey: '' } };
}

// Sanitized list for the renderer (secrets blanked). Optional cliId filter.
export async function listCliProfiles(cliId?: CliId): Promise<CliProfile[]> {
  const all = (await loadStored()).sort((a, b) => a.createdAt - b.createdAt);
  const filtered = cliId ? all.filter((p) => p.cliId === cliId) : all;
  return filtered.map(sanitize);
}

// Full profile WITH apiKey — main-process only (launcher → adapter.ensureConfig).
export async function getCliProfile(id: string): Promise<CliProfile | null> {
  return (await loadStored()).find((p) => p.id === id) ?? null;
}

// Create or update a profile. Blank apiKey on an existing profile keeps the
// stored key (so the UI can edit name/baseURL/model without re-pasting).
export async function saveCliProfile(input: {
  id?: string;
  name: string;
  cliId: Exclude<CliId, 'claude'>;
  baseURL: string;
  apiKey: string;
  model: string;
}): Promise<CliProfile> {
  const stored = await loadStored();
  const id = input.id || randomUUID();
  const existing = stored.find((p) => p.id === id);
  const apiKey = input.apiKey.trim() || existing?.provider.apiKey || '';
  if (!apiKey) throw new Error('apiKey required');
  const profile: CliProfile = {
    id,
    name: input.name.trim().slice(0, 64) || 'Provider',
    cliId: input.cliId,
    provider: {
      baseURL: input.baseURL.trim(),
      apiKey: apiKey.slice(0, 8192),
      model: input.model.trim(),
    },
    createdAt: existing?.createdAt ?? Date.now(),
  };
  await saveStored(
    existing ? stored.map((p) => (p.id === id ? profile : p)) : [...stored, profile],
  );
  return sanitize(profile);
}

export async function deleteCliProfile(id: string): Promise<void> {
  await saveStored((await loadStored()).filter((p) => p.id !== id));
}
