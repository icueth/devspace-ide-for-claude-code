import { app, BrowserWindow, Menu, session, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as fs from 'node:fs';
import path from 'node:path';

// Packaged Electron launched from Finder has no attached TTY. If something
// holding the stdio pipe closes, subsequent console.* writes emit EPIPE and
// crash the main process. Swallow EPIPE on both streams so loggers can't
// bring down the app.
for (const stream of [process.stdout, process.stderr] as const) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
  });
}
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return;
  throw err;
});

// Chromium spawns the GPU/translation/crash-reporter sidecars on boot. Dropping
// unused features trims RAM and shaves ~50-150ms off startup.
app.commandLine.appendSwitch(
  'disable-features',
  'Translate,MediaRouter,HardwareMediaKeyHandling,GlobalMediaControls',
);

import { registerAgentsIpc } from '@main/ipc/agents';
import { registerAppIpc } from '@main/ipc/app';
import { registerBgClaudeIpc } from '@main/ipc/bgClaude';
import { registerTasksIpc } from '@main/ipc/tasks';
import { registerClaudeAuthIpc } from '@main/ipc/claudeAuth';
import { registerCliIpc } from '@main/ipc/cli';
import { registerCodeflowIpc } from '@main/ipc/codeflow';
import { registerDevServerIpc } from '@main/ipc/devserver';
import { registerForgeIpc } from '@main/ipc/forge';
import { registerFsIpc } from '@main/ipc/fs';
import { registerGitIpc } from '@main/ipc/git';
import { registerLlmIpc } from '@main/ipc/llm';
import { registerMcpIpc } from '@main/ipc/mcp';
import { registerMemoryIpc } from '@main/ipc/memory';
import { registerMempalaceIpc } from '@main/ipc/mempalace';
import { registerPreviewIpc } from '@main/ipc/preview';
import { registerSetupIpc } from '@main/ipc/setup';
import { registerSkillsIpc } from '@main/ipc/skills';
import { registerPtyIpc } from '@main/ipc/pty';
import { registerSearchIpc } from '@main/ipc/search';
import { registerSettingsIpc } from '@main/ipc/settings';
import { registerTmuxIpc } from '@main/ipc/tmux';
import { registerWorkspaceIpc } from '@main/ipc/workspace';
import {
  resolveTmuxBinary,
  tmuxSocketArgs,
} from '@main/services/ClaudeCliLauncher';
import { shutdownAll as shutdownDevServers } from '@main/services/DevServerService';
import { shutdownWatchers } from '@main/services/FileWatcherService';
import { shutdownPreviewWatchers } from '@main/services/PreviewService';
import { preloadLlmConfig } from '@main/services/LlmConfigService';
import { init as initMemory } from '@main/services/MemoryService';
import {
  configureIdleReaper,
  setPinnedSessions,
  shutdownAll as shutdownPtyPool,
  startIdleReaper,
  stopIdleReaper,
} from '@main/services/PtyPool';
import {
  getSeedingEnabled,
  seedBuiltinAgents,
  seedDesignSkills,
} from '@main/services/SkillSeedingService';
import { pruneStaleSessions as pruneStaleTmuxSessions } from '@main/services/TmuxChatRunner';
import {
  getTmuxConfigSync,
  loadTmuxConfig,
} from '@main/services/TmuxConfigService';
import { IPC } from '@shared/ipc-channels';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';

declare const __APP_VERSION__: string;

const isDev = !app.isPackaged;

// Every packaged build shares the same Chromium profile and tmux socket. Two
// main processes would therefore race on Local Storage (dock metadata) while
// attaching to the same CLI sessions. Keep multi-window support inside the
// primary process, but route a second app launch back to that process.
const hasSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      void createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

