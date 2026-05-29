import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * RufloPluginsService parser-level tests.
 *
 * We mock `electron` for the same reason RufloService.test.ts does — the
 * shared `setupPaths` helper imports `app` from electron, and the service
 * module pulls it in transitively. Mocking once at the top keeps the
 * pure-function tests isolated from the (unspawned) `claude` binary.
 */
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

describe('RufloPluginsService.parsePluginId', () => {
  afterEach(async () => {
    const { __resetForTests } = await import('@main/services/RufloPluginsService');
    __resetForTests();
  });

  it('splits a typical name@marketplace pair', async () => {
    const { parsePluginId } = await import('@main/services/RufloPluginsService');
    expect(parsePluginId('ruflo-core@ruflo')).toEqual({
      name: 'ruflo-core',
      marketplace: 'ruflo',
    });
  });

  it('uses the LAST @ so npm-scoped names parse correctly', async () => {
    const { parsePluginId } = await import('@main/services/RufloPluginsService');
    // @org/plugin@marketplace — the leading @ is part of the scope, not the
    // marketplace separator.
    expect(parsePluginId('@scope/plugin@ruflo')).toEqual({
      name: '@scope/plugin',
      marketplace: 'ruflo',
    });
  });

  it('returns empty marketplace when no separator is present', async () => {
    const { parsePluginId } = await import('@main/services/RufloPluginsService');
    expect(parsePluginId('barenameonly')).toEqual({
      name: 'barenameonly',
      marketplace: '',
    });
  });

  it('handles empty / non-string defensively', async () => {
    const { parsePluginId } = await import('@main/services/RufloPluginsService');
    expect(parsePluginId('')).toEqual({ name: '', marketplace: '' });
    // @ts-expect-error — exercising the runtime-typeof guard.
    expect(parsePluginId(null)).toEqual({ name: '', marketplace: '' });
    // @ts-expect-error — exercising the runtime-typeof guard.
    expect(parsePluginId(undefined)).toEqual({ name: '', marketplace: '' });
  });
});

