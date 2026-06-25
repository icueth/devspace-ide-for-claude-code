import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadTasks, saveTasks, type TasksFile } from '../taskStore';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-tasks-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const file = () => path.join(dir, 'tasks.json');

describe('taskStore', () => {
  it('loadTasks returns empty when the file is missing', async () => {
    expect(await loadTasks(file())).toEqual({ tasks: [] });
  });

  it('round-trips tasks through save/load (and creates parent dirs)', async () => {
    const data: TasksFile = {
      tasks: [
        {
          id: 'abc',
          title: 'T',
          sourceRepoPath: '/r',
          baseBranch: 'main',
          branch: 'devspace/task/t',
          worktreePath: '/w',
          agent: 'claude',
          status: 'running',
          sessionKey: 'abc:claude-cli:agent',
          createdAt: 1,
        },
      ],
    };
    const nested = path.join(dir, 'nested', 'tasks.json');
    await saveTasks(nested, data);
    expect(await loadTasks(nested)).toEqual(data);
  });

  it('loadTasks tolerates corrupt JSON', async () => {
    fs.writeFileSync(file(), '{not json');
    expect(await loadTasks(file())).toEqual({ tasks: [] });
  });
});
