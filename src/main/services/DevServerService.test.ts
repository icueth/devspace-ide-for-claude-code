import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DevServerService imports `electron` (via `WebContents` type-only) and
// transitively pulls in PtyPool → ClaudeCliLauncher. Those imports are
// fine at module-load time (node-pty is lazily required inside
// `createPty`), but vitest still needs an `electron` mock because some
// transitive code path references it. Mirror DesignDiscovery.test.ts.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

import {
  detectDevServer,
  detectFramework,
  detectPackageManager,
  hasNodeModulesSync,
  parseLocalUrl,
  pickCandidateScripts,
  pickScriptName,
  refreshDevServer,
  startDevServer,
  stopDevServer,
} from '@main/services/DevServerService';

// PtyPool is mocked so manualUrl tests can assert that createPty is
// never called, and so installDependencies tests can resolve cleanly
// without spawning a real process.
type DataCb = (chunk: string) => void;
type ExitCb = (code: number) => void;

interface MockPtyHooks {
  // Trigger PTY output and exit on demand from a test.
  emitData: (chunk: string) => void;
  emitExit: (code: number) => void;
}

let createPtyCalls: Array<{
  projectId: string;
  kind: string;
  tabId?: string;
  command?: string;
  args?: string[];
}> = [];
let lastPtyHooks: MockPtyHooks | null = null;
let nextSessionId = 1;

vi.mock('@main/services/PtyPool', () => {
  const dataListeners = new Map<string, DataCb[]>();
  const exitListeners = new Map<string, ExitCb[]>();
  return {
    createPty: vi.fn(async (opts: any) => {
      const sessionId = `mock:${opts.projectId}:${opts.kind}:${opts.tabId ?? 'default'}:${nextSessionId++}`;
      createPtyCalls.push({
        projectId: opts.projectId,
        kind: opts.kind,
        tabId: opts.tabId,
        command: opts.command,
        args: opts.args,
      });
      dataListeners.set(sessionId, []);
      exitListeners.set(sessionId, []);
      lastPtyHooks = {
        emitData: (chunk: string) => {
          for (const cb of dataListeners.get(sessionId) ?? []) cb(chunk);
        },
        emitExit: (code: number) => {
          for (const cb of exitListeners.get(sessionId) ?? []) cb(code);
          dataListeners.delete(sessionId);
          exitListeners.delete(sessionId);
        },
      };
      return { sessionId, projectId: opts.projectId, kind: opts.kind, tabId: opts.tabId ?? 'default', pid: 12345 };
    }),
    killPty: vi.fn(async () => undefined),
    subscribeData: vi.fn((sessionId: string, cb: DataCb) => {
      const list = dataListeners.get(sessionId) ?? [];
      list.push(cb);
      dataListeners.set(sessionId, list);
      return () => {
        dataListeners.set(sessionId, (dataListeners.get(sessionId) ?? []).filter((f) => f !== cb));
      };
    }),
    subscribeExit: vi.fn((sessionId: string, cb: ExitCb) => {
      const list = exitListeners.get(sessionId) ?? [];
      list.push(cb);
      exitListeners.set(sessionId, list);
      return () => {
        exitListeners.set(sessionId, (exitListeners.get(sessionId) ?? []).filter((f) => f !== cb));
      };
    }),
  };
});

import * as PtyPool from '@main/services/PtyPool';

function resetMocks() {
  createPtyCalls = [];
  lastPtyHooks = null;
  (PtyPool.createPty as ReturnType<typeof vi.fn>).mockClear();
  (PtyPool.killPty as ReturnType<typeof vi.fn>).mockClear();
}

// The detectFramework() signature now takes a 10-key config-flag object.
// Tests that don't care about most flags use this helper.
function flags(overrides: Partial<{
  viteConfig: boolean;
  nextConfig: boolean;
  astroConfig: boolean;
  remixConfig: boolean;
  sveltekitConfig: boolean;
  nuxtConfig: boolean;
  gatsbyConfig: boolean;
  angularConfig: boolean;
  vueCliConfig: boolean;
  storybookDir: boolean;
}> = {}) {
  return {
    viteConfig: false,
    nextConfig: false,
    astroConfig: false,
    remixConfig: false,
    sveltekitConfig: false,
    nuxtConfig: false,
    gatsbyConfig: false,
    angularConfig: false,
    vueCliConfig: false,
    storybookDir: false,
    ...overrides,
  };
}

