import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/services/WorkspaceService', () => ({
  listWorkspaces: async () => ({
    active: null,
    workspaces: [
      { id: 'w1', name: 'w1', path: '/Users/test/proj-a', lastOpened: 0 },
      { id: 'w2', name: 'w2', path: '/Users/test/proj-b', lastOpened: 0 },
    ],
  }),
}));

import {
  assertAllowedSettingsPath,
  assertGitRef,
  assertInWorkspace,
  assertRelativePath,
  assertSafeKey,
  invalidateWorkspaceRootsCache,
} from '@main/utils/pathScope';

describe('assertInWorkspace', () => {
  it('accepts paths under any added workspace', async () => {
    invalidateWorkspaceRootsCache();
    await expect(assertInWorkspace('/Users/test/proj-a/src/x.ts')).resolves.toBe(
      '/Users/test/proj-a/src/x.ts',
    );
    await expect(assertInWorkspace('/Users/test/proj-b')).resolves.toBe(
      '/Users/test/proj-b',
    );
  });

  it('rejects paths outside every workspace (the B2 attack)', async () => {
    invalidateWorkspaceRootsCache();
    await expect(assertInWorkspace('/etc/passwd')).rejects.toThrow(/outside/);
    await expect(assertInWorkspace('/Users/test/.ssh/id_rsa')).rejects.toThrow(
      /outside/,
    );
    await expect(
      assertInWorkspace('/Users/test/proj-a-but-not-really'),
    ).rejects.toThrow(/outside/);
  });

  it('rejects null bytes + non-string input', async () => {
    invalidateWorkspaceRootsCache();
    await expect(assertInWorkspace('/Users/test/x\0/y')).rejects.toThrow(/null/);
    await expect(assertInWorkspace('')).rejects.toThrow(/non-empty/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(assertInWorkspace(undefined as any)).rejects.toThrow();
  });
});

describe('assertAllowedSettingsPath', () => {
  const home = os.homedir();
  it('accepts ~/.claude/* paths', () => {
    expect(
      assertAllowedSettingsPath(path.join(home, '.claude/settings.json'), null),
    ).toBe(path.join(home, '.claude/settings.json'));
    expect(
      assertAllowedSettingsPath(
        path.join(home, '.claude/agents/foo.md'),
        null,
      ),
    ).toBe(path.join(home, '.claude/agents/foo.md'));
  });

  it('accepts project .claude / .mcp.json / .devspace / CLAUDE.md', () => {
    const p = '/Users/test/proj-a';
    expect(
      assertAllowedSettingsPath(`${p}/.claude/settings.json`, p),
    ).toBeTruthy();
    expect(assertAllowedSettingsPath(`${p}/.mcp.json`, p)).toBeTruthy();
    expect(assertAllowedSettingsPath(`${p}/CLAUDE.md`, p)).toBeTruthy();
    expect(
      assertAllowedSettingsPath(`${p}/.devspace/design/x.json`, p),
    ).toBeTruthy();
  });

  it('rejects paths outside the allowlist (the B1 attack)', () => {
    expect(() =>
      assertAllowedSettingsPath('/etc/passwd', '/Users/test/proj-a'),
    ).toThrow(/outside allowed/);
    expect(() =>
      assertAllowedSettingsPath(
        path.join(home, '.zshrc'),
        '/Users/test/proj-a',
      ),
    ).toThrow(/outside allowed/);
    expect(() =>
      assertAllowedSettingsPath(
        path.join(home, 'Library/LaunchAgents/x.plist'),
        '/Users/test/proj-a',
      ),
    ).toThrow(/outside allowed/);
  });
});

describe('assertGitRef', () => {
  it('accepts safe refs', () => {
    expect(assertGitRef('main')).toBe('main');
    expect(assertGitRef('feature/foo-bar')).toBe('feature/foo-bar');
    expect(assertGitRef('v1.2.3')).toBe('v1.2.3');
  });

  it('rejects flag-injection attempts (the H2 attack)', () => {
    expect(() => assertGitRef('--upload-pack=cmd')).toThrow();
    expect(() => assertGitRef('-x')).toThrow();
    expect(() => assertGitRef('foo..bar')).toThrow();
    expect(() => assertGitRef('foo bar')).toThrow();
    expect(() => assertGitRef('')).toThrow();
  });
});

describe('assertRelativePath', () => {
  it('accepts simple relative paths', () => {
    expect(assertRelativePath('src/x.ts')).toBe('src/x.ts');
    expect(assertRelativePath('a/b/c')).toBe('a/b/c');
  });

  it('rejects absolute / flag / traversal', () => {
    expect(() => assertRelativePath('/etc/passwd')).toThrow();
    expect(() => assertRelativePath('--upload-pack=x')).toThrow();
    expect(() => assertRelativePath('../../etc')).toThrow();
    expect(() => assertRelativePath('foo\nbar')).toThrow();
  });
});

describe('assertSafeKey', () => {
  it('rejects prototype-pollution keys (the M2 attack)', () => {
    expect(() => assertSafeKey('__proto__')).toThrow(/reserved/);
    expect(() => assertSafeKey('constructor')).toThrow(/reserved/);
    expect(() => assertSafeKey('prototype')).toThrow(/reserved/);
  });

  it('rejects malformed names', () => {
    expect(() => assertSafeKey('foo bar')).toThrow();
    expect(() => assertSafeKey('foo/bar')).toThrow();
    expect(() => assertSafeKey('')).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertSafeKey(null as any)).toThrow();
  });

  it('accepts normal names', () => {
    expect(assertSafeKey('my-server')).toBe('my-server');
    expect(assertSafeKey('server_1.0')).toBe('server_1.0');
  });
});
