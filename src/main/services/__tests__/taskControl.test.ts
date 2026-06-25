import { describe, expect, it, vi } from 'vitest';

import { routeTaskControl } from '../taskControl';
import type { TaskService } from '../TaskService';

type RouterSvc = Pick<TaskService, 'list' | 'create'>;

function svcWith(tasks: unknown[]): RouterSvc {
  return {
    list: () => tasks as ReturnType<TaskService['list']>,
    create: vi.fn(),
  };
}

describe('routeTaskControl', () => {
  it('lists tasks with a slim, stable shape', async () => {
    const svc = svcWith([
      { id: 'a', title: 'T', status: 'running', branch: 'b', sessionKey: 'x' },
    ]);
    const res = await routeTaskControl(svc, { op: 'list' });
    expect(res.ok).toBe(true);
    expect(res.tasks).toEqual([
      { id: 'a', title: 'T', status: 'running', branch: 'b' },
    ]);
  });

  it('rejects create with no title (before touching the workspace check)', async () => {
    const svc = svcWith([]);
    const res = await routeTaskControl(svc, { op: 'create', repo: '/x' });
    expect(res).toEqual({ ok: false, error: 'title required' });
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('rejects create with no repo', async () => {
    const svc = svcWith([]);
    const res = await routeTaskControl(svc, { op: 'create', title: 'hi' });
    expect(res).toEqual({ ok: false, error: 'repo required' });
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown op', async () => {
    const res = await routeTaskControl(svcWith([]), { op: 'frob' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown op/);
  });
});
