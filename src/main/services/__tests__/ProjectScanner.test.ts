import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanWorkspace } from '@main/services/ProjectScanner';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-scanner-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('scanWorkspace empty-workspace fallback', () => {
  it('returns the workspace itself as a project when the folder is empty', async () => {
    // Regression for v0.16.1: an empty folder picked as workspace would
    // return [] which left the sidebar at "No projects found" and the
    // user with no way to create files from inside the app.
    const projects = await scanWorkspace(tmpRoot, 'workspace-empty');

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe(tmpRoot);
    expect(projects[0].isWorkspaceRoot).toBe(true);
    expect(projects[0].vcs).toBe('none');
    expect(projects[0].detectedRuntime).toEqual([]);
  });

  it('returns the workspace itself when it has only loose files and no markers', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# notes');
    fs.writeFileSync(path.join(tmpRoot, 'todo.txt'), 'buy milk');

    const projects = await scanWorkspace(tmpRoot, 'workspace-files-only');

    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe(tmpRoot);
    expect(projects[0].isWorkspaceRoot).toBe(true);
  });

  it('does NOT apply the fallback when subfolders are detected as projects', async () => {
    // Depth-1 forceInclude path: empty subfolder becomes a project on its
    // own. Workspace root should NOT be added in that case — it's a true
    // container.
    fs.mkdirSync(path.join(tmpRoot, 'web'));
    fs.mkdirSync(path.join(tmpRoot, 'api'));

    const projects = await scanWorkspace(tmpRoot, 'workspace-with-subfolders');

    expect(projects).toHaveLength(2);
    expect(projects.find((p) => p.isWorkspaceRoot)).toBeUndefined();
    expect(projects.map((p) => p.name).sort()).toEqual(['api', 'web']);
  });

  it('still surfaces the workspace root project when it has runtime markers', async () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'thing', version: '0.0.0' }),
    );

    const projects = await scanWorkspace(tmpRoot, 'workspace-with-package');

    expect(projects).toHaveLength(1);
    expect(projects[0].isWorkspaceRoot).toBe(true);
    expect(projects[0].detectedRuntime).toContain('node');
  });
});
