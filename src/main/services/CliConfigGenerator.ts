// CliConfigGenerator — pure functions that materialize the on-disk shape
// of a CLI runtime's config file from a CliProfile. NO I/O happens here
// — the adapter's `ensureConfig` consumes the returned object and writes
// it atomically. Splitting it out this way keeps the unit test surface
// pinned: feed in profiles, assert the JSON object literally.
//
// OpenCode config schema (v1.x): an `opencode.json` file under
// $OPENCODE_CONFIG_DIR with a `provider` block describing OpenAI-
// compatible endpoints and a `model` block listing usable model ids. We
// register a single synthetic provider per profile so the user's
// upstream config (~/.config/opencode/) is never touched. The model id
// we hand back is `<providerName>/<modelId>` — opencode expects the
// fully-qualified `provider/model` form when selecting at runtime.
//
// References:
//   - https://opencode.ai/docs/config
//   - schema "$schema": "https://opencode.ai/config.json"

import type { CliProfile } from '@shared/types';

// Stable synthetic provider name. Lives ONLY inside the per-profile
// config dir, so it never collides with a real provider the user might
// have configured upstream. Picking a deterministic value (rather than
// e.g. profile.id) makes the generated config easy to inspect by hand.
export const OPENCODE_PROVIDER_NAME = 'devspace-openai';

// The @ai-sdk/openai-compatible npm package opencode uses for arbitrary
// OpenAI-compatible servers. Listed in opencode's published schema as
// the standard transport for self-hosted vLLM / TGI / etc.
const OPENAI_COMPAT_PACKAGE = '@ai-sdk/openai-compatible';

export interface OpenCodeProviderBlock {
  npm: string;
  name?: string;
  options: {
    baseURL: string;
    apiKey: string;
  };
  models: Record<string, Record<string, unknown>>;
}

export interface OpenCodeConfig {
  $schema?: string;
  provider: Record<string, OpenCodeProviderBlock>;
  // Default model in `<provider>/<model>` form. opencode honors this on
  // boot so the user doesn't have to pass --model on every turn.
  model: string;
  // Per-model knobs honored by opencode (output cap, context window
  // estimate). Optional — opencode falls back to provider defaults when
  // absent.
  small_model?: string;
}

/**
 * Produce the opencode.json contents for one profile. Pure — no I/O.
 *
 * The adapter wraps this in atomic-write + 0o600 perms when committing
 * to disk. Throws if the profile's required fields are missing — those
 * should already be validated by CliProfilesService.upsert, but the
 * generator is defense-in-depth so a hand-edited cli-profiles.json
 * can't ship a malformed opencode.json downstream.
 */
export function generateOpenCodeConfig(profile: CliProfile): OpenCodeConfig {
  if (!profile || typeof profile !== 'object') {
    throw new Error('generateOpenCodeConfig: profile is required');
  }
  if (profile.cliId !== 'opencode') {
    throw new Error(
      `generateOpenCodeConfig: expected cliId='opencode', got '${profile.cliId}'`,
    );
  }
  const { provider } = profile;
  if (!provider || typeof provider !== 'object') {
    throw new Error('generateOpenCodeConfig: profile.provider is required');
  }
  const baseURL = typeof provider.baseURL === 'string' ? provider.baseURL.trim() : '';
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
  const modelId =
    typeof provider.model === 'string' ? provider.model.trim() : '';
  if (!baseURL) {
    throw new Error('generateOpenCodeConfig: provider.baseURL is required');
  }
  if (!modelId) {
    throw new Error('generateOpenCodeConfig: provider.model is required');
  }

  const models: Record<string, Record<string, unknown>> = {};
  // Per-model knobs — opencode treats these as hints. Keep keys narrow
  // (camelCase like the rest of the schema) so opencode parses them.
  const modelKnobs: Record<string, unknown> = {};
  if (
    typeof provider.contextLimit === 'number' &&
    Number.isFinite(provider.contextLimit) &&
    provider.contextLimit > 0
  ) {
    modelKnobs.limit = { context: Math.floor(provider.contextLimit) };
  }
  if (
    typeof provider.outputLimit === 'number' &&
    Number.isFinite(provider.outputLimit) &&
    provider.outputLimit > 0
  ) {
    const existing =
      (modelKnobs.limit as { context?: number; output?: number }) ?? {};
    modelKnobs.limit = {
      ...existing,
      output: Math.floor(provider.outputLimit),
    };
  }
  models[modelId] = modelKnobs;

  const cfg: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [OPENCODE_PROVIDER_NAME]: {
        npm: OPENAI_COMPAT_PACKAGE,
        name: 'DevSpace OpenAI-compatible',
        options: {
          baseURL,
          apiKey,
        },
        models,
      },
    },
    model: `${OPENCODE_PROVIDER_NAME}/${modelId}`,
  };

  return cfg;
}