// ─── parseLocalUrl ──────────────────────────────────────────────────────────

describe('parseLocalUrl', () => {
  it('extracts the Vite "Local:" URL from a typical line', () => {
    // Vite prints `  ➜  Local:   http://localhost:5173/`. The service
    // strips the trailing slash on bare host:port URLs so the renderer's
    // `webview.src` comparison stays consistent across frameworks.
    const url = parseLocalUrl('  ➜  Local:   http://localhost:5173/', 'vite');
    expect(url).toBe('http://localhost:5173');
  });

  it('extracts the Next.js "- Local:" URL', () => {
    const url = parseLocalUrl('- Local:        http://localhost:3000', 'next');
    expect(url).toBe('http://localhost:3000');
  });

  it('extracts the Astro "Local" URL', () => {
    const url = parseLocalUrl('Local    http://localhost:4321/', 'astro');
    expect(url).toBe('http://localhost:4321');
  });

  it('extracts the Remix "💿" URL', () => {
    const url = parseLocalUrl('💿 http://localhost:3000', 'remix');
    expect(url).toBe('http://localhost:3000');
  });

  it('returns null when the line carries no URL', () => {
    expect(parseLocalUrl('VITE v5.0.0  ready in 320 ms', 'vite')).toBeNull();
    expect(parseLocalUrl('', 'vite')).toBeNull();
    expect(parseLocalUrl('warning: something happened', 'next')).toBeNull();
  });

  it('accepts 127.0.0.1 and rewrites it to localhost (v0.16)', () => {
    // v0.16: loopback IPv4 is webview-safe — Chromium happily resolves
    // 127.0.0.1 on every supported platform. We canonicalize to
    // "localhost" so cache keys and equality checks stay simple.
    expect(parseLocalUrl('  Network: http://127.0.0.1:5173/', 'vite')).toBe(
      'http://localhost:5173',
    );
  });

  it('ignores 0.0.0.0 bind notices', () => {
    expect(
      parseLocalUrl('listening on http://0.0.0.0:3000', 'next'),
    ).toBeNull();
  });

  it('rejects LAN IPs (v0.16) — only loopback is webview-safe', () => {
    // Webview must never load a LAN address — the renderer process and
    // any compromised script can sniff intranet services otherwise.
    expect(parseLocalUrl('listening on http://192.168.1.10:3000', 'next')).toBeNull();
    expect(parseLocalUrl('  http://10.0.0.5:5173/', 'vite')).toBeNull();
    expect(parseLocalUrl('  http://172.16.0.4:8080/', 'vite')).toBeNull();
  });

  it('takes the first loopback URL when a line carries both localhost and 127.0.0.1', () => {
    const line =
      '  Local:   http://localhost:5173/   Network:  http://127.0.0.1:5173/';
    // Both accepted now; the first match wins. Either form normalizes
    // to http://localhost:5173 — equality holds.
    expect(parseLocalUrl(line, 'vite')).toBe('http://localhost:5173');
  });

  it('strips ANSI colour codes before matching the URL', () => {
    // Real vite output: green arrow + cyan URL + reset.
    const ansi =
      '\x1b[32m  ➜  Local: \x1b[36mhttp://localhost:5173/\x1b[0m';
    expect(parseLocalUrl(ansi, 'vite')).toBe('http://localhost:5173');
  });

  it('normalizes the bare host:port form by stripping the trailing slash', () => {
    // The capture stops at the port boundary (with optional trailing
    // slash) — anything past that (a path, query, hash) is not part of
    // the resolved URL the renderer uses. The normalizer then strips a
    // trailing slash on bare host:port URLs so equality checks stay
    // consistent across frameworks.
    expect(parseLocalUrl('Local:  http://localhost:3000/', 'next')).toBe(
      'http://localhost:3000',
    );
    expect(parseLocalUrl('Local:  http://localhost:3000', 'next')).toBe(
      'http://localhost:3000',
    );
  });

  it('handles Next.js "started server on … url:" format', () => {
    const line = '  ✓ started server on 0.0.0.0:3000, url: http://localhost:3000';
    expect(parseLocalUrl(line, 'next')).toBe('http://localhost:3000');
  });

  it('still extracts localhost URLs even when kind is unknown', () => {
    // Fallback path — user pointed at a script we couldn't classify.
    const url = parseLocalUrl('Listening on http://localhost:8080/', 'unknown');
    expect(url).toBe('http://localhost:8080');
  });
});

