// DesignService — function-only service that owns the per-project Design
// Studio state. Mirrors the orchestration pattern used by ChatService
// (in-memory map of project state, atomic JSON persistence, IPC
// subscribers as a Set<WebContents>) but specialized for one-shot HTML
// generations rather than multi-turn chats.
//
// Storage layout (per project):
//   <project>/.devspace/design/
//     designs.json                       — registry (DesignScreen[])
//     screens/<id>/
//       index.html                       — current generation
//       design.json                      — per-screen meta
//       history/<versionId>/index.html  — older versions
//
// Generation itself lives in DesignGenerator — this module is the
// stateful coordinator that holds the in-memory project map, the screen
// registry persistence, the subscriber broadcast layer, and the
// skill/system discovery scans.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { WebContents } from 'electron';

import { generateDesign } from '@main/services/DesignGenerator';
import { DEVSPACE_BRIDGE_SCRIPT } from '@main/services/design/bridgeScript';
import { tagDevspaceIds } from '@main/services/design/idTagger';
import { readSkill } from '@main/services/SkillsService';
import { getBuiltinDesignPacksDir } from '@main/utils/designResourcePaths';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  CreateDesignInput,
  DesignEvent,
  DesignEventKind,
  DesignProject,
  DesignSaveEditsInput,
  DesignScope,
  DesignScreen,
  DesignSkill,
  DesignSystem,
  RegenerateDesignInput,
} from '@shared/design';
import type { SkillDef } from '@shared/types';

const logger = createLogger('Design');

// Cap stored versions per screen so iteration-heavy users don't accrue
// unbounded `history/<versionId>/index.html` directories on disk. The
// oldest version is evicted (and its history dir removed) once a new
// generation pushes past the cap.
const MAX_VERSIONS = 20;

// ─── filesystem layout ──────────────────────────────────────────────────────

function designDir(projectPath: string): string {
  return path.join(projectPath, '.devspace', 'design');
}

function registryFile(projectPath: string): string {
  return path.join(designDir(projectPath), 'designs.json');
}

function screenDir(projectPath: string, screenId: string): string {
  return path.join(designDir(projectPath), 'screens', screenId);
}

function screenIndexHtml(projectPath: string, screenId: string): string {
  return path.join(screenDir(projectPath, screenId), 'index.html');
}

function screenMetaFile(projectPath: string, screenId: string): string {
  return path.join(screenDir(projectPath, screenId), 'design.json');
}

function historyDir(projectPath: string, screenId: string, versionId: string): string {
  return path.join(screenDir(projectPath, screenId), 'history', versionId);
}

// Pattern matching the IDs we accept from the renderer. `randomUUID()`
// produces v4 — narrow accept to those plus dashed lowercase hex of the
// same length so we can recognize tampering quickly.
const SCREEN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Renderer-supplied screenId guard. Any handler that turns a screenId
// into a path on disk MUST validate first or risk path traversal /
// arbitrary file delete via "..", control chars, or null bytes.
function assertValidScreenId(id: string): void {
  if (typeof id !== 'string' || !SCREEN_ID_RE.test(id)) {
    throw new Error(`invalid design screenId: ${JSON.stringify(id)}`);
  }
}

// Second-layer defense: after resolving any per-screen path, confirm it
// still lives under `<projectPath>/.devspace/design/` so a screenId that
// somehow bypassed validation can't escape the design subtree.
function assertInsideDesignDir(projectPath: string, target: string): void {
  const base = path.resolve(designDir(projectPath));
  const resolved = path.resolve(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`path escapes design dir: ${resolved}`);
  }
}

