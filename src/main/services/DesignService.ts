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

import {
  type GenerateDesignResult,
  generateDesign,
} from '@main/services/DesignGenerator';
import type { BuildPromptThemeTokens } from '@main/services/DesignPromptBuilder';
import { DEVSPACE_BRIDGE_SCRIPT } from '@main/services/design/bridgeScript';
import { tagDevspaceIds } from '@main/services/design/idTagger';
import {
  buildProjectProfile,
  loadCachedOrBuild,
} from '@main/services/ProjectProfileBuilder';
import { readSkill } from '@main/services/SkillsService';
import { extractTheme } from '@main/services/ThemeExtractor';
import { getBuiltinDesignPacksDir } from '@main/utils/designResourcePaths';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '@shared/logger';
import type {
  CreateDesignInput,
  DesignEvent,
  DesignEventKind,
  DesignFollowUpInput,
  DesignMessage,
  DesignMessageSegment,
  DesignProject,
  DesignSaveEditsInput,
  DesignScope,
  DesignScreen,
  DesignSkill,
  DesignSystem,
  ProjectDesignProfile,
  RegenerateDesignInput,
} from '@shared/design';
import type { SkillDef } from '@shared/types';

const logger = createLogger('Design');

// Cap stored versions per screen so iteration-heavy users don't accrue
// unbounded `history/<versionId>/index.html` directories on disk. The
// oldest version is evicted (and its history dir removed) once a new
// generation pushes past the cap.
const MAX_VERSIONS = 20;

// v0.10: hard cap on persisted DesignMessage.content size. The HTML
// file on disk is the source of truth for assistant output; the message
// content is purely for UI display. Trim anything past this with a
// `[truncated]` marker so the registry stays readable + bounded.
const MESSAGE_CONTENT_MAX_BYTES = 200 * 1024;
const MESSAGE_TRUNCATION_MARKER = '\n[truncated]';

function truncateMessageContent(raw: string): string {
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes <= MESSAGE_CONTENT_MAX_BYTES) return raw;
  // Slice by UTF-8 byte budget. Buffer.slice gives us a byte-correct
  // cut; back off to character boundary by re-encoding.
  const buf = Buffer.from(raw, 'utf8').slice(
    0,
    MESSAGE_CONTENT_MAX_BYTES - Buffer.byteLength(MESSAGE_TRUNCATION_MARKER, 'utf8'),
  );
  return buf.toString('utf8') + MESSAGE_TRUNCATION_MARKER;
}

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