// ─── detectFramework ────────────────────────────────────────────────────────

describe('detectFramework', () => {
  it('detects vite when "vite" is a dep and vite.config is present', () => {
    const kind = detectFramework(
      { dependencies: {}, devDependencies: { vite: '^5.0.0' } },
      flags({ viteConfig: true }),
    );
    expect(kind).toBe('vite');
  });

  it('detects next when "next" is a dep and next.config is present', () => {
    const kind = detectFramework(
      { dependencies: { next: '^14.0.0' } },
      flags({ nextConfig: true }),
    );
    expect(kind).toBe('next');
  });

  it('detects astro when "astro" is a dep and astro.config is present', () => {
    const kind = detectFramework(
      { dependencies: { astro: '^4.0.0' } },
      flags({ astroConfig: true }),
    );
    expect(kind).toBe('astro');
  });

  it('detects remix purely from @remix-run/* deps (no config required)', () => {
    const kind = detectFramework(
      { dependencies: { '@remix-run/dev': '^2.0.0' } },
      flags(),
    );
    expect(kind).toBe('remix');
  });

  it('returns "unknown" when package.json is null', () => {
    expect(
      detectFramework(null, flags({
        viteConfig: true, nextConfig: true, astroConfig: true, remixConfig: true,
      })),
    ).toBe('unknown');
  });

  it('returns "unknown" when deps are empty', () => {
    expect(
      detectFramework({ dependencies: {}, devDependencies: {} }, flags()),
    ).toBe('unknown');
  });

  it('prefers next over vite when both deps + both configs exist (nx mono)', () => {
    const kind = detectFramework(
      { dependencies: { next: '^14', vite: '^5' } },
      flags({ viteConfig: true, nextConfig: true }),
    );
    expect(kind).toBe('next');
  });

  it('falls back to vite when only vite.config exists (no top-level vite dep)', () => {
    const kind = detectFramework(
      { dependencies: {} },
      flags({ viteConfig: true }),
    );
    expect(kind).toBe('vite');
  });

  it('does not detect vite when ONLY the vite dep is present (no config)', () => {
    const kind = detectFramework(
      { devDependencies: { vite: '^5.0.0' } },
      flags(),
    );
    expect(kind).toBe('unknown');
  });

  it('treats devDependencies the same as dependencies for framework detection', () => {
    const kind = detectFramework(
      { devDependencies: { next: '^14.0.0' } },
      flags({ nextConfig: true }),
    );
    expect(kind).toBe('next');
  });

  // ── v0.16: new frameworks ──

  it('detects sveltekit from @sveltejs/kit + svelte.config', () => {
    expect(
      detectFramework(
        { devDependencies: { '@sveltejs/kit': '^2.0.0' } },
        flags({ sveltekitConfig: true }),
      ),
    ).toBe('sveltekit');
  });

  it('does NOT detect sveltekit when the dep exists but svelte.config is missing', () => {
    expect(
      detectFramework(
        { devDependencies: { '@sveltejs/kit': '^2.0.0' } },
        flags(),
      ),
    ).toBe('unknown');
  });

  it('detects nuxt from nuxt dep + nuxt.config', () => {
    expect(
      detectFramework({ dependencies: { nuxt: '^3' } }, flags({ nuxtConfig: true })),
    ).toBe('nuxt');
  });

  it('does NOT detect nuxt when nuxt.config is missing', () => {
    expect(
      detectFramework({ dependencies: { nuxt: '^3' } }, flags()),
    ).toBe('unknown');
  });

  it('detects gatsby from gatsby dep + gatsby-config', () => {
    expect(
      detectFramework({ dependencies: { gatsby: '^5' } }, flags({ gatsbyConfig: true })),
    ).toBe('gatsby');
  });

  it('does NOT detect gatsby when gatsby-config is missing', () => {
    expect(
      detectFramework({ dependencies: { gatsby: '^5' } }, flags()),
    ).toBe('unknown');
  });

  it('detects angular from @angular/core + angular.json', () => {
    expect(
      detectFramework(
        { dependencies: { '@angular/core': '^17' } },
        flags({ angularConfig: true }),
      ),
    ).toBe('angular');
  });

  it('does NOT detect angular without angular.json', () => {
    expect(
      detectFramework(
        { dependencies: { '@angular/core': '^17' } },
        flags(),
      ),
    ).toBe('unknown');
  });

  it('detects vue-cli from @vue/cli-service + vue.config', () => {
    expect(
      detectFramework(
        { devDependencies: { '@vue/cli-service': '^5' } },
        flags({ vueCliConfig: true }),
      ),
    ).toBe('vue-cli');
  });

  it('does NOT detect vue-cli without vue.config', () => {
    expect(
      detectFramework(
        { devDependencies: { '@vue/cli-service': '^5' } },
        flags(),
      ),
    ).toBe('unknown');
  });

  it('detects CRA from react-scripts alone (no specific config required)', () => {
    expect(
      detectFramework({ dependencies: { 'react-scripts': '^5' } }, flags()),
    ).toBe('cra');
  });

  it('detects storybook from "storybook" dep + .storybook/ dir', () => {
    expect(
      detectFramework(
        { devDependencies: { storybook: '^7' } },
        flags({ storybookDir: true }),
      ),
    ).toBe('storybook');
  });

  it('detects storybook from any @storybook/* sub-package + .storybook/ dir', () => {
    expect(
      detectFramework(
        { devDependencies: { '@storybook/react-vite': '^7' } },
        flags({ storybookDir: true }),
      ),
    ).toBe('storybook');
  });

  it('prefers storybook over vite when both signals exist (Storybook-in-Vite)', () => {
    // Storybook 7+ runs on Vite under the hood. We want the dedicated
    // "storybook" classification to win so the dropdown shows the right
    // CLI name.
    expect(
      detectFramework(
        {
          devDependencies: {
            '@storybook/react-vite': '^7',
            vite: '^5',
          },
        },
        flags({ storybookDir: true, viteConfig: true }),
      ),
    ).toBe('storybook');
  });

  it('detects vitepress from the vitepress dep alone', () => {
    expect(
      detectFramework({ devDependencies: { vitepress: '^1' } }, flags()),
    ).toBe('vitepress');
  });

  it('detects docusaurus from @docusaurus/core alone', () => {
    expect(
      detectFramework({ dependencies: { '@docusaurus/core': '^3' } }, flags()),
    ).toBe('docusaurus');
  });

  it('falls back to "static" for serve/http-server-style deps as last resort', () => {
    expect(
      detectFramework({ dependencies: { serve: '^14' } }, flags()),
    ).toBe('static');
    expect(
      detectFramework({ dependencies: { 'http-server': '^14' } }, flags()),
    ).toBe('static');
  });

  it('static does NOT preempt a real framework (priority sanity)', () => {
    // A project carrying `serve` AND `next` should still classify as next.
    expect(
      detectFramework(
        { dependencies: { serve: '^14', next: '^14' } },
        flags({ nextConfig: true }),
      ),
    ).toBe('next');
  });
});