// Hardens claude-generated HTML before it lands on disk. Belt-and-
// suspenders on top of the iframe sandbox: a hostile skill could coerce
// the model into emitting `<script src=https://attacker/x.js>` or an
// `<img>` tracking pixel; the sandbox alone wouldn't stop the outbound
// fetch. We inject a strict CSP `<meta>` tag, strip remote `<script>` +
// `<iframe>` + `<object>` + `<embed>` tags, and neutralize
// `javascript:` URLs in href/src attributes. Inline `<script>` is
// allowed (the model needs it for the dropdowns / modals it generates).
function hardenGeneratedHtml(raw: string): string {
  if (!raw) return raw;
  let out = raw;

  // 0. Strip any previously-injected bridge `<script data-devspace-bridge="1">`.
  // Save round-trips run hardenGeneratedHtml on already-bridged HTML; we
  // must not accumulate stacked copies of the IIFE.
  out = out.replace(
    /<script\b[^>]*\bdata-devspace-bridge\s*=\s*["']1["'][^>]*>[\s\S]*?<\/script\s*>/gi,
    '',
  );

  // 1. Strip remote-source script tags. Inline scripts survive.
  out = out.replace(
    /<script\b([^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*)>[\s\S]*?<\/script\s*>/gi,
    '',
  );
  // 2. Strip iframe/object/embed entirely — no legitimate use in a
  // self-contained design preview, and they're prime exfil vectors.
  out = out.replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<(iframe|object|embed)\b[^>]*\/?\s*>/gi, '');

  // 2b. Strip <meta http-equiv="refresh"> — sandbox doesn't have
  // allow-top-navigation but an in-frame refresh to an allowlisted host
  // is still an outbound side channel. Also drop <base> as defense-in-
  // depth on top of CSP `base-uri 'none'`.
  out = out.replace(
    /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh["']?[^>]*>/gi,
    '',
  );
  out = out.replace(/<base\b[^>]*>/gi, '');

  // 3. Neutralize `href="javascript:..."` and `src="javascript:..."`.
  out = out.replace(
    /\b(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi,
    '$1="#"',
  );

  // 4. Inject a strict CSP `<meta>` tag right after <head> if absent.
  // The policy mirrors the prompt's "no external scripts, Google Fonts
  // only" rule but makes it enforceable rather than advisory.
  const csp =
    `default-src 'none';` +
    ` style-src 'unsafe-inline' https://fonts.googleapis.com;` +
    ` font-src https://fonts.gstatic.com data:;` +
    ` img-src data: https://images.unsplash.com https://source.unsplash.com;` +
    ` script-src 'unsafe-inline';` +
    ` form-action 'none';` +
    ` base-uri 'none';` +
    ` frame-ancestors 'self';`;
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (!/Content-Security-Policy/i.test(out)) {
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head([^>]*)>/i, `<head$1>\n  ${cspMeta}`);
    } else if (/<html[^>]*>/i.test(out)) {
      out = out.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n  ${cspMeta}\n</head>`);
    } else {
      out = `<head>\n  ${cspMeta}\n</head>\n${out}`;
    }
  }

  // 5. Tag every element with a stable `data-devspace-id` so the iframe
  // bridge can address nodes by ID rather than fragile CSS selectors.
  // The tagger is idempotent — re-running on already-tagged HTML does
  // not change existing IDs.
  out = tagDevspaceIds(out);

  // 6. Inject the bridge IIFE just before `</body>` (or append if no
  // body close tag is present). The marker attribute `data-devspace-
  // bridge="1"` lets step 0 strip a previous copy on save round-trips.
  const bridgeTag = `<script data-devspace-bridge="1">${DEVSPACE_BRIDGE_SCRIPT}</script>`;
  if (/<\/body\s*>/i.test(out)) {
    out = out.replace(/<\/body\s*>/i, `${bridgeTag}\n</body>`);
  } else {
    out = `${out}\n${bridgeTag}`;
  }

  return out;
}

// ─── in-memory state ────────────────────────────────────────────────────────

interface ProjectState {
  projectPath: string;
  screens: Map<string, DesignScreen>;
  subscribers: Set<WebContents>;
  hydrationPromise: Promise<void>;
}

const states = new Map<string, ProjectState>();

function getState(projectPath: string): ProjectState {
  const key = path.resolve(projectPath);
  let state = states.get(key);
  if (!state) {
    state = {
      projectPath: key,
      screens: new Map(),
      subscribers: new Set(),
      hydrationPromise: Promise.resolve(),
    };
    states.set(key, state);
    state.hydrationPromise = hydrateFromDisk(state).catch((err) => {
      logger.warn(
        `hydrate failed for ${key}: ${(err as Error).message}`,
      );
    });
  }
  return state;
}

async function hydrateFromDisk(state: ProjectState): Promise<void> {
  const file = registryFile(state.projectPath);
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`failed to read registry ${file}: ${(err as Error).message}`);
    }
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { screens?: DesignScreen[] };
    const arr = Array.isArray(parsed.screens) ? parsed.screens : [];
    for (const s of arr) {
      if (s && typeof s.id === 'string') {
        // Any screen left mid-generation across a restart is reset to
        // 'error' — Phase A doesn't resume design runs the way chat does
        // since there's no streaming UI to reattach to.
        if (s.status === 'generating') {
          state.screens.set(s.id, {
            ...s,
            status: 'error',
            errorMessage: 'Generation interrupted by app restart',
            activeRun: undefined,
          });
        } else {
          state.screens.set(s.id, s);
        }
      }
    }
  } catch (err) {
    logger.warn(`registry parse failed: ${(err as Error).message}`);
  }
}

