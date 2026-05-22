import { describe, expect, it } from 'vitest';

import {
  OPENCODE_PROVIDER_NAME,
  generateOpenCodeConfig,
} from '@main/services/CliConfigGenerator';
import type { CliProfile } from '@shared/types';

function baseProfile(overrides: Partial<CliProfile> = {}): CliProfile {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'AEON',
    cliId: 'opencode',
    provider: {
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'AEON-7/Qwen3.6-27B',
    },
    createdAt: 0,
    ...overrides,
  };
}

describe('generateOpenCodeConfig', () => {
  it('produces a config with a synthetic devspace provider', () => {
    const cfg = generateOpenCodeConfig(baseProfile());
    expect(cfg.provider).toHaveProperty(OPENCODE_PROVIDER_NAME);
    expect(cfg.provider[OPENCODE_PROVIDER_NAME]?.npm).toBe(
      '@ai-sdk/openai-compatible',
    );
    expect(cfg.provider[OPENCODE_PROVIDER_NAME]?.options.baseURL).toBe(
      'https://api.example.com/v1',
    );
    expect(cfg.provider[OPENCODE_PROVIDER_NAME]?.options.apiKey).toBe('sk-test');
  });

  it('registers the model under the synthetic provider', () => {
    const cfg = generateOpenCodeConfig(baseProfile());
    const models = cfg.provider[OPENCODE_PROVIDER_NAME]?.models;
    expect(models).toBeDefined();
    expect(Object.keys(models!)).toEqual(['AEON-7/Qwen3.6-27B']);
  });

  it('sets the default model in <provider>/<model> form', () => {
    const cfg = generateOpenCodeConfig(baseProfile());
    expect(cfg.model).toBe(`${OPENCODE_PROVIDER_NAME}/AEON-7/Qwen3.6-27B`);
  });

  it('emits the opencode schema URL for editor autocompletion', () => {
    const cfg = generateOpenCodeConfig(baseProfile());
    expect(cfg.$schema).toBe('https://opencode.ai/config.json');
  });

  it('omits limit knobs when profile has no contextLimit/outputLimit', () => {
    const cfg = generateOpenCodeConfig(baseProfile());
    const models = cfg.provider[OPENCODE_PROVIDER_NAME]?.models;
    const model = models!['AEON-7/Qwen3.6-27B'];
    expect(model).toEqual({});
  });

  it('passes contextLimit through as limit.context', () => {
    const cfg = generateOpenCodeConfig(
      baseProfile({
        provider: {
          baseURL: 'https://x',
          apiKey: 'k',
          model: 'm',
          contextLimit: 128_000,
        },
      }),
    );
    const model = cfg.provider[OPENCODE_PROVIDER_NAME]?.models!['m'];
    expect(model).toEqual({ limit: { context: 128_000 } });
  });

  it('passes outputLimit through as limit.output', () => {
    const cfg = generateOpenCodeConfig(
      baseProfile({
        provider: {
          baseURL: 'https://x',
          apiKey: 'k',
          model: 'm',
          outputLimit: 8192,
        },
      }),
    );
    const model = cfg.provider[OPENCODE_PROVIDER_NAME]?.models!['m'];
    expect(model).toEqual({ limit: { output: 8192 } });
  });

  it('combines contextLimit + outputLimit on the same limit block', () => {
    const cfg = generateOpenCodeConfig(
      baseProfile({
        provider: {
          baseURL: 'https://x',
          apiKey: 'k',
          model: 'm',
          contextLimit: 32_768,
          outputLimit: 4096,
        },
      }),
    );
    const model = cfg.provider[OPENCODE_PROVIDER_NAME]?.models!['m'];
    expect(model).toEqual({
      limit: { context: 32_768, output: 4096 },
    });
  });

  it('floors non-integer limits to safe integer values', () => {
    const cfg = generateOpenCodeConfig(
      baseProfile({
        provider: {
          baseURL: 'https://x',
          apiKey: 'k',
          model: 'm',
          contextLimit: 65_536.9,
          outputLimit: 2048.7,
        },
      }),
    );
    const model = cfg.provider[OPENCODE_PROVIDER_NAME]?.models!['m'];
    expect(model).toEqual({ limit: { context: 65_536, output: 2048 } });
  });

  it('throws on missing profile', () => {
    // @ts-expect-error — runtime guard for hand-crafted callers
    expect(() => generateOpenCodeConfig(null)).toThrow(/profile is required/);
  });

  it('throws on wrong cliId', () => {
    expect(() =>
      generateOpenCodeConfig(
        baseProfile({
          // @ts-expect-error — runtime guard
          cliId: 'codex',
        }),
      ),
    ).toThrow(/expected cliId='opencode'/);
  });

  it('throws on missing baseURL', () => {
    expect(() =>
      generateOpenCodeConfig(
        baseProfile({
          provider: { baseURL: '   ', apiKey: 'k', model: 'm' },
        }),
      ),
    ).toThrow(/baseURL is required/);
  });

  it('throws on missing model', () => {
    expect(() =>
      generateOpenCodeConfig(
        baseProfile({
          provider: { baseURL: 'https://x', apiKey: 'k', model: '' },
        }),
      ),
    ).toThrow(/model is required/);
  });
});