// ─── pickScriptName ─────────────────────────────────────────────────────────

describe('pickScriptName', () => {
  it('returns "dev" when scripts.dev exists', () => {
    expect(
      pickScriptName({ dev: 'vite', start: 'vite preview' }, 'vite'),
    ).toBe('dev');
  });

  it('falls back to "start" when scripts.dev is absent for non-production-start kinds', () => {
    // Vite's `start` is unusual but not production-only — falling back
    // there is still a safer default than empty.
    expect(pickScriptName({ start: 'vite preview' }, 'vite')).toBe('start');
  });

  it('does NOT fall back to "start" for Next.js (v0.16 — production-only)', () => {
    // `next start` requires `.next/` from a prior `next build`. Falling
    // back to it produces a confusingly-broken preview, so we return
    // empty and let the UI surface "no runnable dev script".
    expect(pickScriptName({ start: 'next start' }, 'next')).toBe('');
  });

  it('does NOT fall back to "start" for nuxt/gatsby/sveltekit/docusaurus (v0.16)', () => {
    expect(pickScriptName({ start: 'nuxt start' }, 'nuxt')).toBe('');
    expect(pickScriptName({ start: 'gatsby serve' }, 'gatsby')).toBe('');
    expect(pickScriptName({ start: 'svelte-kit preview' }, 'sveltekit')).toBe('');
    expect(pickScriptName({ start: 'docusaurus serve' }, 'docusaurus')).toBe('');
  });

  it('still picks an explicit "dev" script for Next.js (no production-start bypass needed)', () => {
    expect(
      pickScriptName({ dev: 'next dev', start: 'next start' }, 'next'),
    ).toBe('dev');
  });

  it('returns "" when no dev/start script exists and no body matches the framework keyword', () => {
    // Implementation note: with no dev/start, the picker scans bodies
    // for the framework's CLI keyword. So "build: vite build" WOULD be
    // picked up as a last-resort match — that's deliberate best-effort
    // behaviour. The pure "no match" path uses a script body that
    // contains no framework keyword.
    expect(pickScriptName({ build: 'tsc -p .' }, 'vite')).toBe('');
    expect(pickScriptName({ lint: 'eslint .' }, 'next')).toBe('');
  });

  it('rejects build-only scripts even when they invoke the framework CLI', () => {
    // The fallback scan requires a "dev"-ish token in either the script
    // name or body, so `{ build: 'vite build' }` is NOT picked up. This
    // prevents the Live Preview from launching one-shot production
    // builds that exit immediately without ever serving a URL.
    expect(pickScriptName({ build: 'vite build' }, 'vite')).toBe('');
  });

  it('picks up a non-standard script name when its body invokes the framework dev/watch command', () => {
    expect(pickScriptName({ serve: 'vite serve' }, 'vite')).toBe('serve');
    expect(pickScriptName({ watch: 'vite' }, 'vite')).toBe('watch');
  });

  it('returns "" for an empty scripts object', () => {
    expect(pickScriptName({}, 'vite')).toBe('');
  });

  it('returns "" when scripts is undefined', () => {
    expect(pickScriptName(undefined as unknown as Record<string, string>, 'vite')).toBe('');
  });

  it('falls back to a body-keyword match as a last resort', () => {
    // When no `dev`/`start` exists, the picker scans script bodies for
    // the framework's CLI keyword. "develop" carries "next" → matches.
    expect(
      pickScriptName({ develop: 'next dev --turbo' }, 'next'),
    ).toBe('develop');
  });

  it('treats whitespace-only "dev" as missing and tries "start" next', () => {
    expect(
      pickScriptName({ dev: '   ', start: 'vite preview' }, 'vite'),
    ).toBe('start');
  });
});

