import { describe, expect, it, vi } from 'vitest';

import { routeTaskControl, type TaskControlDeps } from '../taskControl';
import type { TaskService } from '../TaskService';

type RouterSvc = Pick<TaskService, 'list' | 'create' | 'merge' | 'discard'>;

function svcWith(tasks: unknown[], over: Partial<RouterSvc> = {}): RouterSvc {
  return {
    list: () => tasks as ReturnType<TaskService['list']>,
    create: vi.fn(),
    merge: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    ...over,
  };
}

function deps(): TaskControlDeps {
  return { sendToSession: vi.fn(), diffOf: vi.fn(async () => 'THE DIFF') };
}

const TASK = {
  id: 'a',
  title: 'T',
  status: 'running',
  branch: 'b',
  sessionKey: 'a:claude-cli:agent',
};

describe('routeTaskControl', () => {
  it('lists tasks with a slim, stable shape', async () => {
    const res = await routeTaskControl(svcWith([TASK]), deps(), { op: 'list' });
    expect(res.ok).toBe(true);
    expect(res.tasks).toEqual([{ id: 'a', title: 'T', status: 'running', branch: 'b' }]);
  });

  it('get returns one task or not-found', async () => {
    expect((await routeTaskControl(svcWith([TASK]), deps(), { op: 'get', id: 'a' })).task).toEqual(
      { id: 'a', title: 'T', status: 'running', branch: 'b' },
    );
    expect(await routeTaskControl(svcWith([]), deps(), { op: 'get', id: 'z' })).toEqual({
      ok: false,
      error: 'task not found',
    });
  });

  it('rejects create with no title / no repo (before the workspace check)', async () => {
    const svc = svcWith([]);
    expect(await routeTaskControl(svc, deps(), { op: 'create', repo: '/x' })).toEqual({
      ok: false,
      error: 'title required',
    });
    expect(await routeTaskControl(svc, deps(), { op: 'create', title: 'hi' })).toEqual({
      ok: false,
      error: 'repo required',
    });
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('changes returns the diff via deps.diffOf', async () => {
    const d = deps();
    const res = await routeTaskControl(svcWith([TASK]), d, { op: 'changes', id: 'a' });
    expect(res).toEqual({ ok: true, diff: 'THE DIFF' });
    expect(d.diffOf).toHaveBeenCalledWith(TASK);
  });

  it('send types the instruction into the task session', async () => {
    const d = deps();
    const res = await routeTaskControl(svcWith([TASK]), d, {
      op: 'send',
      id: 'a',
      text: 'keep going',
    });
    expect(res).toEqual({ ok: true });
    expect(d.sendToSession).toHaveBeenCalledWith('a:claude-cli:agent', 'keep going');
  });

  it('send requires non-empty text', async () => {
    const d = deps();
    const res = await routeTaskControl(svcWith([TASK]), d, { op: 'send', id: 'a', text: '  ' });
    expect(res.ok).toBe(false);
    expect(d.sendToSession).not.toHaveBeenCalled();
  });

  it('merge / discard call through to the service for a known task', async () => {
    const merge = vi.fn(async () => undefined);
    const discard = vi.fn(async () => undefined);
    const svc = svcWith([TASK], { merge, discard });
    expect((await routeTaskControl(svc, deps(), { op: 'merge', id: 'a' })).ok).toBe(true);
    expect(merge).toHaveBeenCalledWith('a');
    expect((await routeTaskControl(svc, deps(), { op: 'discard', id: 'a' })).ok).toBe(true);
    expect(discard).toHaveBeenCalledWith('a');
  });

  it('merge of an unknown task is a not-found error (no service call)', async () => {
    const merge = vi.fn(async () => undefined);
    const res = await routeTaskControl(svcWith([], { merge }), deps(), { op: 'merge', id: 'z' });
    expect(res).toEqual({ ok: false, error: 'task not found' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('rejects an unknown op', async () => {
    const res = await routeTaskControl(svcWith([]), deps(), { op: 'frob' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown op/);
  });
});