async function createWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, '../preload/index.cjs');

  // Cascade additional windows so they don't perfectly stack on the first.
  // This is purely cosmetic — the user can always drag — but it makes the
  // second window obviously distinct.
  const offset = BrowserWindow.getAllWindows().length * 32;
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    x: offset > 0 ? offset : undefined,
    y: offset > 0 ? offset : undefined,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // `spellcheck` spawns a per-locale dictionary service per editor input —
      // no value in a code editor and costs ~20MB resident.
      spellcheck: false,
      // Chromium throttles background tabs by default; this is a multi-window
      // IDE, so keep each renderer running at full speed even when its window
      // loses focus (so long-running Claude output keeps painting).
      backgroundThrottling: false,
      // v8 code cache reduces JS compile on second+ launch (boot 5-15% faster).
      v8CacheOptions: 'code',
      // Phase C: the Live Preview tab uses `<webview>` to host a sandboxed
      // pointer at a locally-spawned dev server (Vite/Next/etc). The
      // webview gets its own webPreferences (set on the element) so this
      // does NOT relax the host renderer — only enables <webview> tag
      // recognition in the React tree.
      webviewTag: true,
    },
  });

  // Strip noisy response headers Chromium adds to dev/file-loaded pages so
  // the devtools network tab stays readable during profiling.
  win.webContents.on('preload-error', (_e, preloadPathErr, error) => {
    console.error('[main] preload-error:', preloadPathErr, error.message);
  });

  // Self-heal: if the renderer ever wedges (e.g. a stale-cache compile loop),
  // clear the on-disk V8 code cache so the NEXT load comes up clean. We do NOT
  // auto-reload (that risks a loop) — the clear takes effect on the next launch.
  win.webContents.on('unresponsive', () => {
    console.error('[main] renderer unresponsive — clearing code cache for next load');
    void session.defaultSession.clearCodeCaches({ urls: [] }).catch(() => undefined);
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: 'right' });
  } else {
    await win.loadFile(path.join(__dirname, '../../out/renderer/index.html'));
  }

  // Renderer/preload console forwarding is only useful while debugging. In a
  // packaged build it just wastes IPC on every console call, so gate to dev.
  if (isDev) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win.webContents as any).on(
      'console-message',
      (_e: unknown, level: number, message: string, line: number, sourceId: string) => {
        const label = level >= 3 ? 'err' : level >= 2 ? 'warn' : level >= 1 ? 'info' : 'log';
        console.log(`[renderer:${label}] ${message} (${sourceId}:${line})`);
      },
    );
  }
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone:', details.reason, details.exitCode);
  });
  win.webContents.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[renderer] did-fail-load: ${errorCode} ${errorDescription} (${validatedURL})`,
      );
    },
  );
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          // macOS double-click on the dock icon only ever raises the existing
          // window — there's no built-in path to open a second one. This menu
          // item gives users an explicit way to spawn another window so they
          // can work on a different project side-by-side.
          label: 'New Window',
          accelerator: 'Shift+CmdOrCtrl+N',
          click: () => {
            void createWindow();
          },
        },
        { type: 'separator' },
        {
          // Rebind Cmd+W from "close window" to forwarding the shortcut to the
          // renderer, which closes the active editor tab. Cmd+Shift+W keeps the
          // original "close window" semantics as an escape hatch.
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, browserWindow) => {
            if (browserWindow instanceof BrowserWindow) {
              browserWindow.webContents.send('app:close-tab');
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Close Window',
          accelerator: 'Shift+CmdOrCtrl+W',
          role: 'close',
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : []),
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/**
 * Clear renderer caches when the app build changes. A V8 code cache (compiled
 * bytecode) or GPU cache written by a DIFFERENT build can wedge the renderer in
 * an endless compile/optimize loop on the new build — the symptom is a frozen
 * UI (Settings → Setup stuck on "Detecting…", confirmed on an upgraded install).
 * These are pure caches Chromium rebuilds; user state (Local Storage, Session
 * Storage, workspaces.json) is left untouched. Runs synchronously BEFORE the
 * first window so the stale cache is gone before the renderer loads.
 */
function clearStaleRendererCachesOnUpgrade(): void {
  try {
    const userData = app.getPath('userData');
    const verFile = path.join(userData, '.devspace-build-version');
    const current = app.getVersion();
    let last = '';
    try {
      last = fs.readFileSync(verFile, 'utf8').trim();
    } catch {
      // first run — no marker yet
    }
    if (last === current) return; // same build: keep caches for a fast boot
    for (const d of [
      'Code Cache',
      'GPUCache',
      'Cache',
      'DawnWebGPUCache',
      'DawnGraphiteCache',
    ]) {
      try {
        fs.rmSync(path.join(userData, d), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(verFile, current, 'utf8');
    } catch {
      // best-effort
    }
    console.log(
      `[main] cleared renderer caches on build change: ${last || '(fresh)'} -> ${current}`,
    );
  } catch (err) {
    console.error(
      '[main] clearStaleRendererCachesOnUpgrade failed:',
      (err as Error).message,
    );
  }
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  // Stale V8 code cache from a previous build can wedge the renderer in a
  // compile loop (frozen UI) — clear it before the first window loads.
  clearStaleRendererCachesOnUpgrade();

  // Pre-warm shell env so the first PTY spawn doesn't pay the cost.
  void resolveInteractiveShellEnv().catch(() => undefined);

  Menu.setApplicationMenu(buildMenu());

  registerAppIpc();
  registerWorkspaceIpc();
  registerFsIpc();
  registerGitIpc();
  registerPtyIpc();
  registerSearchIpc();
  registerSettingsIpc();
  registerTmuxIpc();
  registerCodeflowIpc();
  registerLlmIpc();
  registerCliIpc();
  registerAgentsIpc();
  registerMcpIpc();
  registerSkillsIpc();
  registerDevServerIpc();
  registerPreviewIpc();
  registerMemoryIpc();
  registerClaudeAuthIpc();
  registerForgeIpc();
  registerMempalaceIpc();
  registerSetupIpc();
  registerBgClaudeIpc();
  registerTasksIpc();

  // Warm the memory index in the background so the dashboard doesn't
  // pay the walk cost on first open. ensureInit() is idempotent — every
  // memory handler awaits it internally, so this is purely an early
  // start.
  void initMemory().catch((err) => {
    console.error('[main] memory init failed:', (err as Error).message);
  });

  // Seed bundled design skills (132) + design-systems (150) into
  // ~/.claude/skills so the Claude Code CLI can DISCOVER them — it only
  // looks under ~/.claude + project, never inside the .app bundle.
  // Idempotent + version-stamped + never clobbers user-authored skills.
  // Background + best-effort: never blocks boot, never throws.
  void getSeedingEnabled()
    .then((enabled) => {
      void seedDesignSkills({ enabled })
        .then((r) => {
          if (r.status === 'seeded') {
            console.log(
              `[main] design skills seeded: ${r.seededSkills} skills + ${r.seededSystems} systems` +
                (r.skippedCollisions.length
                  ? ` (kept ${r.skippedCollisions.length} user skills)`
                  : ''),
            );
          }
        })
        .catch((err) => {
          console.error(
            '[main] design skill seeding failed:',
            (err as Error).message,
          );
        });
      void seedBuiltinAgents({ enabled })
        .then((r) => {
          if (r.status === 'seeded') {
            console.log(
              `[main] agents seeded: ${r.seededAgents}` +
                (r.skippedCollisions.length
                  ? ` (kept ${r.skippedCollisions.length} user agents)`
                  : ''),
            );
          }
        })
        .catch((err) => {
          console.error(
            '[main] agent seeding failed:',
            (err as Error).message,
          );
        });
    })
    .catch((err) => {
      console.error('[main] seeding-pref read failed:', (err as Error).message);
    });

  // Pre-warm the LLM config cache so the first autocomplete tick doesn't
  // pay the I/O cost. Best-effort and never throws.
  preloadLlmConfig();

  // v0.36.0: start the idle-CLI-tab reaper. Each victim is torn down via
  // killClaudeCliSessionTree — process-group kill on the PTY child plus
  // `tmux kill-session` — because with tmux enabled the PTY child is only
  // the attach client; the kill-session is what actually frees claude +
  // every MCP server child (~400 MB per tab on average). We load the
  // persisted tmux config so the user's saved preferences (toggle off,
  // custom timeout) are honored on boot; the reaper never blocks app start.
  void loadTmuxConfig()
    .then((cfg) => {
      configureIdleReaper({
        enabled: cfg.autoCloseIdleCliTabs ?? false,
        thresholdMinutes: cfg.idleCliTabTimeoutMinutes ?? 120,
        unpinnedThresholdMinutes: cfg.unpinnedCliTabTimeoutMinutes ?? 10,
      });
      startIdleReaper((ids, mins) => {
        // Fan the event out to every renderer window — multi-window users
        // have a CLI dock in each, so all of them need to react.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC.PTY_AUTO_CLOSED, {
              ids,
              thresholdMinutes: mins,
            });
          }
        }
      });
    })
    .catch((err) => {
      console.error(
        '[main] idle reaper boot failed:',
        (err as Error).message,
      );
    });

  // Prune stale chat-run tmux sessions (devspace-chatrun-*, which covers
  // chat turns AND design generations) older than 2 days — without this, a
  // user who runs DevSpace daily ends up with hundreds of dead sessions
  // over a month. CLI/shell sessions are deliberately NOT pruned: their
  // cross-restart survival is the persistence feature, and session_created
  // doesn't reset on reattach. Deferred 5s so the renderer mounts first.
  setTimeout(() => {
    void pruneStaleTmuxSessions().catch((err) => {
      console.error('[main] tmux prune failed:', (err as Error).message);
    });
  }, 5000);

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let exiting = false;
// Hard ceiling on how long we'll block app exit waiting for PTY shutdown.
// Killing the whole tree usually takes <300ms; this is the upper bound
// before we hard-exit and let the OS reap any survivors.
const EXIT_TIMEOUT_MS = 2500;

app.on('before-quit', (event) => {
  // node-pty's ThreadSafeFunction races with Node's Environment cleanup on
  // shutdown — the tsfn fires into a destroyed JS context and aborts the
  // process. Kill ptys explicitly, then hard-exit to bypass Node cleanup.
  if (exiting) return;
  exiting = true;
  event.preventDefault();

  // Mark each dev-server state as 'stopped' BEFORE the PTY pool kills
  // the underlying processes so the resulting onExit handlers
  // short-circuit instead of firing spurious 'crashed' events on quit.
  // The two shutdowns return promises — we await them so node/vite child
  // workers are actually gone before app.exit() pulls the rug out.
  // v0.36.0: stop the idle reaper FIRST so a tick can't race the shutdown
  // path and try to kill an already-killed PTY mid-teardown.
  try {
    stopIdleReaper();
  } catch {
    /* best-effort */
  }
  const shutdownTask = (async () => {
    try {
      await Promise.all([
        shutdownDevServers(),
        shutdownPtyPool(),
      ]);
    } catch {
      /* best-effort during shutdown */
    }
    try {
      shutdownWatchers();
    } catch {
      /* best-effort */
    }
    try {
      shutdownPreviewWatchers();
    } catch {
      /* best-effort */
    }
    // Optionally tear down our tmux server when the user opts in. Safe — we
    // run on an isolated socket, so this never touches their other tmux work.
    try {
      const cfg = getTmuxConfigSync();
      if (cfg.killSessionsOnQuit) {
        const { spawn } = await import('node:child_process');
        const bin = (await resolveTmuxBinary()) ?? 'tmux';
        spawn(bin, [...tmuxSocketArgs(), 'kill-server'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      }
    } catch {
      /* best-effort */
    }
  })();

  // Race the shutdown task against EXIT_TIMEOUT_MS. Whichever finishes
  // first triggers app.exit — we never block the user from quitting.
  Promise.race([
    shutdownTask,
    new Promise<void>((r) => setTimeout(r, EXIT_TIMEOUT_MS)),
  ]).then(() => app.exit(0), () => app.exit(0));
});

void __APP_VERSION__;