// ─── detectPackageManager (integration via tmpdir) ──────────────────────────
//
// The real signature is `detectPackageManager(projectPath: string)` — it
// touches the filesystem looking for lockfiles. We exercise it through a
// real temp directory so the test mirrors how the service runs in main.

describe('detectPackageManager', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-devserver-pm-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns pnpm when pnpm-lock.yaml exists', async () => {
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), '', 'utf8');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('pnpm');
  });

  it('returns yarn when yarn.lock exists', async () => {
    await writeFile(path.join(tmp, 'yarn.lock'), '', 'utf8');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('yarn');
  });

  it('returns bun when bun.lockb exists', async () => {
    await writeFile(path.join(tmp, 'bun.lockb'), '', 'utf8');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('bun');
  });

  it('returns npm when only package.json is present (no lockfile)', async () => {
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('npm');
  });

  it('returns npm when package-lock.json is present', async () => {
    await writeFile(path.join(tmp, 'package-lock.json'), '{}', 'utf8');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('npm');
  });

  it('prefers pnpm over yarn when both lockfiles coexist', async () => {
    // Lockfile shouldn't BOTH exist in practice, but a monorepo with
    // legacy yarn migration can leave both. The detector picks the
    // first match in priority order (pnpm wins).
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), '', 'utf8');
    await writeFile(path.join(tmp, 'yarn.lock'), '', 'utf8');
    expect(await detectPackageManager(tmp)).toBe('pnpm');
  });
});

// ─── detectDevServer (integration via tmpdir) ───────────────────────────────

