/**
 * Regression tests for CodeflowGraphLive (Phase 1 / v0.33) — focused on the
 * concurrent-subscribe lifecycle that the Wave-2 review flagged: a second
 * subscriber that arrives while the first build is in flight must NOT poll
 * forever when that build fails (it must reject), and must resolve when it
 * succeeds.
 *
 * buildGraph + onAnyChange are mocked so no real filesystem walk happens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeflowGraph } from '@shared/types';

// Controllable buildGraph: each test installs a deferred so we can resolve or
// reject the in-flight build deterministically.
let buildDeferred: {
  promise: Promise<CodeflowGraph>;
  resolve: (g: CodeflowGraph) => void;
  reject: (e: Error) => void;
};

function freshDeferred(): typeof buildDeferred {
  let resolve!: (g: CodeflowGraph) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<CodeflowGraph>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

vi.mock('@main/services/CodeflowGraphAnalyzer', () => ({
  buildGraph: vi.fn(() => buildDeferred.promise),
}));

vi.mock('@main/services/FileWatcherService', () => ({
  // Return a no-op unsubscribe so ensureWatcherRegistered + teardown work.
  onAnyChange: vi.fn(() => () => undefined),
}));

import {
  disposeProject,
  subscribeGraph,
  teardown,
} from '@main/services/CodeflowGraphLive';

function fakeWc(): Electron.WebContents {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
  } as unknown as Electron.WebContents;
}

const PROJECT = '/tmp/codeflow-live-test-project';

function emptyGraph(): CodeflowGraph {
  return {
    nodes: [],
    edges: [],
    stats: {
      totalFiles: 0,
      totalLines: 0,
      totalEdges: 0,
      languages: [],
      truncated: false,
      elapsedMs: 1,
      importsParsed: 0,
      importsResolved: 0,
      aliasCount: 0,
      fingerprint: 'deadbeef',
    },
  };
}

beforeEach(() => {
  buildDeferred = freshDeferred();
});

afterEach(() => {
  teardown();
  vi.clearAllMocks();
});

describe('CodeflowGraphLive concurrent subscribe', () => {
  it('rejects a concurrent subscriber when the in-flight build fails (no infinite poll)', async () => {
    const subA = subscribeGraph(PROJECT, fakeWc());
    // Second subscriber arrives while the first build is still pending →
    // takes the poll-wait branch.
    const subB = subscribeGraph(PROJECT, fakeWc());

    // Both must settle as rejections rather than hanging.
    const settledA = expect(subA).rejects.toThrow('boom');
    const settledB = expect(subB).rejects.toThrow(/build failed/i);

    buildDeferred.reject(new Error('boom'));

    await settledA;
    await settledB;
  });

  it('resolves a concurrent subscriber with the graph when the build succeeds', async () => {
    const graph = emptyGraph();
    const subA = subscribeGraph(PROJECT, fakeWc());
    const subB = subscribeGraph(PROJECT, fakeWc());

    buildDeferred.resolve(graph);

    await expect(subA).resolves.toBe(graph);
    await expect(subB).resolves.toBe(graph);
  });

  it('rejects a pending poll when the project is disposed mid-build', async () => {
    const subA = subscribeGraph(PROJECT, fakeWc());
    const subB = subscribeGraph(PROJECT, fakeWc());

    const settledB = expect(subB).rejects.toThrow(/disposed/i);
    disposeProject(PROJECT);

    await settledB;
    // subA's own await rejects once the (now-orphaned) build settles; resolve
    // it so the promise doesn't dangle as an unhandled rejection.
    buildDeferred.resolve(emptyGraph());
    await subA.catch(() => undefined);
  });
});
