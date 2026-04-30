import { app, BrowserWindow, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
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

import { registerAppIpc } from '@main/ipc/app';
import { registerCodeflowIpc } from '@main/ipc/codeflow';
import { registerFsIpc } from '@main/ipc/fs';
import { registerGitIpc } from '@main/ipc/git';
import { registerPtyIpc } from '@main/ipc/pty';
import { registerSearchIpc } from '@main/ipc/search';
import { registerSettingsIpc } from '@main/ipc/settings';
import { registerTmuxIpc } from '@main/ipc/tmux';
import { registerWorkspaceIpc } from '@main/ipc/workspace';
import {
  resolveTmuxBinary,
  tmuxSocketArgs,
} from '@main/services/ClaudeCliLauncher';
import { shutdownWatchers } from '@main/services/FileWatcherService';
import { shutdownAll as shutdownPtyPool } from '@main/services/PtyPool';
import { getTmuxConfigSync } from '@main/services/TmuxConfigService';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';

declare const __APP_VERSION__: string;

const isDev = !app.isPackaged;

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
    },
  });

  // Strip noisy response headers Chromium adds to dev/file-loaded pages so
  // the devtools network tab stays readable during profiling.
  win.webContents.on('preload-error', (_e, preloadPathErr, error) => {
    console.error('[main] preload-error:', preloadPathErr, error.message);
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

app.whenReady().then(async () => {
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

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let exiting = false;
app.on('before-quit', (event) => {
  // node-pty's ThreadSafeFunction races with Node's Environment cleanup on
  // shutdown — the tsfn fires into a destroyed JS context and aborts the
  // process. Kill ptys explicitly, then hard-exit to bypass Node cleanup.
  if (exiting) return;
  exiting = true;
  event.preventDefault();
  try {
    shutdownPtyPool();
    shutdownWatchers();
    // Optionally tear down our tmux server when the user opts in. Safe — we
    // run on an isolated socket, so this never touches their other tmux work.
    const cfg = getTmuxConfigSync();
    if (cfg.killSessionsOnQuit) {
      void (async () => {
        try {
          const { spawn } = await import('node:child_process');
          const bin = (await resolveTmuxBinary()) ?? 'tmux';
          spawn(bin, [...tmuxSocketArgs(), 'kill-server'], {
            detached: true,
            stdio: 'ignore',
          }).unref();
        } catch {
          /* best-effort */
        }
      })();
    }
  } catch {
    /* swallow — nothing to do during shutdown */
  }
  setTimeout(() => app.exit(0), 120);
});

void __APP_VERSION__;