describe('detectDevServer', () => {
  let tmp = '';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-devserver-detect-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('detects a Vite project (package.json + vite.config.ts + pnpm lockfile)', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'demo',
        scripts: { dev: 'vite', build: 'vite build' },
        devDependencies: { vite: '^5.0.0' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'vite.config.ts'), '', 'utf8');
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), '', 'utf8');

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('vite');
    expect(info.scriptName).toBe('dev');
    expect(info.status).toBe('idle');
    expect(info.url).toBeNull();
    expect(info.logTail).toEqual([]);
  });

  it('detects a Next.js project from package.json + next.config.mjs', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'demo-next',
        scripts: { dev: 'next dev', start: 'next start', build: 'next build' },
        dependencies: { next: '^14.0.0' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'next.config.mjs'), 'export default {}', 'utf8');

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('next');
    expect(info.scriptName).toBe('dev');
    expect(info.status).toBe('idle');
  });

  it('detects an Astro project', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'demo-astro',
        scripts: { dev: 'astro dev', build: 'astro build' },
        dependencies: { astro: '^4.0.0' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'astro.config.mjs'), '', 'utf8');

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('astro');
    expect(info.scriptName).toBe('dev');
  });

  it('detects a Remix project from @remix-run/dev alone', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'demo-remix',
        scripts: { dev: 'remix vite:dev', build: 'remix vite:build' },
        dependencies: { '@remix-run/dev': '^2.0.0' },
      }),
      'utf8',
    );

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('remix');
    expect(info.scriptName).toBe('dev');
  });

  it('returns "unknown" + empty scriptName for an unrecognised project', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'no-framework',
        scripts: { build: 'tsc -p .' },
        dependencies: {},
      }),
      'utf8',
    );

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('unknown');
    expect(info.scriptName).toBe('');
    expect(info.status).toBe('idle');
    expect(info.url).toBeNull();
  });

  it('returns "unknown" when package.json is missing entirely', async () => {
    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('unknown');
    expect(info.scriptName).toBe('');
    expect(info.status).toBe('idle');
  });

  it('does NOT fall back from "dev" to "start" for Next.js (v0.16 — production-only)', async () => {
    // Pre-v0.16 this returned scriptName='start'; new behaviour: return
    // empty so the UI shows "no runnable dev script" instead of
    // launching a broken `next start` that requires a build.
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'start-only',
        scripts: { start: 'next start' },
        dependencies: { next: '^14.0.0' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'next.config.js'), 'module.exports = {}', 'utf8');

    const info = await detectDevServer(tmp);
    expect(info.kind).toBe('next');
    expect(info.scriptName).toBe('');
  });

  it('populates preflight.hasNodeModules=false on a fresh clone (v0.16)', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'fresh',
        scripts: { dev: 'vite' },
        devDependencies: { vite: '^5' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'vite.config.ts'), '', 'utf8');
    const info = await detectDevServer(tmp);
    expect(info.preflight).toBeDefined();
    expect(info.preflight?.hasNodeModules).toBe(false);
    expect(info.preflight?.packageManager).toBe('npm');
  });

  it('populates preflight.hasNodeModules=true when node_modules/ exists (v0.16)', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'installed', scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'vite.config.ts'), '', 'utf8');
    await mkdir(path.join(tmp, 'node_modules'));
    const info = await detectDevServer(tmp);
    expect(info.preflight?.hasNodeModules).toBe(true);
  });

  it('populates preflight.packageManager from lockfile detection (v0.16)', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'pnpm-proj', scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'vite.config.ts'), '', 'utf8');
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), '', 'utf8');
    const info = await detectDevServer(tmp);
    expect(info.preflight?.packageManager).toBe('pnpm');
  });

  it('populates candidateScripts for a turbo-style monorepo (v0.16)', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'mono',
        scripts: {
          dev: 'turbo run dev',
          'dev:web': 'turbo run dev --filter=web',
          'dev:api': 'turbo run dev --filter=api',
          build: 'turbo run build',
          test: 'vitest run',
        },
        devDependencies: { vite: '^5' },
      }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'vite.config.ts'), '', 'utf8');
    const info = await detectDevServer(tmp);
    expect(info.candidateScripts).toBeDefined();
    const names = (info.candidateScripts ?? []).map((s) => s.name);
    expect(names).toContain('dev');
    expect(names).toContain('dev:web');
    expect(names).toContain('dev:api');
    // Build / test scripts are filtered out — they're production-only.
    expect(names).not.toContain('build');
    expect(names).not.toContain('test');
  });
});

// ─── hasNodeModulesSync ─────────────────────────────────────────────────────

