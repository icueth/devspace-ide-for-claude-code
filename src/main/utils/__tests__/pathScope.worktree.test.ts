import { afterEach, describe, expect, it } from 'vitest';

import {
  addWorktreeScope,
  assertInWorkspace,
  removeWorktreeScope,
} from '../pathScope';

const WT = '/tmp/devspace-test-wt/task-abc';

afterEach(() => removeWorktreeScope(WT));

describe('pathScope worktree allowlist', () => {
  it('allows a path under a registered worktree even when no workspace contains it', async () => {
    addWorktreeScope(WT);
    await expect(assertInWorkspace(`${WT}/src/index.ts`)).resolves.toBe(
      `${WT}/src/index.ts`,
    );
  });

  it('rejects the worktree path again after it is removed', async () => {
    addWorktreeScope(WT);
    removeWorktreeScope(WT);
    await expect(assertInWorkspace(`${WT}/src/index.ts`)).rejects.toThrow(
      /outside any open workspace/,
    );
  });
});
