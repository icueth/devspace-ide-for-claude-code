// PreviewService — function-only service backing the HTML Preview tab.
//
// v0.31: After the Design Studio teardown, design generation is done by
// Claude itself (via bundled design skills). Claude writes standalone,
// self-contained HTML to `<project>/.devspace/preview/<name>.html`. This
// service:
//   * `list(projectPath)`       — enumerate `*.html` directly under the
//                                 project's `.devspace/preview/` dir.
//   * `readHtml(projectPath, p)`— read one preview file with hard path-
//                                 containment + symlink + size guards.
//   * `subscribe(projectPath, wc)` — start a chokidar watcher scoped to
//                                 `*.html` (depth 0) and stream
//                                 add/change/unlink events to the renderer.
//
// Design parallels DevServerService / FileWatcherService:
//   * In-memory `Map<projectPath, Entry>` keyed by resolved project path,
//     each holding one chokidar FSWatcher + a `Set<WebContents>` of
//     subscribers.
//   * A single-shot `wc.once('destroyed')` hook per WebContents (guarded by
//     a module WeakSet) so dead renderers stop receiving events and idle
//     watchers are torn down.
//   * No class, only named function exports. Logger from `@shared/logger`.

import chokidar, { type FSWatcher } from 'chokidar';
import type { WebContents } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type { PreviewChangedEvent, PreviewFileInfo } from '@shared/preview';

const logger = createLogger('PreviewService');

// Cap a single preview file at 5MB. A self-contained HTML page (inline CSS,
// CDN <script> tags) is realistically <1MB; the cap stops a renderer-side
// bug (or a hostile file dropped into the dir) from forcing a huge read into
// main-process memory and across the IPC bridge.
const MAX_HTML_BYTES = 5 * 1024 * 1024;

/** `<projectPath>/.devspace/preview` — resolved. */
export function previewDirFor(projectPath: string): string {
  return path.resolve(projectPath, '.devspace', 'preview');
}

function isHtml(name: string): boolean {
  return name.toLowerCase().endsWith('.html');
}

// ─── list ────────────────────────────────────────────────────────────────

/**
 * Return `*.html` files directly under `<projectPath>/.devspace/preview/`,
 * sorted by mtime descending (newest first). Returns `[]` when the directory
 * is missing — a project that has never had a preview generated is not an
 * error. Non-`.html` entries, subdirectories, and symlinks are skipped.
 */