describe('hasNodeModulesSync', () => {
  let tmp = '';
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-devserver-nm-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns false when node_modules/ does not exist', () => {
    expect(hasNodeModulesSync(tmp)).toBe(false);
  });

  it('returns true when node_modules/ exists as a directory', async () => {
    await mkdir(path.join(tmp, 'node_modules'));
    expect(hasNodeModulesSync(tmp)).toBe(true);
  });

  it('returns false for a missing project path (no throw)', () => {
    expect(hasNodeModulesSync(path.join(tmp, 'does-not-exist'))).toBe(false);
  });
});

// ─── pickCandidateScripts ───────────────────────────────────────────────────

describe('pickCandidateScripts', () => {
  it('returns [] for empty / undefined input', () => {
    expect(pickCandidateScripts(undefined)).toEqual([]);
    expect(pickCandidateScripts({})).toEqual([]);
  });

  it('filters out build/test/lint scripts', () => {
    const out = pickCandidateScripts({
      dev: 'vite',
      build: 'vite build',
      test: 'vitest run',
      lint: 'eslint .',
      'dev:debug': 'vite --debug',
    });
    const names = out.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['dev', 'dev:debug']));
    expect(names).not.toContain('build');
    expect(names).not.toContain('test');
    expect(names).not.toContain('lint');
  });

  it('caps the result at 8 entries to avoid UI overflow', () => {
    const scripts: Record<string, string> = {};
    for (let i = 0; i < 12; i++) scripts[`dev:${i}`] = `serve --port ${3000 + i}`;
    const out = pickCandidateScripts(scripts);
    expect(out.length).toBe(8);
  });
});

// ─── refreshDevServer ──────────────────────────────────────────────────────

describe('refreshDevServer', () => {
  let tmp = '';
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-devserver-refresh-'));
    resetMocks();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    // Reset any leftover dev-server state from prior tests.
    await stopDevServer(tmp).catch(() => undefined);
  });

  it('rejects relative or .. paths', async () => {
    await expect(refreshDevServer('relative/path')).rejects.toThrow(/absolute/);
    await expect(refreshDevServer(`${tmp}/..`)).rejects.toThrow(/\.\./);
  });

  it('reruns detection for an idle project', async () => {
    // Start with empty project — kind should be unknown.
    let info = await refreshDevServer(tmp);
    expect(info.kind).toBe('unknown');

    // Add a vite project, then refresh — kind should flip to vite.
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'vite.config.ts'), '', 'utf8');
    info = await refreshDevServer(tmp);
    expect(info.kind).toBe('vite');
    expect(info.scriptName).toBe('dev');
  });

  it('preserves running state and only updates detection-derived fields', async () => {
    // Set up a manual-URL "running" server (no PTY).
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
      'utf8',
    );
    await writeFile(path.join(tmp, 'vite.config.ts'), '', 'utf8');
    const started = await startDevServer({
      projectPath: tmp,
      manualUrl: 'http://localhost:5173',
    });
    expect(started.status).toBe('running');
    expect(started.url).toBe('http://localhost:5173');

    // Refresh — url and status must be preserved.
    const refreshed = await refreshDevServer(tmp);
    expect(refreshed.status).toBe('running');
    expect(refreshed.url).toBe('http://localhost:5173');
    expect(refreshed.kind).toBe('vite');
  });
});

// ─── startDevServer: manualUrl mode ─────────────────────────────────────────

describe('startDevServer manualUrl mode', () => {
  let tmp = '';
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-devserver-manual-'));
    resetMocks();
  });
  afterEach(async () => {
    await stopDevServer(tmp).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  });

  it('skips PTY spawn entirely when manualUrl is provided', async () => {
    const info = await startDevServer({
      projectPath: tmp,
      manualUrl: 'http://localhost:8080',
    });
    expect(info.status).toBe('running');
    expect(info.url).toBe('http://localhost:8080');
    expect(info.manualUrl).toBe(true);
    expect(PtyPool.createPty).not.toHaveBeenCalled();
  });

  it('accepts http://127.0.0.1 in manual mode (v0.16 — loopback canonicalized)', async () => {
    const info = await startDevServer({
      projectPath: tmp,
      manualUrl: 'http://127.0.0.1:5173',
    });
    expect(info.url).toBe('http://localhost:5173');
    expect(info.manualUrl).toBe(true);
  });

  it('rejects http://192.168.1.10 in manual mode with a clear error', async () => {
    const info = await startDevServer({
      projectPath: tmp,
      manualUrl: 'http://192.168.1.10:3000',
    });
    expect(info.status).toBe('error');
    expect(info.errorMessage).toMatch(/localhost/i);
    expect(PtyPool.createPty).not.toHaveBeenCalled();
  });

  it('rejects file:// in manual mode', async () => {
    const info = await startDevServer({
      projectPath: tmp,
      manualUrl: 'file:///etc/passwd',
    });
    expect(info.status).toBe('error');
    expect(PtyPool.createPty).not.toHaveBeenCalled();
  });

  it('rejects URLs with userinfo in manual mode', async () => {
    const info = await startDevServer({
      projectPath: tmp,
      manualUrl: 'http://user:pass@localhost:3000',
    });
    expect(info.status).toBe('error');
    expect(PtyPool.createPty).not.toHaveBeenCalled();
  });

  it('stop on a manual-URL server clears state without killing any PTY', async () => {
    await startDevServer({
      projectPath: tmp,
      manualUrl: 'http://localhost:8080',
    });
    const stopped = await stopDevServer(tmp);
    expect(stopped.status).toBe('stopped');
    expect(stopped.url).toBeNull();
    expect(stopped.manualUrl).toBeFalsy();
    expect(PtyPool.killPty).not.toHaveBeenCalled();
  });
});

