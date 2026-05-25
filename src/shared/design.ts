// ─── Live Preview dev-server types ──────────────────────────────────────────
//
// The Live Preview tab points a `<webview>` at a locally-spawned dev server
// (Vite / Next / Astro / Remix / …). The main process detects the framework,
// runs the user's `dev` script through the existing PtyPool, parses the
// emitted local URL, and exposes lifecycle events. The renderer mounts a
// `<webview>` with that URL — a pure viewer (no inspect/edit overlay).
//
// (Historically this file also carried the now-removed "Design Studio"
// generator types; only the dev-server surface remains.)

export type DevServerKind =
  | 'vite'        // vite in deps + vite.config.*
  | 'next'        // next in deps + next.config.*
  | 'astro'       // astro in deps + astro.config.*
  | 'remix'       // @remix-run/* in deps + remix.config.*
  | 'sveltekit'   // @sveltejs/kit in deps + svelte.config.*
  | 'nuxt'        // nuxt in deps + nuxt.config.*
  | 'gatsby'      // gatsby in deps + gatsby-config.*
  | 'angular'     // @angular/cli in deps + angular.json
  | 'vue-cli'     // @vue/cli-service in deps + vue.config.*
  | 'cra'         // react-scripts in deps
  | 'storybook'   // storybook in deps + .storybook/ dir
  | 'vitepress'   // vitepress in deps
  | 'docusaurus'  // @docusaurus/core in deps
  | 'static'      // serve/http-server/live-server/browser-sync — generic static
  | 'unknown';    // fallback — user can supply manual URL or custom command

export type DevServerStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'error';

export interface DevServerInfo {
  // Detection result, even when the server isn't running. Used to decide
  // which "Start dev server" button to show.
  kind: DevServerKind;
  // Resolved package manager script name to run (e.g. "dev" or "start").
  // Empty when no recognizable script exists.
  scriptName: string;
  // Resolved URL once the dev server emits one (e.g. "http://localhost:5173").
  // Null while starting or stopped.
  url: string | null;
  status: DevServerStatus;
  // Captured stdout lines (last ~500). UI shows in a collapsible log pane.
  logTail: string[];
  // Populated when status === 'error'. UI surfaces in the empty-state.
  errorMessage?: string;
  // Set while a run is alive. PTY id used to terminate the process on tab
  // close or app quit. Renderers should never touch this directly — it's
  // here so the main process can kill orphaned servers on shutdown.
  ptyId?: string;
  // Set once the server emits its URL. Lets the UI compute uptime.
  startedAt?: number;
  // Preflight check populated by detectDevServer. UI shows "Install
  // dependencies" CTA when hasNodeModules is false — avoids the cryptic
  // "exit code 127" that npm/pnpm produce on a fresh clone.
  preflight?: {
    hasNodeModules: boolean;
    packageManager: 'pnpm' | 'yarn' | 'npm' | 'bun';
  };
  // Detected dev scripts the user can pick between. Surfaced as a dropdown
  // when more than one is plausible (turbo/nx monorepo, multiple targets).
  candidateScripts?: Array<{ name: string; body: string }>;
  // True when the user explicitly entered a URL (manual override mode).
  // Skips PTY spawn — webview points at user-supplied URL directly.
  manualUrl?: boolean;
}

export interface DevServerStartInput {
  projectPath: string;
  // Optional override — when the auto-detected script is wrong (monorepo,
  // custom pm-aliases). When absent, DevServerService picks based on
  // `kind` + package.json scripts.
  scriptName?: string;
  // Optional override — when the framework can't be auto-detected.
  kind?: DevServerKind;
  // Optional override of the package manager. Defaults to detection
  // (pnpm-lock.yaml → pnpm, yarn.lock → yarn, else npm).
  packageManager?: 'pnpm' | 'yarn' | 'npm' | 'bun';
  // Manual URL mode — skips PTY spawn entirely. User entered the URL of
  // an already-running dev server. Validated against the same localhost
  // allowlist as auto-detected URLs.
  manualUrl?: string;
}

export interface DevServerInstallInput {
  projectPath: string;
  // Defaults to detection from lockfiles. Surfaced so the user can pick
  // a different manager if detection is wrong (e.g., pnpm-lock.yaml but
  // user wants yarn).
  packageManager?: 'pnpm' | 'yarn' | 'npm' | 'bun';
}

export interface DevServerInstallResult {
  ok: boolean;
  // Captured tail of stdout/stderr if install failed.
  errorMessage?: string;
  // Wallclock duration in ms.
  durationMs: number;
}

export type DevServerEventKind =
  | 'status_changed'
  | 'log'
  | 'url_resolved'
  | 'crashed'
  // Emitted while `pnpm/npm install` is running. Renderer shows a progress
  // pill in the empty-state CTA. Payload uses `line` for log lines, `status`
  // = 'starting' on begin, 'running' on success, 'error' on fail.
  | 'install_progress';

export interface DevServerEvent {
  kind: DevServerEventKind;
  projectPath: string;
  status?: DevServerStatus;
  url?: string | null;
  // For 'log' events, a single line of stdout/stderr.
  line?: string;
  message?: string;
  ts: number;
}
