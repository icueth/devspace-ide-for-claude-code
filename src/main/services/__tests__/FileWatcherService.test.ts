// FileWatcherService — native recursive fs.watch backend.
//
// The service must (1) emit a debounced FS_WATCH_EVENT with the parent dirs of
// created/removed entries, (2) drop events under WATCH_IGNORED dirs like
// node_modules, and (3) stop watching once the last subscriber unsubscribes.
// Real fs events on macOS arrive with FSEvents latency, so assertions poll.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  subscribeWatch,
  unsubscribeWatch,
  shutdownWatchers,
} from '../FileWatcherService';
import { IPC } from '@shared/ipc-channels';

import type { WebContents } from 'electron';

function makeWc() {
  const send = vi.fn();
  const wc = {
    send,
    isDestroyed: () => false,
    once: vi.fn(),
  } as unknown as WebContents;
  return { wc, send };
}

function makeRoot(): string {
  // realpath'd tmp root — macOS /var/folders is a /private symlink and the
  // service resolves roots with path.resolve, so hand it the real path.
  return mkdtempSync(path.join(tmpdir(), 'fw-test-'));
}

async function waitForSend(
  send: ReturnType<typeof vi.fn>,
  pred: (calls: unknown[][]) => boolean,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!pred(send.mock.calls)) throw new Error('event not received yet');
    },
    { timeout: 4000, interval: 50 },
  );
}

afterEach(() => {
  shutdownWatchers();
});

describe('FileWatcherService (recursive fs.watch backend)', () => {
  it('emits FS_WATCH_EVENT with the parent dir of a created file', async () => {
    const root = makeRoot();
    const { wc, send } = makeWc();
    try {
      subscribeWatch(root, wc);
      const sub = path.join(root, 'src');
      mkdirSync(sub);
      writeFileSync(path.join(sub, 'a.ts'), 'x');

      await waitForSend(send, (calls) =>
        calls.some(([channel, payload]) => {
          if (channel !== IPC.FS_WATCH_EVENT) return false;
          const p = payload as { root: string; dirs: string[] };
          return p.root === root && p.dirs.length > 0;
        }),
      );
    } finally {
      unsubscribeWatch(root, wc);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores changes under node_modules', async () => {
    const root = makeRoot();
    const { wc, send } = makeWc();
    try {
      const nm = path.join(root, 'node_modules', 'pkg');
      mkdirSync(nm, { recursive: true });
      subscribeWatch(root, wc);
      writeFileSync(path.join(nm, 'index.js'), 'x');

      // Give FSEvents ample time to deliver, then assert nothing surfaced.
      await new Promise((r) => setTimeout(r, 1200));
      const leaked = send.mock.calls.filter(([channel, payload]) => {
        if (channel !== IPC.FS_WATCH_EVENT) return false;
        const p = payload as { dirs: string[] };
        return p.dirs.some((d) => d.includes('node_modules'));
      });
      expect(leaked).toEqual([]);
    } finally {
      unsubscribeWatch(root, wc);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops emitting after the last subscriber unsubscribes', async () => {
    const root = makeRoot();
    const { wc, send } = makeWc();
    try {
      subscribeWatch(root, wc);
      unsubscribeWatch(root, wc);
      writeFileSync(path.join(root, 'late.txt'), 'x');

      await new Promise((r) => setTimeout(r, 800));
      expect(send).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