// Defeats symlink ambushes: assertInsideDesignDir does string comparison
// only, so a hostile project can plant `.devspace/design/screens/x/
// history/y/index.html` as a symlink to `/etc/passwd` and exfiltrate
// arbitrary files into the iframe / dev-server bridge. We lstat the
// target before any read and reject any non-regular-file (symlink,
// socket, device, etc.). All style adapters do this — DesignService
// must too. Returns false if the file simply doesn't exist, so callers
// can still distinguish "missing" (ENOENT) from "hostile" (throws).
async function assertRegularFile(target: string): Promise<boolean> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!st.isFile()) {
    throw new Error(`refusing to read non-regular file: ${target}`);
  }
  return true;
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
  // 3a. Also neutralize SVG `xlink:href="javascript:..."`.
  out = out.replace(
    /\b(xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi,
    '$1="#"',
  );

  // 3b. Strip every on*-event handler attribute. These are the bridge-forgery
  // vector the inline-script defense alone doesn't cover — an `<img onerror
  // ="window.parent.postMessage(...)">` runs in the sandboxed iframe and can
  // forge snapshot replies before the renderer correlates request IDs.
  // Quoted, single-quoted, and bare-value forms all covered.
  out = out.replace(
    /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    '',
  );

  // 3c. Drop `<style>` bodies that contain `expression(` (legacy IE vector
  // that some scanners still ding us on) or `behavior:url(...)`.
  out = out.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
    (_m, css: string) =>
      /expression\s*\(|behavior\s*:\s*url\s*\(/i.test(css)
        ? '<style></style>'
        : `<style>${css}</style>`,
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
  let mutated = false;
  try {
    const parsed = JSON.parse(raw) as { screens?: DesignScreen[] };
    const arr = Array.isArray(parsed.screens) ? parsed.screens : [];
    for (const s of arr) {
      if (s && typeof s.id === 'string') {
        // v0.10: prune legacy version rows whose history dir is missing.
        // Pre-v0.10 generations archived the PREVIOUS index.html under
        // the NEW versionId — so the very first generation had no
        // history dir at all, and clicking that row in the version list
        // produced ENOENT and a blank preview. We drop those rows on
        // hydrate; the latest version (the live index.html) still works
        // via readHtml's fallback path.
        // Stamp historyVersion=2 after prune so we don't re-walk every
        // boot. The actual `index.html` + history dirs created by v0.10+
        // generations are correctly self-contained; older screens just
        // had the off-by-one issue this prune corrects.
        let cleaned: DesignScreen;
        if (s.historyVersion === 2) {
          cleaned = s;
        } else {
          cleaned = {
            ...(await pruneLegacyVersions(state.projectPath, s)),
            historyVersion: 2,
          };
          mutated = true;
        }

        // v0.14 sec-review LOW-4: validate persisted message.segments[]
        // shape. Disk-tampered registries (or older transient bugs) can
        // plant oversize text, unknown kinds, or non-finite bytes that
        // hang the renderer. Sanitize once at hydrate so the in-memory
        // state is always well-formed.
        if (Array.isArray(cleaned.messages)) {
          for (const msg of cleaned.messages) {
            if (Array.isArray(msg.segments)) {
              const sanitized = sanitizeSegments(msg.segments);
              if (sanitized !== msg.segments) {
                msg.segments = sanitized;
                mutated = true;
              }
            }
          }
        }

        // Any screen left mid-generation across a restart is reset to
        // 'error' — Phase A doesn't resume design runs the way chat does
        // since there's no streaming UI to reattach to.
        if (cleaned.status === 'generating') {
          state.screens.set(cleaned.id, {
            ...cleaned,
            status: 'error',
            errorMessage: 'Generation interrupted by app restart',
            activeRun: undefined,
          });
          mutated = true;
        } else {
          state.screens.set(cleaned.id, cleaned);
        }
      }
    }
  } catch (err) {
    logger.warn(`registry parse failed: ${(err as Error).message}`);
  }
  // Persist any mutations from migration / interrupted-generation reset
  // before any other op runs. Without this, a crash between hydrate and
  // the next write would re-walk pruneLegacyVersions on next boot — and
  // because pruneLegacyVersions does I/O (fs.stat per version dir), it
  // could make different decisions on the next run if the disk state
  // changed in the meantime. Persist once, then trust the v2 stamp.
  if (mutated) {
    await persistRegistry(state).catch((err) => {
      logger.warn(
        `hydrate persist failed (migration not durable): ${(err as Error).message}`,
      );
    });
  }
}

// Drop versions whose `history/<id>/index.html` is missing — these are
// the v1 (pre-v0.10) layout artifacts where `runGeneration` archived
// the PREVIOUS html under the NEW versionId. The first-ever generation
// of every screen had no archive at all, so its v1 row points at a dir
// that never existed. Keep the version rows whose dirs DO exist (best
// effort — content may be misaligned but at least readable).
async function pruneLegacyVersions(
  projectPath: string,
  screen: DesignScreen,
): Promise<DesignScreen> {
  if (!Array.isArray(screen.versions) || screen.versions.length === 0) {
    return screen;
  }
  const survivors: typeof screen.versions = [];
  for (const v of screen.versions) {
    // Validate v.id before composing a filesystem path. A tampered
    // designs.json with `v.id = "../../../etc"` would otherwise probe
    // arbitrary filesystem locations via fs.access.
    if (typeof v.id !== 'string' || !SCREEN_ID_RE.test(v.id)) {
      logger.warn(`dropping malformed version id on screen ${screen.id}`);
      continue;
    }
    const file = path.join(historyDir(projectPath, screen.id, v.id), 'index.html');
    try {
      await fs.promises.access(file);
      survivors.push(v);
    } catch {
      logger.warn(
        `dropping legacy version ${v.id} for screen ${screen.id} (missing history file)`,
      );
    }
  }
  return { ...screen, versions: survivors };
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
  // Cap user-supplied brief size at the same limit as assistant content
  // — paste-bomb defence + bounds the eventual prompt.
  const cappedBrief =
    typeof input.brief === 'string' ? truncateMessageContent(input.brief) : '';
  // v0.10: seed the chat transcript from the initial brief so every
  // generation, including the first, has a user turn in `messages`.
  // The renderer can still synthesize a transcript for legacy screens
  // via listMessages, but new screens carry it natively.
  const initialMessages: DesignMessage[] =
    cappedBrief.trim().length > 0
      ? [
          {
            id: randomUUID(),
            role: 'user',
            content: cappedBrief,
            ts: now,
          },
        ]
      : [];

  // v0.14: optional page-name hint flows from CreateDesignInput onto
  // the screen so the screen list can label it ("Checkout") and so
  // every follow-up generation can pass the same anchor sentence into
  // the prompt without re-asking the user.
  const pageName = sanitizePageName(input.pageName);

  const screen: DesignScreen = {
    id: randomUUID(),
    name: input.name.trim() || 'Untitled screen',
    skillSlug: input.skillSlug,
    designSystemSlug: input.designSystemSlug,
    brief: cappedBrief,
    status: 'pending',
    htmlPath: null,
    createdAt: now,
    updatedAt: now,
    versions: [],
    messages: initialMessages,
    historyVersion: 2,
    pageName,
  };

  s.screens.set(screen.id, screen);
  await persistScreenMeta(s.projectPath, screen);
  await persistRegistry(s);
  emit(s, 'screen_created', screen.id, { screen });

  // Fire-and-forget generation. Errors propagate to the renderer as
  // 'generation_error' events, so we don't need to await this. Using
  // void to make the lint check happy.
  // v0.14: createDesign never re-uses theme — there's no prior version
  // yet, so we always pass reuseTheme=false here.
  void runGeneration(s, screen, skill, designSystem, false);

  return screen;
}

// v0.14 sec-review LOW-4: validate + size-cap persisted message
// segments on hydrate. Disk-tampered registries can plant unknown
// `kind`, oversize text, or non-finite bytes that hang the renderer.
// Drops malformed entries, caps text/preview to 8 KB and segments.length
// to 16. Returns the SAME array reference when no changes were needed,
// so the caller can detect mutations cheaply.
const SEGMENT_TEXT_MAX = 8 * 1024;
const SEGMENTS_LEN_MAX = 16;
function sanitizeSegments(raw: unknown): DesignMessageSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignMessageSegment[] = [];
  let mutated = false;
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      mutated = true;
      continue;
    }
    const kind = (item as { kind?: unknown }).kind;
    if (kind === 'prose') {
      const t = (item as { text?: unknown }).text;
      if (typeof t !== 'string') {
        mutated = true;
        continue;
      }
      const text = t.length > SEGMENT_TEXT_MAX ? t.slice(0, SEGMENT_TEXT_MAX) : t;
      if (text !== t) mutated = true;
      out.push({ kind: 'prose', text });
    } else if (kind === 'html') {
      const b = (item as { bytes?: unknown }).bytes;
      const bytes =
        typeof b === 'number' && Number.isFinite(b) && b >= 0
          ? Math.floor(b)
          : 0;
      if (bytes !== b) mutated = true;
      const p = (item as { preview?: unknown }).preview;
      let preview: string | undefined;
      if (typeof p === 'string') {
        preview = p.length > SEGMENT_TEXT_MAX ? p.slice(0, SEGMENT_TEXT_MAX) : p;
        if (preview !== p) mutated = true;
      } else if (p !== undefined) {
        mutated = true;
      }
      out.push(preview === undefined ? { kind: 'html', bytes } : { kind: 'html', bytes, preview });
    } else {
      // Unknown kind — drop.
      mutated = true;
    }
    if (out.length >= SEGMENTS_LEN_MAX) {
      if (raw.length > SEGMENTS_LEN_MAX) mutated = true;
      break;
    }
  }
  if (!mutated && out.length === raw.length) {
    // Return the original ref so callers can `!==`-check for mutation.
    return raw as DesignMessageSegment[];
  }
  return out;
}