export async function list(projectPath: string): Promise<PreviewFileInfo[]> {
  const dir = previewDirFor(projectPath);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`failed to read ${dir}: ${(err as Error).message}`);
    }
    return [];
  }

  const out: PreviewFileInfo[] = [];
  for (const e of entries) {
    // Only regular files matter. `withFileTypes` reports symlinks as their
    // own kind (isSymbolicLink) so a symlinked entry is skipped here too.
    if (!e.isFile()) continue;
    if (!isHtml(e.name)) continue;
    const abs = path.join(dir, e.name);
    try {
      const st = await fs.promises.stat(abs);
      out.push({ path: abs, name: e.name, mtime: st.mtimeMs });
    } catch {
      // Raced unlink between readdir and stat — skip silently.
    }
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ─── readHtml ──────────────────────────────────────────────────────────────

/**
 * Read and return the contents of a preview HTML file.
 *
 * Security (mirrors fs/codeflow IPC guards):
 *   1. Resolve `htmlPath` and assert it is contained within the project's
 *      `.devspace/preview/` directory — rejects `..` traversal and any
 *      absolute path pointing elsewhere.
 *   2. `lstat` and reject symlinks (and non-regular files) so a symlink
 *      planted in the preview dir can't redirect the read to e.g. `~/.ssh`.
 *   3. Reject files larger than MAX_HTML_BYTES.
 *
 * Throws on any violation rather than returning partial / unsafe content.
 */
export async function readHtml(
  projectPath: string,
  htmlPath: string,
): Promise<string> {
  if (typeof htmlPath !== 'string' || htmlPath.length === 0) {
    throw new Error('htmlPath must be a non-empty string');
  }
  if (htmlPath.includes('\0')) {
    throw new Error('htmlPath contains null byte');
  }

  const dir = previewDirFor(projectPath);
  const resolved = path.resolve(htmlPath);

  // Containment: resolved must be a direct child of, or nested under, the
  // preview dir. Compare against `dir + sep` so a sibling directory whose
  // name merely starts with the preview dir's name (e.g. `preview-evil/`)
  // can't slip through a naive prefix check.
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error(`preview path outside .devspace/preview/: ${htmlPath}`);
  }

  // Only ever hand back `.html`. The renderer only asks for files this
  // service listed, but the channel must not become a generic file-read
  // primitive for anything that happens to live under the preview dir.
  if (!isHtml(resolved)) {
    throw new Error(`preview path is not an .html file: ${htmlPath}`);
  }

  // Defeat symlink ambushes — lstat does NOT follow the final component.
  const st = await fs.promises.lstat(resolved);
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to read symlinked preview file: ${htmlPath}`);
  }
  if (!st.isFile()) {
    throw new Error(`refusing non-regular preview file: ${htmlPath}`);
  }
  if (st.size > MAX_HTML_BYTES) {
    throw new Error(
      `preview file too large (${st.size} bytes, max ${MAX_HTML_BYTES})`,
    );
  }

  return fs.promises.readFile(resolved, 'utf8');
}

// ─── subscribe / watcher lifecycle ──────────────────────────────────────────

interface Entry {
  watcher: FSWatcher;
  subscribers: Set<WebContents>;
  /** Resolves when chokidar finishes its initial scan ('ready'). Used by
   *  tests to avoid the add/initial-scan race; production ignores it. */
  ready: Promise<void>;
}

const watchers = new Map<string, Entry>();

// Single-shot destroy hook per WebContents. Without this guard, every
// subscribe() call would attach a fresh `wc.once('destroyed')` listener,
// stacking N listeners and firing cleanup N times. Mirrors the pattern in
// FileWatcherService / DevServerService / CodeflowService.
const wcDestroyHooks = new WeakSet<WebContents>();

function keyFor(projectPath: string): string {
  return path.resolve(projectPath);
}

function emit(
  entry: Entry,
  projectPath: string,
  kind: PreviewChangedEvent['kind'],
  filePath: string,
  mtime: number,
): void {
  const event: PreviewChangedEvent = {
    projectPath,
    file: { path: filePath, name: path.basename(filePath), mtime },
    kind,
  };
  for (const wc of entry.subscribers) {
    if (!wc.isDestroyed()) {
      // Wire shape matches the preload listener: `{ projectPath, event }`.
      wc.send(IPC.PREVIEW_CHANGED, { projectPath, event });
    }
  }
}

/**
 * Start watching a project's `.devspace/preview/` directory for `*.html`
 * add/change/unlink and stream PREVIEW_CHANGED to `wc`. Idempotent per
 * (project, webContents) — a repeat call for an already-subscribed pair is a
 * no-op. Subscribing before any preview has been generated is fine — the
 * directory is created lazily so the watcher always has a real path to watch
 * (chokidar v4 does NOT detect a watched path that is created later, so we
 * must ensure it exists up front).
 */
export function subscribe(projectPath: string, wc: WebContents): void {
  const key = keyFor(projectPath);
  const dir = previewDirFor(key);

  let entry = watchers.get(key);
  if (!entry) {
    // Ensure the preview dir exists before watching. chokidar v4 will not
    // pick up a directory that springs into existence after `watch()` is
    // called, so a fresh project (no preview yet) would otherwise watch a
    // dead path. Creating an empty `.devspace/preview/` is harmless and
    // guarantees Claude's first generated file is detected. Best-effort:
    // never let an mkdir failure crash the subscribe path.
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      logger.warn(
        `could not create preview dir ${dir}: ${(err as Error).message}`,
      );
    }

    // chokidar v4 dropped glob support, so we watch the preview DIRECTORY
    // directly with `depth: 0` (no recursion into any subfolder Claude might
    // create) and filter to top-level `*.html` in the event handlers below.
    // `ignoreInitial` suppresses a burst of synthetic 'add' events for files
    // that already exist on subscribe; the renderer fetches the initial set
    // via list().
    const watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      persistent: true,
      depth: 0,
      // Tests set DEVSPACE_WATCH_POLLING=1 so the watcher is deterministic
      // and doesn't depend on macOS fsevents arming latency. Production
      // leaves this unset and uses the OS-native backend.
      usePolling: process.env.DEVSPACE_WATCH_POLLING === '1',
      interval: 50,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
    });

    const ready = new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
    });
    entry = { watcher, subscribers: new Set(), ready };
    watchers.set(key, entry);

    const onAddOrChange = (kind: 'add' | 'change') => (changedPath: string) => {
      const e = watchers.get(key);
      if (!e) return;
      // Defensive: ignore anything that isn't a top-level *.html — a future
      // change to the watch root shouldn't be able to leak non-html or
      // nested directory events to the renderer.
      if (!isHtml(changedPath)) return;
      if (path.dirname(path.resolve(changedPath)) !== dir) return;
      fs.promises
        .stat(changedPath)
        .then((st) => emit(e, key, kind, path.resolve(changedPath), st.mtimeMs))
        .catch(() => {
          // File vanished between event and stat — treat as no-op; an
          // 'unlink' will follow.
        });
    };

    watcher.on('add', onAddOrChange('add'));
    watcher.on('change', onAddOrChange('change'));
    watcher.on('unlink', (changedPath: string) => {
      const e = watchers.get(key);
      if (!e) return;
      if (!isHtml(changedPath)) return;
      if (path.dirname(path.resolve(changedPath)) !== dir) return;
      // The file is gone, so there's no mtime to stat — use 0. The renderer
      // keys off `kind === 'unlink'` to close/remove the tab.
      emit(e, key, 'unlink', path.resolve(changedPath), 0);
    });

    watcher.on('error', (err) => {
      logger.warn(`preview watcher error for ${dir}:`, (err as Error).message);
    });

    logger.info(`watching preview dir ${dir}`);
  }

  entry.subscribers.add(wc);

  if (!wcDestroyHooks.has(wc)) {
    wcDestroyHooks.add(wc);
    wc.once('destroyed', () => {
      // Iterate a snapshot — we mutate `watchers` while looping.
      for (const [k, e] of Array.from(watchers)) {
        if (e.subscribers.has(wc)) {
          e.subscribers.delete(wc);
          if (e.subscribers.size === 0) {
            void e.watcher.close().catch(() => undefined);
            watchers.delete(k);
            logger.info(`stopped watching preview dir ${previewDirFor(k)}`);
          }
        }
      }
    });
  }
}

/** Tear down every preview watcher. Called on app shutdown. */
export function shutdownPreviewWatchers(): void {
  for (const [, e] of watchers) {
    void e.watcher.close().catch(() => undefined);
  }
  watchers.clear();
}

// Test-only: reset module state between cases (mirrors DevlogService's
// `__resetForTests`). Production code never calls this.
export function __resetForTests(): void {
  shutdownPreviewWatchers();
}

// Test-only: await the initial chokidar scan for a project's watcher so a
// test can write files AFTER the watcher is armed and reliably observe
// 'add' (rather than racing the initial scan). Resolves immediately if no
// watcher exists. Production code never calls this.
export async function __whenReady(projectPath: string): Promise<void> {
  const entry = watchers.get(keyFor(projectPath));
  if (entry) await entry.ready;
}