async function persistRegistry(state: ProjectState): Promise<void> {
  const file = registryFile(state.projectPath);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const payload: DesignProject = {
    projectPath: state.projectPath,
    screens: [...state.screens.values()].sort((a, b) => a.createdAt - b.createdAt),
  };
  const tmp = `${file}.tmp-${randomUUID()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.promises.rename(tmp, file);
}

async function persistScreenMeta(
  projectPath: string,
  screen: DesignScreen,
): Promise<void> {
  const file = screenMetaFile(projectPath, screen.id);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(screen, null, 2));
  await fs.promises.rename(tmp, file);
}

function broadcast(state: ProjectState, event: DesignEvent): void {
  for (const wc of state.subscribers) {
    if (!wc.isDestroyed()) {
      wc.send(IPC.DESIGN_EVENT, { projectPath: state.projectPath, event });
    }
  }
}

function emit(
  state: ProjectState,
  kind: DesignEventKind,
  screenId: string,
  extra: Partial<DesignEvent> = {},
): void {
  broadcast(state, {
    kind,
    projectPath: state.projectPath,
    screenId,
    ts: Date.now(),
    ...extra,
  });
}

// ─── public API ─────────────────────────────────────────────────────────────

export async function listScreens(projectPath: string): Promise<DesignScreen[]> {
  const s = getState(projectPath);
  await s.hydrationPromise;
  return [...s.screens.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export async function getScreen(
  projectPath: string,
  screenId: string,
): Promise<DesignScreen | null> {
  assertValidScreenId(screenId);
  const s = getState(projectPath);
  await s.hydrationPromise;
  return s.screens.get(screenId) ?? null;
}

export async function createDesign(input: CreateDesignInput): Promise<DesignScreen> {
  const s = getState(input.projectPath);
  await s.hydrationPromise;

  const skills = await listSkills(input.projectPath);
  const skill = skills.find((k) => k.slug === input.skillSlug);
  if (!skill) throw new Error(`design skill not found: ${input.skillSlug}`);

  const systems = await listSystems(input.projectPath);
  const designSystem = input.designSystemSlug
    ? systems.find((d) => d.slug === input.designSystemSlug)
    : undefined;
  if (input.designSystemSlug && !designSystem) {
    throw new Error(`design system not found: ${input.designSystemSlug}`);
  }

  const now = Date.now();
  const screen: DesignScreen = {
    id: randomUUID(),
    name: input.name.trim() || 'Untitled screen',
    skillSlug: input.skillSlug,
    designSystemSlug: input.designSystemSlug,
    brief: input.brief,
    status: 'pending',
    htmlPath: null,
    createdAt: now,
    updatedAt: now,
    versions: [],
  };

  s.screens.set(screen.id, screen);
  await persistScreenMeta(s.projectPath, screen);
  await persistRegistry(s);
  emit(s, 'screen_created', screen.id, { screen });

  // Fire-and-forget generation. Errors propagate to the renderer as
  // 'generation_error' events, so we don't need to await this. Using
  // void to make the lint check happy.
  void runGeneration(s, screen, skill, designSystem);

  return screen;
}

export async function regenerateDesign(
  input: RegenerateDesignInput,
): Promise<DesignScreen> {
  assertValidScreenId(input.screenId);
  const s = getState(input.projectPath);
  await s.hydrationPromise;
  const screen = s.screens.get(input.screenId);
  if (!screen) throw new Error(`screen not found: ${input.screenId}`);
  if (screen.status === 'generating') {
    throw new Error(`screen ${input.screenId} is already generating`);
  }

  if (typeof input.brief === 'string') screen.brief = input.brief;
  if (typeof input.designSystemSlug === 'string') {
    screen.designSystemSlug = input.designSystemSlug;
  }
  screen.updatedAt = Date.now();

  const skills = await listSkills(input.projectPath);
  const skill = skills.find((k) => k.slug === screen.skillSlug);
  if (!skill) throw new Error(`design skill not found: ${screen.skillSlug}`);

  const systems = await listSystems(input.projectPath);
  const designSystem = screen.designSystemSlug
    ? systems.find((d) => d.slug === screen.designSystemSlug)
    : undefined;

  await persistScreenMeta(s.projectPath, screen);
  await persistRegistry(s);
  emit(s, 'screen_updated', screen.id, { screen });

  void runGeneration(s, screen, skill, designSystem);
  return screen;
}

// Cap user-supplied HTML payload to keep main-process memory bounded
// against a malicious renderer or a runaway edit overlay. Real outputs
// run ~20-200 KB; 2 MB is the strictest cap that still leaves headroom
// for genuinely heavy screens.
const MAX_EDIT_HTML_BYTES = 2 * 1024 * 1024;

// Per-screen rate limit on saveEdits. A compromised iframe (see Phase B
// security review, finding HIGH 1) could spoof the snapshot reply and
// race the legitimate bridge. Throttling caps the disk-fill risk and
// gives the user / watchdogs a chance to notice the storm.
const SAVE_EDITS_MIN_INTERVAL_MS = 2_000;
const lastSaveAt = new Map<string, number>();

// Strip ALL inline <script>...</script> from inbound saveEdits HTML.
// Legitimate inline scripts come from the original Claude generation, not
// from manual edits — they are PRESERVED in earlier version rows (saved
// before any edit happened) and would be re-injected fresh as the bridge
// IIFE by hardenGeneratedHtml anyway. Stripping here defeats the bridge-
// spoofing attack: a hostile inline <script> in the rendered HTML could
// have called window.parent.postMessage with a forged 'devspace:snapshot'
// payload, and the renderer (which can only identity-check by
// contentWindow, not by author within the iframe) would forward an
// attacker-chosen HTML to disk. By the time saveEdits sees the HTML, the
// only legitimate JS in it should be the bridge IIFE — which gets
// regenerated regardless. Removing inline scripts on the way in
// neutralises the spoof entirely.
function stripAllInlineScripts(raw: string): string {
  if (!raw) return raw;
  // Paired open+close
  let out = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  // Defensive: orphan opening tags
  out = out.replace(/<script\b[^>]*\/?>/gi, '');
  return out;
}

export async function saveEdits(
  input: DesignSaveEditsInput,
): Promise<DesignScreen> {
  assertValidScreenId(input.screenId);
  if (typeof input.html !== 'string' || input.html.trim() === '') {
    throw new Error('design html is empty');
  }
  // Byte-length check (Buffer.byteLength avoids materializing another
  // string copy just to count). Refuse oversize payloads up front so we
  // never write multi-megabyte garbage to disk or accept a DoS vector.
  if (Buffer.byteLength(input.html, 'utf8') > MAX_EDIT_HTML_BYTES) {
    throw new Error('design html too large');
  }

  const s = getState(input.projectPath);
  await s.hydrationPromise;
  const screen = s.screens.get(input.screenId);
  if (!screen) throw new Error(`screen not found: ${input.screenId}`);
  if (screen.status === 'generating') {
    throw new Error(`screen ${input.screenId} is generating — cannot save edits`);
  }

  // Rate limit. Soft floor — adds a 2-second cooldown per screen, which
  // does not affect normal interactive use but caps disk-fill if an
  // attacker pivots through the renderer.
  const rateKey = `${s.projectPath}::${screen.id}`;
  const now = Date.now();
  const last = lastSaveAt.get(rateKey) ?? 0;
  if (now - last < SAVE_EDITS_MIN_INTERVAL_MS) {
    throw new Error(
      `please wait ${Math.ceil((SAVE_EDITS_MIN_INTERVAL_MS - (now - last)) / 1000)}s between saves`,
    );
  }
  lastSaveAt.set(rateKey, now);

  const versionId = randomUUID();

  // Archive the current index.html into history/<versionId>/ before
  // overwriting. Mirrors runGeneration's success path so version rows
  // remain consistently retrievable via readHtml(..., versionId).
  const indexAbs = screenIndexHtml(s.projectPath, screen.id);
  assertInsideDesignDir(s.projectPath, indexAbs);
  const histDir = historyDir(s.projectPath, screen.id, versionId);
  assertInsideDesignDir(s.projectPath, histDir);
  try {
    const prev = await fs.promises.readFile(indexAbs);
    await fs.promises.mkdir(histDir, { recursive: true });
    await fs.promises.writeFile(path.join(histDir, 'index.html'), prev);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(
        `failed to archive previous html on save: ${(err as Error).message}`,
      );
    }
    // If there's no prior index.html we still proceed — the screen may
    // have been created but never generated; saving edits anyway is a
    // valid Phase B operation.
  }

  // Strip ALL inline <script> first — this neutralises the bridge-
  // spoofing attack where a hostile inline script in the original
  // generation could forge a 'devspace:snapshot' reply with attacker-
  // chosen HTML. After this strip, the only JS that ends up in the
  // saved file is the bridge IIFE that hardenGeneratedHtml will inject
  // fresh.
  const scriptStripped = stripAllInlineScripts(input.html);

  // Re-harden through the same pipeline as generation output. This
  // re-asserts CSP, strips any javascript: hrefs the user may have
  // inadvertently introduced, refreshes data-devspace-id coverage on
  // any new nodes, and replaces the bridge script (step 0 in
  // hardenGeneratedHtml strips any prior copy so we don't stack).
  const hardened = hardenGeneratedHtml(scriptStripped);

  await fs.promises.mkdir(path.dirname(indexAbs), { recursive: true });
  const tmp = `${indexAbs}.tmp-${randomUUID()}`;
  await fs.promises.writeFile(tmp, hardened);
  await fs.promises.rename(tmp, indexAbs);

  const relHtml = path.relative(designDir(s.projectPath), indexAbs);
  screen.htmlPath = relHtml;

  const nextVersions = [
    ...screen.versions,
    {
      id: versionId,
      createdAt: Date.now(),
      brief: screen.brief,
      htmlPath: relHtml,
      origin: 'edit' as const,
      edits: Array.isArray(input.ops) ? input.ops : [],
      note: typeof input.note === 'string' && input.note.length > 0 ? input.note : undefined,
    },
  ];
  // Same MAX_VERSIONS eviction as generation: drop oldest + rm its
  // history dir so iterative edits don't bloat disk indefinitely.
  while (nextVersions.length > MAX_VERSIONS) {
    const evicted = nextVersions.shift();
    if (evicted) {
      const dir = historyDir(s.projectPath, screen.id, evicted.id);
      try {
        assertInsideDesignDir(s.projectPath, dir);
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `failed to evict version ${evicted.id}: ${(err as Error).message}`,
        );
      }
    }
  }
  screen.versions = nextVersions;
  screen.status = 'ready';
  screen.errorMessage = undefined;
  screen.updatedAt = Date.now();

  await persistScreenMeta(s.projectPath, screen);
  await persistRegistry(s);
  emit(s, 'screen_updated', screen.id, { screen });

  return screen;
}

export async function deleteDesign(
  projectPath: string,
  screenId: string,
): Promise<void> {
  assertValidScreenId(screenId);
  const s = getState(projectPath);
  await s.hydrationPromise;
  const existing = s.screens.get(screenId);
  if (!existing) return;
  // Best-effort cancel — if a run is live, kill it before we tear down
  // the directory underneath it.
  if (existing.status === 'generating' && existing.activeRun) {
    await cancelDesign(projectPath, screenId).catch(() => undefined);
  }
  s.screens.delete(screenId);
  const target = screenDir(s.projectPath, screenId);
  assertInsideDesignDir(s.projectPath, target);
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`failed to remove screen dir: ${(err as Error).message}`);
  }
  await persistRegistry(s);
  emit(s, 'screen_deleted', screenId);
}

// Active run handles keyed by `${projectPath}::${screenId}` so cancel
// can find them. Memory-only — generation isn't designed to survive an
// app restart in Phase A.
const activeRuns = new Map<string, { kill: () => Promise<void> }>();

function runKey(projectPath: string, screenId: string): string {
  return `${path.resolve(projectPath)}::${screenId}`;
}

export async function cancelDesign(
  projectPath: string,
  screenId: string,
): Promise<void> {
  assertValidScreenId(screenId);
  const s = getState(projectPath);
  await s.hydrationPromise;
  const handle = activeRuns.get(runKey(projectPath, screenId));
  if (handle) {
    await handle.kill().catch((err) => {
      logger.warn(`cancel kill failed: ${(err as Error).message}`);
    });
    activeRuns.delete(runKey(projectPath, screenId));
  }
  const screen = s.screens.get(screenId);
  if (screen && screen.status === 'generating') {
    screen.status = screen.versions.length > 0 ? 'ready' : 'pending';
    screen.activeRun = undefined;
    screen.updatedAt = Date.now();
    await persistScreenMeta(s.projectPath, screen);
    await persistRegistry(s);
    emit(s, 'screen_updated', screen.id, { screen });
  }
}

export async function readHtml(
  projectPath: string,
  screenId: string,
  versionId?: string,
): Promise<string> {
  assertValidScreenId(screenId);
  const s = getState(projectPath);
  let file: string;
  if (versionId) {
    assertValidScreenId(versionId);
    file = path.join(historyDir(s.projectPath, screenId, versionId), 'index.html');
  } else {
    file = screenIndexHtml(s.projectPath, screenId);
  }
  assertInsideDesignDir(s.projectPath, file);
  return fs.promises.readFile(file, 'utf8');
}

export function subscribeEvents(projectPath: string, wc: WebContents): void {
  const s = getState(projectPath);
  // Only register the cleanup listener once per WebContents — handlers
  // like DESIGN_LIST / DESIGN_CREATE / DESIGN_REGENERATE all auto-
  // subscribe, and Node's EventEmitter warns above 10 listeners. Guard
  // by checking `subscribers.has` before the side-effect.
  if (s.subscribers.has(wc)) return;
  s.subscribers.add(wc);
  wc.once('destroyed', () => s.subscribers.delete(wc));
}

// ─── skill + design-system discovery ────────────────────────────────────────

export async function listSkills(
  projectPath: string | null,
): Promise<DesignSkill[]> {
  const roots: Array<{ root: string; scope: DesignScope }> = [
    { root: path.join(homedir(), '.claude', 'skills'), scope: 'global' },
  ];
  if (projectPath) {
    roots.push({
      root: path.join(projectPath, '.claude', 'skills'),
      scope: 'project',
    });
  }
  roots.push({
    root: path.join(getBuiltinDesignPacksDir(), 'skills'),
    scope: 'builtin',
  });

  const out: DesignSkill[] = [];
  for (const { root, scope } of roots) {
    await collectDesignSkills(root, scope, out);
  }
  // Same-slug precedence: project beats global beats builtin. We collect
  // everything for transparency, then keep only the highest-precedence
  // entry per slug. Sort the survivors for stable picker output.
  return dedupeBySlug(out);
}

const SCOPE_PRECEDENCE: Record<DesignScope, number> = {
  builtin: 0,
  global: 1,
  project: 2,
};

function dedupeBySlug<T extends { slug: string; scope: DesignScope }>(items: T[]): T[] {
  const byBest = new Map<string, T>();
  for (const item of items) {
    const current = byBest.get(item.slug);
    if (!current || SCOPE_PRECEDENCE[item.scope] > SCOPE_PRECEDENCE[current.scope]) {
      byBest.set(item.slug, item);
    }
  }
  return [...byBest.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function listSystems(
  projectPath: string | null,
): Promise<DesignSystem[]> {
  const roots: Array<{ root: string; scope: DesignScope }> = [
    {
      root: path.join(homedir(), '.claude', 'design-systems'),
      scope: 'global',
    },
  ];
  if (projectPath) {
    roots.push({
      root: path.join(projectPath, '.claude', 'design-systems'),
      scope: 'project',
    });
  }
  roots.push({
    root: path.join(getBuiltinDesignPacksDir(), 'design-systems'),
    scope: 'builtin',
  });

  const out: DesignSystem[] = [];
  for (const { root, scope } of roots) {
    await collectDesignSystems(root, scope, out);
  }
  return dedupeBySlug(out);
}

// Returns the resolved skill body for a given slug. Used by the
// generator to compose the prompt.
export async function readSkillBody(
  projectPath: string | null,
  slug: string,
): Promise<{ skill: DesignSkill; body: string } | null> {
  const skills = await listSkills(projectPath);
  const found = skills.find((s) => s.slug === slug);
  if (!found) return null;
  try {
    const def = await readSkill(found.path);
    return { skill: found, body: def.body };
  } catch (err) {
    logger.warn(
      `failed to read skill body for ${slug}: ${(err as Error).message}`,
    );
    return null;
  }
}

export async function readSystemBody(
  projectPath: string | null,
  slug: string,
): Promise<{ system: DesignSystem; body: string } | null> {
  const systems = await listSystems(projectPath);
  const found = systems.find((s) => s.slug === slug);
  if (!found) return null;
  try {
    const raw = await fs.promises.readFile(found.path, 'utf8');
    return { system: found, body: raw };
  } catch (err) {
    logger.warn(
      `failed to read system body for ${slug}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ─── internals: skill discovery ─────────────────────────────────────────────

// Walks <root>/**/SKILL.md (depth ≤ 2) and yields any entry that looks
// like a design skill. Acceptance is lenient: either the parent dir is
// inside a `design-skills/` subtree OR the frontmatter sets
// `category: design`. The built-in pack uses the subdir convention; user
// skills may use the frontmatter tag.
async function collectDesignSkills(
  root: string,
  scope: DesignScope,
  out: DesignSkill[],
): Promise<void> {
  let topEntries: fs.Dirent[];
  try {
    topEntries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`failed to read ${root}: ${(err as Error).message}`);
    }
    return;
  }

  // Walk one or two levels deep. The accepted layouts are:
  //   <root>/<slug>/SKILL.md
  //   <root>/design-skills/<slug>/SKILL.md
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    const lvl1 = path.join(root, e.name);
    await maybeAddSkill(lvl1, scope, out);
    let lvl2Entries: fs.Dirent[] = [];
    try {
      lvl2Entries = await fs.promises.readdir(lvl1, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e2 of lvl2Entries) {
      if (!e2.isDirectory()) continue;
      await maybeAddSkill(path.join(lvl1, e2.name), scope, out);
    }
  }
}