// Trim + cap a user-supplied pageName. Empty / non-string → undefined
// so the field stays absent on the persisted screen (cleaner registry
// than `pageName: ""`). 80 chars is generous for a page label without
// allowing prompt-blow-up.
const PAGE_NAME_MAX_CHARS = 80;
function sanitizePageName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // Strip control chars that would break the prompt's anchor sentence
  // before clipping length — same defence as transcript content.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length <= PAGE_NAME_MAX_CHARS
    ? cleaned
    : cleaned.slice(0, PAGE_NAME_MAX_CHARS);
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
  // Claim the generating slot synchronously, BEFORE any await. Without
  // this, two quick double-submits both pass the status check, both
  // await disk reads, both invoke runGeneration — the second orphans
  // the first's tmux session.
  screen.status = 'generating';
  // Clear stale error / activeRun state before kicking a new run so the
  // toolbar banner doesn't reappear for a frame and a dead activeRun
  // pill doesn't resurrect between screen_updated and generation_started.
  screen.errorMessage = undefined;
  screen.activeRun = undefined;

  if (typeof input.brief === 'string') {
    // v0.10: a fresh brief turns into a new user turn so the transcript
    // pane shows it as part of the conversation. Legacy renderers that
    // only call `regenerate` still get backward-compatible behaviour
    // because we keep `screen.brief` in sync with the latest user turn.
    ensureMessagesSeeded(screen);
    // Cap the user-supplied brief size before persisting — the same
    // hard cap that protects assistant-streamed content also protects
    // user-supplied content from disk-fill and prompt blow-up.
    screen.brief = truncateMessageContent(input.brief);
    if (input.brief.trim().length > 0) {
      const userTurn: DesignMessage = {
        id: randomUUID(),
        role: 'user',
        content: truncateMessageContent(input.brief),
        ts: Date.now(),
      };
      screen.messages = [...(screen.messages ?? []), userTurn];
    }
  }
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

  void runGeneration(s, screen, skill, designSystem, input.reuseTheme === true);
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

  // v0.10 history layout v2: write the NEW content to BOTH `index.html`
  // AND `history/<newVersionId>/index.html`. Each version row gets its
  // own self-contained dir at write time — no more off-by-one between
  // version id and its archived html.
  const indexAbs = screenIndexHtml(s.projectPath, screen.id);
  assertInsideDesignDir(s.projectPath, indexAbs);
  const histDir = historyDir(s.projectPath, screen.id, versionId);
  assertInsideDesignDir(s.projectPath, histDir);

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
  // History file FIRST (same write-order invariant as runGeneration).
  // A crash between the two writes leaves the OLD index.html in place
  // and an orphaned history dir — harmless, swept by eviction.
  await fs.promises.mkdir(histDir, { recursive: true });
  const histAbs = path.join(histDir, 'index.html');
  const histTmp = `${histAbs}.tmp-${randomUUID()}`;
  await fs.promises.writeFile(histTmp, hardened);
  await fs.promises.rename(histTmp, histAbs);
  // Then atomically replace index.html.
  const tmp = `${indexAbs}.tmp-${randomUUID()}`;
  await fs.promises.writeFile(tmp, hardened);
  await fs.promises.rename(tmp, indexAbs);

  const relHtml = path.relative(designDir(s.projectPath), indexAbs);
  screen.htmlPath = relHtml;
  screen.historyVersion = 2;

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
  // Drop the rate-limit entry so deleted screens don't accumulate in
  // the lastSaveAt map across long-running sessions.
  lastSaveAt.delete(`${s.projectPath}::${screenId}`);
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
// `kill` is undefined during the window between runGeneration claiming
// the slot and generateDesign() resolving with a tmux handle. During
// that window cancelDesign sets `cancelRequested=true` and runGeneration
// honours it as soon as the handle arrives. This closes the race where
// a user clicked Cancel before tmux finished spawning — previously the
// kill handle landed too late and a stray version was committed.
interface ActiveRunEntry {
  kill?: () => Promise<void>;
  cancelRequested?: boolean;
}
const activeRuns = new Map<string, ActiveRunEntry>();

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
  const key = runKey(projectPath, screenId);
  const entry = activeRuns.get(key);
  if (entry) {
    if (entry.kill) {
      await entry.kill().catch((err) => {
        logger.warn(`cancel kill failed: ${(err as Error).message}`);
      });
      activeRuns.delete(key);
    } else {
      // Run hasn't received its kill handle yet — flag for cancel-on-arrival.
      // runGeneration will call kill() as soon as generateDesign resolves.
      entry.cancelRequested = true;
    }
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
  await s.hydrationPromise;
  if (versionId) {
    assertValidScreenId(versionId);
    const histFile = path.join(
      historyDir(s.projectPath, screenId, versionId),
      'index.html',
    );
    assertInsideDesignDir(s.projectPath, histFile);
    if (await assertRegularFile(histFile)) {
      return fs.promises.readFile(histFile, 'utf8');
    }
    // ENOENT fallback for legacy (v1) screens whose latest version row
    // never got a history file written. If `versionId` refers to the LAST
    // version on the screen, fall through to `index.html` — it is the
    // latest content. For older versions there's nothing to serve.
    const screen = s.screens.get(screenId);
    const last = screen?.versions[screen.versions.length - 1];
    if (last && last.id === versionId) {
      const indexAbs = screenIndexHtml(s.projectPath, screenId);
      assertInsideDesignDir(s.projectPath, indexAbs);
      if (!(await assertRegularFile(indexAbs))) {
        throw Object.assign(new Error('index.html missing'), {
          code: 'ENOENT',
        });
      }
      return fs.promises.readFile(indexAbs, 'utf8');
    }
    throw Object.assign(new Error('version html missing'), { code: 'ENOENT' });
  }
  const indexAbs = screenIndexHtml(s.projectPath, screenId);
  assertInsideDesignDir(s.projectPath, indexAbs);
  if (!(await assertRegularFile(indexAbs))) {
    throw Object.assign(new Error('index.html missing'), { code: 'ENOENT' });
  }
  return fs.promises.readFile(indexAbs, 'utf8');
}

