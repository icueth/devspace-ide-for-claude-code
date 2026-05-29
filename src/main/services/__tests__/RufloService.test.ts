import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// RufloService imports setupPaths which imports `electron`. Mock it so the
// service loads without an Electron app context, matching the pattern used
// in AgentsService.test.ts.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

describe('RufloService.getProjectStatus', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-ruflo-'));
  });

  afterEach(async () => {
    const { __resetForTests } = await import('@main/services/RufloService');
    __resetForTests();
    await rm(tmp, { recursive: true, force: true });
  });

  it('reports not-initialized for a project without .claude-flow/', async () => {
    const project = path.join(tmp, 'fresh');
    await mkdir(project, { recursive: true });

    const { getProjectStatus } = await import('@main/services/RufloService');
    const status = await getProjectStatus(project);

    expect(status.projectPath).toBe(project);
    expect(status.initialized).toBe(false);
    expect(status.configDir).toBeUndefined();
    expect(status.hasClaudeMd).toBe(false);
    expect(status.hasClaudeDir).toBe(false);
  });

  it('reports initialized + configDir when .claude-flow/ exists', async () => {
    const project = path.join(tmp, 'wired');
    await mkdir(path.join(project, '.claude-flow'), { recursive: true });

    const { getProjectStatus } = await import('@main/services/RufloService');
    const status = await getProjectStatus(project);

    expect(status.initialized).toBe(true);
    expect(status.configDir).toBe(path.join(project, '.claude-flow'));
  });

  it('detects partial init: CLAUDE.md + .claude/ without .claude-flow/', async () => {
    const project = path.join(tmp, 'partial');
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(path.join(project, 'CLAUDE.md'), '# project\n', 'utf8');

    const { getProjectStatus } = await import('@main/services/RufloService');
    const status = await getProjectStatus(project);

    expect(status.initialized).toBe(false);
    expect(status.configDir).toBeUndefined();
    expect(status.hasClaudeMd).toBe(true);
    expect(status.hasClaudeDir).toBe(true);
  });

  it('reports all three flags when fully wired up', async () => {
    const project = path.join(tmp, 'full');
    await mkdir(path.join(project, '.claude-flow'), { recursive: true });
    await mkdir(path.join(project, '.claude'), { recursive: true });
    await writeFile(path.join(project, 'CLAUDE.md'), '# x\n', 'utf8');

    const { getProjectStatus } = await import('@main/services/RufloService');
    const status = await getProjectStatus(project);

    expect(status.initialized).toBe(true);
    expect(status.hasClaudeMd).toBe(true);
    expect(status.hasClaudeDir).toBe(true);
  });

  it('returns initialized=false for a non-existent project path', async () => {
    const ghost = path.join(tmp, 'does-not-exist', 'nested');

    const { getProjectStatus } = await import('@main/services/RufloService');
    const status = await getProjectStatus(ghost);

    expect(status.projectPath).toBe(ghost);
    expect(status.initialized).toBe(false);
    expect(status.configDir).toBeUndefined();
  });

  it('handles empty projectPath defensively', async () => {
    const { getProjectStatus } = await import('@main/services/RufloService');
    const status = await getProjectStatus('');

    expect(status.projectPath).toBe('');
    expect(status.initialized).toBe(false);
  });
});