async function maybeAddSkill(
  dir: string,
  scope: DesignScope,
  out: DesignSkill[],
): Promise<void> {
  const skillFile = path.join(dir, 'SKILL.md');
  let def: SkillDef;
  try {
    def = await readSkill(skillFile);
  } catch {
    return;
  }
  const category =
    typeof def.extra.category === 'string' ? (def.extra.category as string) : '';
  const underDesignSubtree = dir.includes(`${path.sep}design-skills${path.sep}`);
  const looksLikeDesign = underDesignSubtree || category.toLowerCase() === 'design';
  if (!looksLikeDesign) return;
  // De-dupe by slug+scope+path so the two-level walk doesn't yield the
  // same skill twice.
  if (out.some((s) => s.path === skillFile)) return;
  out.push({
    slug: def.slug,
    name: def.name || def.slug,
    description: def.description ?? '',
    scope,
    path: skillFile,
    category,
  });
}

// ─── internals: design-system discovery ─────────────────────────────────────

// Design systems live as `<root>/<slug>/DESIGN.md` (matching skills'
// SKILL.md convention). Frontmatter `brand` is optional and used purely
// for picker labels.
async function collectDesignSystems(
  root: string,
  scope: DesignScope,
  out: DesignSystem[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(`failed to read ${root}: ${(err as Error).message}`);
    }
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, 'DESIGN.md');
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const meta = parseFrontmatter(raw);
    out.push({
      slug: e.name,
      name: meta.name || e.name,
      description: meta.description ?? '',
      scope,
      path: file,
      brand: meta.brand ?? '',
    });
  }
}