export function subscribeEvents(projectPath: string, wc: WebContents): void {
  const s = getState(projectPath);
  if (s.subscribers.has(wc)) return;
  s.subscribers.add(wc);
  ensureDestroyHook(wc);
}

// Ensure each WebContents gets at most one 'destroyed' hook across all
// projects. Without this guard, every subscribe call registered a fresh
// listener — opening 11+ projects in a window blew past Node's default
// MaxListeners cap and leaked WebContents references via the closures.
// Pattern mirrored from DevServerService.
const wcDestroyHooks = new WeakSet<WebContents>();
function ensureDestroyHook(wc: WebContents): void {
  if (wcDestroyHooks.has(wc)) return;
  wcDestroyHooks.add(wc);
  wc.once('destroyed', () => {
    for (const s of states.values()) s.subscribers.delete(wc);
  });
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
    const lst = await fs.promises.lstat(found.path);
    if (!lst.isFile()) {
      throw new Error(`refusing non-regular system body: ${found.path}`);
    }
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
  // The bundled built-in pack lives at `resources/design-packs/skills/<slug>/`
  // and contains only design skills by construction — trust it without
  // requiring a marker. User-supplied skills (global/project scope) must
  // opt in via the `design-skills/` subtree or `category: design`
  // frontmatter to avoid picking up unrelated skills.
  const looksLikeDesign =
    scope === 'builtin' ||
    underDesignSubtree ||
    category.toLowerCase() === 'design';
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

// Seed the transcript when a screen was created pre-v0.10 (no messages
// field) but has a brief. Returns the seeded messages array; safe to
// call multiple times (idempotent — returns existing array when set).
function ensureMessagesSeeded(screen: DesignScreen): DesignMessage[] {
  if (Array.isArray(screen.messages)) return screen.messages;
  const seed: DesignMessage[] = [];
  if (typeof screen.brief === 'string' && screen.brief.trim().length > 0) {
    seed.push({
      id: randomUUID(),
      role: 'user',
      content: screen.brief,
      ts: screen.createdAt,
    });
  }
  screen.messages = seed;
  return seed;
}

// v0.14: derive the persisted assistant segments. The generator's
// `segments` is the source of truth; we only need to recompute the
// `bytes` on the html segment to reflect the HARDENED on-disk size
// (CSP injection + bridge IIFE add a few hundred bytes vs. the raw
// extractor output). Returns [] when the generator handed back
// nothing — caller leaves `segments` absent so the renderer falls
// back to `content`.
function pickFinalSegments(
  result: GenerateDesignResult,
  htmlRelPath: string,
): DesignMessageSegment[] {
  if (!Array.isArray(result.segments) || result.segments.length === 0) {
    return [];
  }
  // We don't actually use htmlRelPath right now — the byte count on
  // the segment reflects the extracted html (pre-hardening). That's
  // the right size for a "Generated index.html — N KB" hint: it
  // ignores the bridge IIFE which is the same on every generation.
  // Keeping the param so a future revision can swap to the on-disk
  // byte count without changing the call site.
  void htmlRelPath;
  return result.segments;
}

// v0.14: read the prior (most-recent) ready version's HTML and pull
// theme tokens out of it. Returns undefined when no prior version
// exists, when the file is missing, or when the extractor finds zero
// signal — so the caller can omit the constraint cleanly.
async function loadPriorThemeTokens(
  projectPath: string,
  screen: DesignScreen,
): Promise<BuildPromptThemeTokens | undefined> {
  // No prior version → no theme to keep.
  if (!Array.isArray(screen.versions) || screen.versions.length === 0) {
    return undefined;
  }
  // Prefer reading the LIVE index.html (the latest ready content) over
  // walking history — same file the user is iterating on, and we don't
  // have to guess about v1/v2 history layout.
  const indexAbs = screenIndexHtml(projectPath, screen.id);
  try {
    assertInsideDesignDir(projectPath, indexAbs);
    // Defeat symlink swaps that could otherwise point this read at an
    // arbitrary file on the host.
    if (!(await assertRegularFile(indexAbs))) return undefined;
    const html = await fs.promises.readFile(indexAbs, 'utf8');
    const tokens = extractTheme(html);
    if (!tokens) return undefined;
    return tokens;
  } catch (err) {
    logger.warn(
      `reuseTheme: failed to extract prior theme: ${(err as Error).message}`,
    );
    return undefined;
  }
}

async function runGeneration(
  state: ProjectState,
  screen: DesignScreen,
  skill: DesignSkill,
  designSystem: DesignSystem | undefined,
  reuseTheme: boolean,
): Promise<void> {
  const key = runKey(state.projectPath, screen.id);

  // v0.10: ensure the screen has a transcript. The active user turn is
  // the LAST message in `screen.messages` (the caller seeded it via
  // followUp / createDesign), or — for legacy screens — we seed one
  // from the stored brief so the generator sees something to render.
  ensureMessagesSeeded(screen);

  screen.status = 'generating';
  screen.updatedAt = Date.now();
  screen.errorMessage = undefined;
  // Claim the activeRuns slot BEFORE any await so cancelDesign called
  // during tmux spawn / prompt build can register its intent on this
  // entry. `kill` lands once generateDesign resolves; until then,
  // cancel sets `cancelRequested=true` and we honour it post-await.
  activeRuns.set(key, {});
  await persistScreenMeta(state.projectPath, screen);
  await persistRegistry(state);
  emit(state, 'generation_started', screen.id, { screen });

  // v0.10: emit the active user turn so the renderer's transcript pane
  // sees it as soon as generation kicks off. The message is already in
  // `screen.messages` — this is the streaming notification.
  const lastUser = [...(screen.messages ?? [])]
    .reverse()
    .find((m) => m.role === 'user');
  if (lastUser) {
    emit(state, 'message_appended', screen.id, { designMessage: lastUser });
  }

  // v0.10: create the assistant turn placeholder up front so the
  // renderer can render the streaming bubble immediately. Tokens
  // appended by `onProgress` will flow into this message via
  // `message_updated` events.
  const assistantId = randomUUID();
  const assistantMessage: DesignMessage = {
    id: assistantId,
    role: 'assistant',
    content: '',
    streaming: true,
    ts: Date.now(),
  };
  (screen.messages ??= []).push(assistantMessage);
  emit(state, 'message_appended', screen.id, { designMessage: assistantMessage });

  // v0.10: load the project profile (cache-first). Detection is
  // best-effort — a failure here must not block generation; we log and
  // continue without injecting Project Context.
  let projectProfile: ProjectDesignProfile | null = null;
  try {
    projectProfile = await loadCachedOrBuild(state.projectPath);
  } catch (err) {
    logger.warn(
      `profile load failed (continuing without): ${(err as Error).message}`,
    );
  }

  // v0.14: when the caller asked to lock the theme to the prior
  // version's tokens, read the most recent ready HTML and extract its
  // color + font signal. Best-effort: a missing or unreadable prior
  // file (first generation, deleted history, etc.) leaves tokens
  // undefined and we proceed without the constraint.
  let reuseThemeTokens: BuildPromptThemeTokens | undefined;
  if (reuseTheme) {
    reuseThemeTokens = await loadPriorThemeTokens(state.projectPath, screen);
  }

  // Buffer streaming output so we cap memory + can mirror the same
  // truncation logic into the persisted message. The HTML on disk
  // remains the source of truth — this buffer is purely for UI.
  let streamingContent = '';

  try {
    const handle = await generateDesign({
      projectPath: state.projectPath,
      screenId: screen.id,
      skill,
      designSystem,
      brief: screen.brief,
      messages: screen.messages,
      projectProfile,
      pageName: screen.pageName,
      reuseThemeTokens,
      onProgress: (message) => {
        emit(state, 'generation_progress', screen.id, { message });

        // Mirror the streamed line into the assistant message. We
        // append raw lines (claude streams them line-by-line under
        // `--output-format text`). Trim to the byte cap so an oversize
        // response doesn't bloat the in-memory message.
        const nextContent = streamingContent
          ? `${streamingContent}\n${message}`
          : message;
        streamingContent = truncateMessageContent(nextContent);
        assistantMessage.content = streamingContent;
        emit(state, 'message_updated', screen.id, {
          designMessage: assistantMessage,
        });
      },
      onActiveRun: async (info) => {
        screen.activeRun = info;
        await persistScreenMeta(state.projectPath, screen).catch(() => undefined);
        await persistRegistry(state).catch(() => undefined);
        emit(state, 'screen_updated', screen.id, { screen });
      },
    });
    // If the user pressed Cancel during the await above (tmux spawn /
    // prompt build), the pre-claimed entry now has cancelRequested=true.
    // Kill the freshly-spawned handle immediately so we don't waste a
    // generation cycle. The handle's tail loop will resolve with
    // cancelled=true and we fall into the cancel finalize branch below.
    const pending = activeRuns.get(key);
    const cancelPending = pending?.cancelRequested === true;
    activeRuns.set(key, { kill: handle.kill });
    if (cancelPending) {
      await handle.kill().catch((err) => {
        logger.warn(`pending cancel kill failed: ${(err as Error).message}`);
      });
    }
    const result = await handle.completion;
    activeRuns.delete(key);

    if (result.cancelled) {
      screen.status = screen.versions.length > 0 ? 'ready' : 'pending';
      screen.activeRun = undefined;
      screen.updatedAt = Date.now();
      // Finalize the assistant turn even on cancel — UI needs to know
      // the streaming bubble is no longer mutating.
      assistantMessage.streaming = false;
      assistantMessage.content = truncateMessageContent(
        streamingContent || '[cancelled]',
      );
      // Clear stale segments from a prior run on the same message ref so
      // the renderer doesn't show a "Generated index.html" card under a
      // [cancelled] message body (code-review BLOCKER-1).
      assistantMessage.segments = undefined;
      await persistScreenMeta(state.projectPath, screen);
      await persistRegistry(state);
      emit(state, 'screen_updated', screen.id, { screen });
      emit(state, 'message_finalized', screen.id, {
        designMessage: assistantMessage,
      });
      return;
    }

    if (result.error || !result.html) {
      screen.status = 'error';
      screen.errorMessage = result.error ?? 'no HTML produced';
      screen.activeRun = undefined;
      screen.updatedAt = Date.now();
      assistantMessage.streaming = false;
      assistantMessage.content = truncateMessageContent(
        streamingContent || `[error] ${screen.errorMessage}`,
      );
      // v0.14: even on the no-HTML error path the generator hands back
      // segments (typically a single prose segment with Claude's
      // refusal or clarifying question). Persist them so the UI can
      // show what Claude actually said instead of a bare "no HTML"
      // banner.
      if (Array.isArray(result.segments) && result.segments.length > 0) {
        assistantMessage.segments = result.segments;
      }
      await persistScreenMeta(state.projectPath, screen);
      await persistRegistry(state);
      emit(state, 'generation_error', screen.id, {
        screen,
        message: screen.errorMessage,
      });
      emit(state, 'message_finalized', screen.id, {
        designMessage: assistantMessage,
      });
      return;
    }

    // Successful generation. v0.10 history layout v2: write the NEW
    // content to BOTH `index.html` AND `history/<versionId>/index.html`
    // so every version row has a self-contained dir at write time. No
    // more off-by-one mislabel between version id and archived html.
    const versionId = randomUUID();
    const indexAbs = screenIndexHtml(state.projectPath, screen.id);
    assertInsideDesignDir(state.projectPath, indexAbs);
    const histDir = historyDir(state.projectPath, screen.id, versionId);
    assertInsideDesignDir(state.projectPath, histDir);

    await fs.promises.mkdir(path.dirname(indexAbs), { recursive: true });
    // Harden the HTML before persisting: inject a strict CSP, strip
    // remote script/iframe/object/embed tags, and neutralize
    // javascript: hrefs. The iframe sandbox already blocks cookies +
    // same-origin escape; this closes the outbound-fetch + phone-home
    // surface that the sandbox alone cannot.
    const hardened = hardenGeneratedHtml(result.html);
    // Write history file FIRST so a partial-write crash leaves the OLD
    // index.html in place. If we wrote index.html first and crashed
    // before the history write, version[last]'s history dir would not
    // exist and the latest index.html would be the NEW content while
    // the version row still pointed at the OLD — silent corruption.
    await fs.promises.mkdir(histDir, { recursive: true });
    const histAbs = path.join(histDir, 'index.html');
    const histTmp = `${histAbs}.tmp-${randomUUID()}`;
    await fs.promises.writeFile(histTmp, hardened);
    await fs.promises.rename(histTmp, histAbs);
    // Then atomically replace index.html — readers see new content only
    // after the history dir is fully committed.
    const tmp = `${indexAbs}.tmp-${randomUUID()}`;
    await fs.promises.writeFile(tmp, hardened);
    await fs.promises.rename(tmp, indexAbs);

    const relHtml = path.relative(designDir(state.projectPath), indexAbs);
    screen.htmlPath = relHtml;
    screen.historyVersion = 2;
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

    // Finalize the assistant message — link it to the new version so
    // the UI can jump from the transcript turn into the version's
    // preview, and flip `streaming` off.
    assistantMessage.streaming = false;
    assistantMessage.versionId = versionId;
    assistantMessage.content = truncateMessageContent(
      streamingContent.length > 0 ? streamingContent : '',
    );
    // v0.14: persist the prose+html+prose split onto the assistant
    // turn so the chat surface can render the explanation as a normal
    // message bubble and the HTML as a compact "Generated index.html —
    // 38 KB" card. Pre-v0.14 turns persist with `segments` absent;
    // renderer falls back to `content` in that case.
    const finalizedSegments = pickFinalSegments(result, screen.htmlPath ?? '');
    if (finalizedSegments.length > 0) {
      assistantMessage.segments = finalizedSegments;
    }

    await persistScreenMeta(state.projectPath, screen);
    await persistRegistry(state);
    emit(state, 'generation_complete', screen.id, { screen });
    emit(state, 'message_finalized', screen.id, {
      designMessage: assistantMessage,
    });
  } catch (err) {
    activeRuns.delete(key);
    screen.status = 'error';
    screen.errorMessage = (err as Error).message;
    screen.activeRun = undefined;
    screen.updatedAt = Date.now();
    assistantMessage.streaming = false;
    assistantMessage.content = truncateMessageContent(
      streamingContent || `[error] ${screen.errorMessage}`,
    );
    // Clear any stale segments from a prior run on the same message ref —
    // a thrown exception in the runner means we have no fresh segments to
    // attach, and showing the previous run's "Generated …" card under an
    // error message would mislead users (code-review BLOCKER-1).
    assistantMessage.segments = undefined;
    await persistScreenMeta(state.projectPath, screen).catch(() => undefined);
    await persistRegistry(state).catch(() => undefined);
    emit(state, 'generation_error', screen.id, {
      screen,
      message: screen.errorMessage,
    });
    emit(state, 'message_finalized', screen.id, {
      designMessage: assistantMessage,
    });
  }
}

// ─── v0.10 public API: followUp / listMessages / profile ────────────────────

export async function followUp(input: DesignFollowUpInput): Promise<DesignScreen> {
  assertValidScreenId(input.screenId);
  if (typeof input.message !== 'string' || input.message.trim() === '') {
    throw new Error('follow-up message is empty');
  }
  const s = getState(input.projectPath);
  await s.hydrationPromise;
  const screen = s.screens.get(input.screenId);
  if (!screen) throw new Error(`screen not found: ${input.screenId}`);
  if (screen.status === 'generating') {
    throw new Error(`screen ${input.screenId} is already generating`);
  }
  // Claim the generating slot synchronously, BEFORE any await. Prevents
  // re-entrancy when the user double-submits during the IPC roundtrip.
  screen.status = 'generating';
  screen.errorMessage = undefined;
  screen.activeRun = undefined;

  // Optional design-system swap mid-conversation.
  if (typeof input.designSystemSlug === 'string') {
    screen.designSystemSlug = input.designSystemSlug;
  }

  // Seed messages if the screen was created pre-v0.10 (only `brief`
  // was persisted). Append the new user turn, then update brief so
  // legacy code paths still see the "current request". Cap the user
  // content size so a paste-bomb can't bloat disk / future prompts.
  ensureMessagesSeeded(screen);
  const cappedMessage = truncateMessageContent(input.message);
  const userTurn: DesignMessage = {
    id: randomUUID(),
    role: 'user',
    content: cappedMessage,
    ts: Date.now(),
  };
  screen.messages = [...(screen.messages ?? []), userTurn];
  screen.brief = cappedMessage;
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
  // The user turn is also emitted explicitly so renderers that listen
  // only for `message_*` (and skip `screen_updated`) still see it.
  emit(s, 'message_appended', screen.id, { designMessage: userTurn });

  void runGeneration(s, screen, skill, designSystem, input.reuseTheme === true);
  return screen;
}

export async function listMessages(
  projectPath: string,
  screenId: string,
): Promise<DesignMessage[]> {
  assertValidScreenId(screenId);
  const s = getState(projectPath);
  await s.hydrationPromise;
  const screen = s.screens.get(screenId);
  if (!screen) return [];
  if (Array.isArray(screen.messages)) return screen.messages;
  if (typeof screen.brief === 'string' && screen.brief.trim().length > 0) {
    return [
      {
        id: 'legacy-brief',
        role: 'user',
        content: screen.brief,
        ts: screen.createdAt,
      },
    ];
  }
  return [];
}

export async function getProfile(
  projectPath: string,
): Promise<ProjectDesignProfile | null> {
  return loadCachedOrBuild(projectPath);
}

export async function rebuildProfile(
  projectPath: string,
): Promise<ProjectDesignProfile | null> {
  return buildProjectProfile({ projectPath, force: true });
}