// ─── installDependencies ────────────────────────────────────────────────────

describe('installDependencies', () => {
  let tmp = '';
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devspace-devserver-install-'));
    resetMocks();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects relative projectPath', async () => {
    const { installDependencies } = await import('@main/services/DevServerService');
    await expect(
      installDependencies({ projectPath: 'relative' }),
    ).rejects.toThrow(/absolute/);
  });

  it('rejects projectPath containing ..', async () => {
    const { installDependencies } = await import('@main/services/DevServerService');
    await expect(
      installDependencies({ projectPath: `${tmp}/sub/../..` }),
    ).rejects.toThrow(/\.\./);
  });

  it('rejects a non-existent projectPath', async () => {
    const { installDependencies } = await import('@main/services/DevServerService');
    await expect(
      installDependencies({ projectPath: '/this/does/not/exist/anywhere/devspace-test-12345' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('rejects an invalid packageManager', async () => {
    const { installDependencies } = await import('@main/services/DevServerService');
    await expect(
      // @ts-expect-error — testing invalid pm
      installDependencies({ projectPath: tmp, packageManager: 'invalid-pm' }),
    ).rejects.toThrow(/invalid packageManager/);
  });

  // Helper: yield enough microtasks for installDependencies to await
  // createPty + subscribe to data/exit before we drive PTY events.
  const settleMicrotasks = () => new Promise((r) => setImmediate(r));

  it('spawns a PTY with kind="install" and resolves ok on exit code 0', async () => {
    const { installDependencies } = await import('@main/services/DevServerService');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    const promise = installDependencies({ projectPath: tmp, packageManager: 'npm' });
    await settleMicrotasks();
    expect(createPtyCalls.length).toBe(1);
    expect(createPtyCalls[0].kind).toBe('install');
    expect(createPtyCalls[0].args).toEqual(['install']);
    expect(createPtyCalls[0].tabId).toBe(`${tmp}#install`);
    lastPtyHooks?.emitData('added 102 packages\n');
    lastPtyHooks?.emitExit(0);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(typeof result.durationMs).toBe('number');
  });

  it('resolves with ok=false and a captured tail when the install exits non-zero', async () => {
    const { installDependencies } = await import('@main/services/DevServerService');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    const promise = installDependencies({ projectPath: tmp, packageManager: 'npm' });
    await settleMicrotasks();
    lastPtyHooks?.emitData('npm ERR! 404 Not Found\n');
    lastPtyHooks?.emitExit(1);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/code 1/);
    expect(result.errorMessage).toMatch(/404 Not Found/);
  });

  it('rejects parallel installs for the same project', async () => {
    const { installDependencies } = await import('@main/services/DevServerService');
    await writeFile(path.join(tmp, 'package.json'), '{}', 'utf8');
    const promise1 = installDependencies({ projectPath: tmp, packageManager: 'npm' });
    await settleMicrotasks();
    // Don't resolve the first install yet — start a second one.
    await expect(
      installDependencies({ projectPath: tmp, packageManager: 'npm' }),
    ).rejects.toThrow(/already in progress/);
    // Clean up the still-pending install so vitest doesn't hang.
    lastPtyHooks?.emitExit(0);
    await promise1;
  });
});