describe('RufloPluginsService.parsePluginListJson', () => {
  afterEach(async () => {
    const { __resetForTests } = await import('@main/services/RufloPluginsService');
    __resetForTests();
  });

  it('parses a typical claude plugin list --json fixture', async () => {
    const { parsePluginListJson } = await import(
      '@main/services/RufloPluginsService'
    );
    // Mirrors the real shape from `claude plugin list --json`.
    const fixture = JSON.stringify([
      {
        id: 'ruflo-core@ruflo',
        version: '0.4.2',
        scope: 'user',
        enabled: true,
        installPath: '/Users/test/.claude/plugins/ruflo-core',
        installedAt: '2026-05-29T10:00:00.000Z',
      },
      {
        id: 'mempalace@anthropic',
        version: '0.1.0',
        scope: 'user',
        enabled: true,
        installPath: '/Users/test/.claude/plugins/mempalace',
        installedAt: '2026-05-15T10:00:00.000Z',
      },
      {
        id: 'context7@official',
        version: '1.2.3',
        scope: 'global',
        enabled: false,
      },
    ]);

    const plugins = parsePluginListJson(fixture);

    expect(plugins).toHaveLength(3);

    const core = plugins[0]!;
    expect(core.id).toBe('ruflo-core@ruflo');
    expect(core.name).toBe('ruflo-core');
    expect(core.marketplace).toBe('ruflo');
    expect(core.version).toBe('0.4.2');
    expect(core.enabled).toBe(true);
    expect(core.isRuflo).toBe(true);
    expect(core.installPath).toBe('/Users/test/.claude/plugins/ruflo-core');

    const mem = plugins[1]!;
    expect(mem.isRuflo).toBe(false);
    expect(mem.marketplace).toBe('anthropic');

    const ctx = plugins[2]!;
    expect(ctx.installPath).toBeUndefined();
    expect(ctx.enabled).toBe(false);
    expect(ctx.isRuflo).toBe(false);
  });

  it('marks a plugin as isRuflo when the name starts with ruflo- even if marketplace differs', async () => {
    const { parsePluginListJson } = await import(
      '@main/services/RufloPluginsService'
    );
    // Defensive: a user may have installed ruflo-swarm from a forked
    // marketplace. Still surface it as a Ruflo plugin so the UI groups it.
    const fixture = JSON.stringify([
      {
        id: 'ruflo-swarm@my-fork',
        version: '0.1.0',
        scope: 'user',
        enabled: true,
      },
    ]);
    const plugins = parsePluginListJson(fixture);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.isRuflo).toBe(true);
    expect(plugins[0]!.marketplace).toBe('my-fork');
  });

  it('returns [] for malformed JSON without crashing', async () => {
    const { parsePluginListJson } = await import(
      '@main/services/RufloPluginsService'
    );
    expect(parsePluginListJson('{not json at all')).toEqual([]);
    expect(parsePluginListJson('')).toEqual([]);
    expect(parsePluginListJson('   ')).toEqual([]);
  });

  it('returns [] when JSON parses to a non-array value', async () => {
    const { parsePluginListJson } = await import(
      '@main/services/RufloPluginsService'
    );
    expect(parsePluginListJson('{"foo":"bar"}')).toEqual([]);
    expect(parsePluginListJson('null')).toEqual([]);
    expect(parsePluginListJson('42')).toEqual([]);
  });

  it('skips entries with missing/non-string id', async () => {
    const { parsePluginListJson } = await import(
      '@main/services/RufloPluginsService'
    );
    const fixture = JSON.stringify([
      { id: 'good@ruflo', version: '1' },
      { version: '2' }, // missing id
      { id: 123, version: '3' }, // non-string id
      { id: '', version: '4' }, // empty id
      null,
      'string-not-object',
    ]);
    const plugins = parsePluginListJson(fixture);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.id).toBe('good@ruflo');
  });

  it('defaults missing optional fields gracefully', async () => {
    const { parsePluginListJson } = await import(
      '@main/services/RufloPluginsService'
    );
    const fixture = JSON.stringify([{ id: 'ruflo-core@ruflo' }]);
    const plugins = parsePluginListJson(fixture);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      id: 'ruflo-core@ruflo',
      name: 'ruflo-core',
      marketplace: 'ruflo',
      version: '',
      scope: '',
      // Missing `enabled` defaults to true — matches Claude's own behavior
      // where a freshly-installed plugin is enabled by default.
      enabled: true,
      isRuflo: true,
    });
    expect(plugins[0]!.installPath).toBeUndefined();
    expect(plugins[0]!.installedAt).toBeUndefined();
  });
});

describe('RufloPluginsService.parseMarketplaceListed', () => {
  afterEach(async () => {
    const { __resetForTests } = await import('@main/services/RufloPluginsService');
    __resetForTests();
  });

  it('detects the ruvnet/ruflo slug', async () => {
    const { parseMarketplaceListed } = await import(
      '@main/services/RufloPluginsService'
    );
    expect(
      parseMarketplaceListed('NAME       SOURCE\nruflo      ruvnet/ruflo\n'),
    ).toBe(true);
  });

  it('detects the full github URL form', async () => {
    const { parseMarketplaceListed } = await import(
      '@main/services/RufloPluginsService'
    );
    expect(
      parseMarketplaceListed(
        '- ruflo (https://github.com/ruvnet/ruflo)\n',
      ),
    ).toBe(true);
  });

  it('returns false when ruflo is absent', async () => {
    const { parseMarketplaceListed } = await import(
      '@main/services/RufloPluginsService'
    );
    expect(
      parseMarketplaceListed('mempalace anthropic/mempalace\n'),
    ).toBe(false);
    expect(parseMarketplaceListed('')).toBe(false);
  });

  it('avoids false positives when only "ruflo" appears without a source slug', async () => {
    const { parseMarketplaceListed } = await import(
      '@main/services/RufloPluginsService'
    );
    // Plugin output that mentions ruflo in a description but isn't actually
    // the marketplace entry — must NOT register as added.
    expect(
      parseMarketplaceListed(
        'Some help text mentioning ruflo but with no source slug.',
      ),
    ).toBe(false);
  });
});