// Minimal YAML-ish frontmatter parser — only the fields we care about.
// Skills parser already handles the full case, but design-system docs
// don't have to look like SKILL.md so we keep a lighter implementation
// here.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
  brand?: string;
} {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return {};
  const out: { name?: string; description?: string; brand?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const scalar = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!scalar) continue;
    const key = scalar[1]!.toLowerCase();
    let value = scalar[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
    else if (key === 'brand') out.brand = value;
  }
  return out;
}

// ─── generation orchestration ───────────────────────────────────────────────

async function runGeneration(
  state: ProjectState,
  screen: DesignScreen,
  skill: DesignSkill,
  designSystem: DesignSystem | undefined,
): Promise<void> {
  const key = runKey(state.projectPath, screen.id);
  screen.status = 'generating';
  screen.updatedAt = Date.now();
  screen.errorMessage = undefined;
  await persistScreenMeta(state.projectPath, screen);
  await persistRegistry(state);
  emit(state, 'generation_started', screen.id, { screen });

  try {
    const handle = await generateDesign({
      projectPath: state.projectPath,
      screenId: screen.id,
      skill,
      designSystem,
      brief: screen.brief,
      onProgress: (message) => {
        emit(state, 'generation_progress', screen.id, { message });
      },
      onActiveRun: async (info) => {
        screen.activeRun = info;
        await persistScreenMeta(state.projectPath, screen).catch(() => undefined);
        await persistRegistry(state).catch(() => undefined);
        emit(state, 'screen_updated', screen.id, { screen });
      },
    });
    activeRuns.set(key, { kill: handle.kill });
    const result = await handle.completion;
    activeRuns.delete(key);

    if (result.cancelled) {
      screen.status = screen.versions.length > 0 ? 'ready' : 'pending';
      screen.activeRun = undefined;
      screen.updatedAt = Date.now();
      await persistScreenMeta(state.projectPath, screen);
      await persistRegistry(state);
      emit(state, 'screen_updated', screen.id, { screen });
      return;
    }

    if (result.error || !result.html) {
      screen.status = 'error';
      screen.errorMessage = result.error ?? 'no HTML produced';
      screen.activeRun = undefined;
      screen.updatedAt = Date.now();
      await persistScreenMeta(state.projectPath, screen);
      await persistRegistry(state);
      emit(state, 'generation_error', screen.id, {
        screen,
        message: screen.errorMessage,
      });
      return;
    }

    // Successful generation — archive previous index.html into history
    // before writing the new one. Each version row carries the runId so
    // the UI can deep-link back to the tmux log.
    const versionId = randomUUID();
    const prevHtmlAbs = screenIndexHtml(state.projectPath, screen.id);
    try {
      const prev = await fs.promises.readFile(prevHtmlAbs);
      const histDir = historyDir(state.projectPath, screen.id, versionId);
      await fs.promises.mkdir(histDir, { recursive: true });
      await fs.promises.writeFile(path.join(histDir, 'index.html'), prev);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(
          `failed to archive previous html: ${(err as Error).message}`,
        );
      }
    }
    await fs.promises.mkdir(path.dirname(prevHtmlAbs), { recursive: true });
    // Harden the HTML before persisting: inject a strict CSP, strip
    // remote script/iframe/object/embed tags, and neutralize
    // javascript: hrefs. The iframe sandbox already blocks cookies +
    // same-origin escape; this closes the outbound-fetch + phone-home
    // surface that the sandbox alone cannot.
    const hardened = hardenGeneratedHtml(result.html);
    // Atomic write: tmp + rename, same pattern as the registry.
    const tmp = `${prevHtmlAbs}.tmp-${randomUUID()}`;
    await fs.promises.writeFile(tmp, hardened);
    await fs.promises.rename(tmp, prevHtmlAbs);

    const relHtml = path.relative(designDir(state.projectPath), prevHtmlAbs);
    screen.htmlPath = relHtml;
    const nextVersions = [
      ...screen.versions,
      {
        id: versionId,
        createdAt: Date.now(),
        brief: screen.brief,
        htmlPath: relHtml,
        runId: result.runId,
      },
    ];
    // Cap history at MAX_VERSIONS — discard oldest + rm its history dir so
    // long-iterated screens don't bloat disk usage indefinitely.
    while (nextVersions.length > MAX_VERSIONS) {
      const evicted = nextVersions.shift();
      if (evicted) {
        const dir = historyDir(state.projectPath, screen.id, evicted.id);
        try {
          assertInsideDesignDir(state.projectPath, dir);
          await fs.promises.rm(dir, { recursive: true, force: true });
        } catch (err) {
          logger.warn(`failed to evict version ${evicted.id}: ${(err as Error).message}`);
        }
      }
    }
    screen.versions = nextVersions;
    screen.status = 'ready';
    screen.activeRun = undefined;
    screen.errorMessage = undefined;
    screen.updatedAt = Date.now();
    await persistScreenMeta(state.projectPath, screen);
    await persistRegistry(state);
    emit(state, 'generation_complete', screen.id, { screen });
  } catch (err) {
    activeRuns.delete(key);
    screen.status = 'error';
    screen.errorMessage = (err as Error).message;
    screen.activeRun = undefined;
    screen.updatedAt = Date.now();
    await persistScreenMeta(state.projectPath, screen).catch(() => undefined);
    await persistRegistry(state).catch(() => undefined);
    emit(state, 'generation_error', screen.id, {
      screen,
      message: screen.errorMessage,
    });
  }
}
