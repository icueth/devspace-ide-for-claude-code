// Force chokidar into polling mode so watcher tests don't flake on macOS
// fsevents arming latency. Must be set before PreviewService is imported /
// a watcher is created. The service reads this at subscribe() time.
process.env.DEVSPACE_WATCH_POLLING = '1';

import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetForTests,
  __whenReady,
  list,
  previewDirFor,
  readHtml,
  subscribe,
  unsubscribe,
} from '@main/services/PreviewService';
import { IPC } from '@shared/ipc-channels';

// PreviewService talks to Electron only through a WebContents shape
// (send / isDestroyed / once('destroyed')). We fake that with a tiny
// EventEmitter so the watcher tests can assert PREVIEW_CHANGED payloads
// without an Electron app context. chokidar is real — the watcher tests
// poll until the expected event lands.

interface SentMessage {
  channel: string;
  payload: { projectPath: string; event: unknown };
}

class FakeWebContents extends EventEmitter {
  sent: SentMessage[] = [];
  private destroyed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(channel: string, payload: any): void {
    this.sent.push({ channel, payload });
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` until it returns truthy or the deadline passes. Generous
 *  timeout because macOS fsevents can take a second or two to arm a fresh
 *  watcher, especially when the serial suite churns many watchers. */
async function until<T>(fn: () => T, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return v;
    await wait(40);
  }
}

let tmp = '';
let project = '';

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devspace-preview-'));
  project = path.join(tmp, 'project');
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  __resetForTests();
  await rm(tmp, { recursive: true, force: true });
});

describe('PreviewService.list', () => {
  it('returns [] when the preview dir is missing', async () => {
    expect(await list(project)).toEqual([]);
  });

  it('lists only *.html and filters non-html / subdirs, sorted by mtime desc', async () => {
    const dir = previewDirFor(project);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'old.html'), '<h1>old</h1>');
    await wait(20);
    await writeFile(path.join(dir, 'new.html'), '<h1>new</h1>');
    // Non-html files must be ignored.
    await writeFile(path.join(dir, 'notes.txt'), 'ignore me');
    await writeFile(path.join(dir, 'data.json'), '{}');
    // Subdirectories must be ignored even if they end in .html.
    await mkdir(path.join(dir, 'nested.html'), { recursive: true });

    const files = await list(project);
    expect(files.map((f) => f.name)).toEqual(['new.html', 'old.html']);
    expect(files[0]!.path).toBe(path.join(dir, 'new.html'));
    expect(typeof files[0]!.mtime).toBe('number');
    // Newest first.
    expect(files[0]!.mtime).toBeGreaterThanOrEqual(files[1]!.mtime);
  });
});

describe('PreviewService.readHtml', () => {
  it('reads a contained html file', async () => {
    const dir = previewDirFor(project);
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, 'page.html');
    await writeFile(p, '<!doctype html><title>ok</title>');
    expect(await readHtml(project, p)).toContain('<title>ok</title>');
  });

  it('rejects path traversal outside the preview dir', async () => {
    const dir = previewDirFor(project);
    await mkdir(dir, { recursive: true });
    const escape = path.join(dir, '..', '..', 'secret.html');
    await writeFile(path.resolve(escape), '<h1>secret</h1>');
    await expect(readHtml(project, escape)).rejects.toThrow(
      /outside .devspace\/preview/,
    );
  });

  it('rejects an absolute path pointing elsewhere', async () => {
    const outside = path.join(tmp, 'elsewhere.html');
    await writeFile(outside, '<h1>nope</h1>');
    await expect(readHtml(project, outside)).rejects.toThrow(
      /outside .devspace\/preview/,
    );
  });

  it('rejects a symlinked preview file', async () => {
    const dir = previewDirFor(project);
    await mkdir(dir, { recursive: true });
    const target = path.join(tmp, 'target.html');
    await writeFile(target, '<h1>linked</h1>');
    const link = path.join(dir, 'link.html');
    await symlink(target, link);
    await expect(readHtml(project, link)).rejects.toThrow(/symlink/);
  });

  it('rejects non-.html files even when contained', async () => {
    const dir = previewDirFor(project);
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, 'evil.js');
    await writeFile(p, 'alert(1)');
    await expect(readHtml(project, p)).rejects.toThrow(/not an .html file/);
  });

  it('rejects files over the 5MB cap', async () => {
    const dir = previewDirFor(project);
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, 'big.html');
    await writeFile(p, 'x'.repeat(5 * 1024 * 1024 + 1));
    await expect(readHtml(project, p)).rejects.toThrow(/too large/);
  });
});

// Helpers to read event kind/file from a captured message.
const kindOf = (m: SentMessage): string => (m.payload.event as any).kind;
const fileOf = (m: SentMessage): { name: string; mtime: number } =>
  (m.payload.event as any).file;

// Each watcher test gets a generous per-test timeout — these exercise real
// filesystem watching and the poll/scan cycle takes a beat. `__whenReady`
// gates writes on the initial scan so 'add' is observed (not folded into the
// initial scan and suppressed by ignoreInitial).
const WATCH_TIMEOUT = 15000;

describe('PreviewService.subscribe (watcher)', () => {
  it(
    'emits add / change / unlink for *.html',
    async () => {
      const dir = previewDirFor(project);
      await mkdir(dir, { recursive: true });
      const wc = new FakeWebContents();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe(project, wc as any);
      await __whenReady(project);

      const file = path.join(dir, 'landing.html');

      // add
      await writeFile(file, '<h1>v1</h1>');
      await until(() => wc.sent.some((m) => kindOf(m) === 'add'));
      const addEvt = wc.sent.find((m) => kindOf(m) === 'add');
      expect(addEvt).toBeDefined();
      expect(addEvt!.channel).toBe(IPC.PREVIEW_CHANGED);
      expect(addEvt!.payload.projectPath).toBe(path.resolve(project));
      expect(fileOf(addEvt!).name).toBe('landing.html');
      expect(typeof fileOf(addEvt!).mtime).toBe('number');
      expect(fileOf(addEvt!).mtime).toBeGreaterThan(0);

      // change
      await wait(150);
      await writeFile(file, '<h1>v2 modified content</h1>');
      await until(() => wc.sent.some((m) => kindOf(m) === 'change'));
      expect(wc.sent.some((m) => kindOf(m) === 'change')).toBe(true);

      // unlink
      await rm(file);
      await until(() => wc.sent.some((m) => kindOf(m) === 'unlink'));
      const unlinkEvt = wc.sent.find((m) => kindOf(m) === 'unlink');
      expect(unlinkEvt).toBeDefined();
      expect(fileOf(unlinkEvt!).name).toBe('landing.html');
    },
    WATCH_TIMEOUT,
  );

  it(
    'does not emit for non-html files',
    async () => {
      const dir = previewDirFor(project);
      await mkdir(dir, { recursive: true });
      const wc = new FakeWebContents();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe(project, wc as any);
      await __whenReady(project);

      await writeFile(path.join(dir, 'notes.txt'), 'hello');
      await writeFile(path.join(dir, 'data.json'), '{}');
      // A real html file gives us a positive event to wait on.
      await writeFile(path.join(dir, 'real.html'), '<h1>real</h1>');
      await until(() => wc.sent.some((m) => kindOf(m) === 'add'));

      const names = wc.sent.map((m) => fileOf(m).name);
      expect(names).toContain('real.html');
      expect(names).not.toContain('notes.txt');
      expect(names).not.toContain('data.json');
    },
    WATCH_TIMEOUT,
  );

  it(
    'is idempotent per (project, webContents)',
    async () => {
      const dir = previewDirFor(project);
      await mkdir(dir, { recursive: true });
      const wc = new FakeWebContents();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe(project, wc as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe(project, wc as any);
      await __whenReady(project);

      await writeFile(path.join(dir, 'one.html'), '<h1>one</h1>');
      await until(() => wc.sent.some((m) => kindOf(m) === 'add'));
      // Give any duplicate delivery a chance to show up before counting.
      await wait(200);

      const adds = wc.sent.filter((m) => kindOf(m) === 'add');
      // A double subscribe must not double-deliver — one watcher, one
      // subscriber entry, so exactly one 'add' for the single file.
      expect(adds).toHaveLength(1);
    },
    WATCH_TIMEOUT,
  );

  it(
    'creates preview/ and detects the first file when .devspace already exists',
    async () => {
      // The project opted into .devspace (e.g. devlog), but no preview yet.
      await mkdir(path.join(project, '.devspace'), { recursive: true });
      const dir = previewDirFor(project);
      await expect(stat(dir)).rejects.toBeTruthy();

      const wc = new FakeWebContents();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => subscribe(project, wc as any)).not.toThrow();
      // subscribe() created preview/ so the watcher has a real path to
      // watch (chokidar v4 can't arm on a missing dir).
      await expect(stat(dir)).resolves.toBeTruthy();
      await __whenReady(project);

      // Claude's first generated file is detected.
      await writeFile(path.join(dir, 'late.html'), '<h1>late</h1>');
      const got = await until(() =>
        wc.sent.some((m) => fileOf(m).name === 'late.html'),
      );
      expect(got).toBe(true);
    },
    WATCH_TIMEOUT,
  );

  it('skips both mkdir and watcher for projects without .devspace', async () => {
    // A repo the user merely clicked once must NOT be dirtied with an empty
    // .devspace/preview/. No .devspace → subscribe is a silent no-op; a
    // later activation re-subscribes once .devspace exists.
    const wc = new FakeWebContents();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => subscribe(project, wc as any)).not.toThrow();
    await expect(stat(path.join(project, '.devspace'))).rejects.toBeTruthy();
    await expect(stat(previewDirFor(project))).rejects.toBeTruthy();
    // No watcher entry → __whenReady resolves immediately (nothing armed).
    await __whenReady(project);
  });

  it(
    'stops delivering after the webContents is destroyed',
    async () => {
      const dir = previewDirFor(project);
      await mkdir(dir, { recursive: true });
      const wc = new FakeWebContents();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe(project, wc as any);
      await __whenReady(project);
      wc.destroy();

      await writeFile(path.join(dir, 'after.html'), '<h1>after</h1>');
      await wait(600);
      expect(wc.sent).toHaveLength(0);
    },
    WATCH_TIMEOUT,
  );
});

describe('PreviewService.unsubscribe', () => {
  it('is an idempotent no-op when no watcher exists', () => {
    const wc = new FakeWebContents();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => unsubscribe(project, wc as any)).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => unsubscribe(project, wc as any)).not.toThrow();
  });

  it(
    'stops delivery once the last subscriber unsubscribes (watcher closed)',
    async () => {
      const dir = previewDirFor(project);
      await mkdir(dir, { recursive: true });
      const wc = new FakeWebContents();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe(project, wc as any);
      await __whenReady(project);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsubscribe(project, wc as any);

      await writeFile(path.join(dir, 'after-unsub.html'), '<h1>x</h1>');
      await wait(600);
      expect(wc.sent).toHaveLength(0);
    },
    WATCH_TIMEOUT,
  );

  it(
    'keeps the watcher alive for remaining subscribers',
    async () => {
      const dir = previewDirFor(project);
      await mkdir(dir, { recursive: true });
      const wcA = new FakeWebContents();
      const wcB = new FakeWebContents();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe(project, wcA as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe(project, wcB as any);
      await __whenReady(project);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      unsubscribe(project, wcA as any);

      await writeFile(path.join(dir, 'still-watched.html'), '<h1>b</h1>');
      await until(() => wcB.sent.some((m) => kindOf(m) === 'add'));
      expect(wcB.sent.some((m) => fileOf(m).name === 'still-watched.html')).toBe(
        true,
      );
      expect(wcA.sent).toHaveLength(0);
    },
    WATCH_TIMEOUT,
  );
});

// Keep vi referenced even though we rely on real timers/fs here.
void vi;
