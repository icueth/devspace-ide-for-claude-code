import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/logger';
import type { CliProfile } from '@shared/types';

// Builds the DevSpace-managed OpenCode config + plugin each opencode tab launches
// with (via OPENCODE_CONFIG_DIR). OpenCode MERGES this over the user's own
// config/auth, so we only ADD DevSpace's Claude-parity layer:
//   • mcp: the MemPalace MCP server (mirrored from its Claude plugin) — same brain.
//   • instructions: the MemPalace usage protocol + this project's distilled
//     learnings (the Claude SessionStart-inject equivalent).
//   • plugins/devspace.js: a plugin replicating Claude's deterministic hooks —
//     rtk command rewriting (tool.execute.before) + distill-on-session-end
//     (session.idle). Plus a custom provider when a CliProfile is selected.

const logger = createLogger('opencode-config');

// Injected into opencode's `instructions` so it uses the memory brain the same
// way Claude does (Claude gets this via a SessionStart hook). Verified: with
// this present, opencode auto-calls mempalace search before answering project
// questions.
const MEMPALACE_PROTOCOL = `# Memory Protocol (MemPalace) — FOLLOW ON EVERY SESSION

You have a persistent memory palace via the \`mempalace\` MCP tools — your
long-term memory across sessions. Storage ≠ memory; storage + this protocol =
memory.

1. WAKE-UP: at the start of each session, call the mempalace **status** tool
   FIRST to load the palace overview (wings, rooms, drawer counts).
2. BEFORE answering about any person, project, past event, or prior decision:
   call the mempalace **search** tool FIRST. Never guess from training data.
3. AFTER meaningful work (finishing a feature, a decision, learning something):
   call the mempalace **diary write** tool to record what changed and why.
4. WHEN facts change: invalidate the old fact, then add the new one.
`;

function projectHash(projectPath: string): string {
  return createHash('sha1').update(projectPath).digest('hex').slice(0, 12);
}

function devspaceConfigDir(projectPath: string, profileId: string): string {
  return path.join(
    os.homedir(),
    '.devspace',
    'opencode',
    `${projectHash(projectPath)}-${profileId}`,
  );
}

// Frontmatter parse — mirrors devspace-learnings.mjs / MemoryService serialize.
function parseEntry(
  raw: string,
  fallbackName: string,
): { type: string; desc: string; body: string } {
  const fm: Record<string, string> = {};
  let body = raw;
  if (raw.startsWith('---')) {
    const idx = raw.indexOf('\n---', 3);
    if (idx >= 0) {
      for (const line of raw.slice(3, idx).split('\n')) {
        const m = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
        if (m) fm[m[1]] = m[2];
      }
      body = raw.slice(idx + 4).replace(/^\n/, '');
    }
  }
  return {
    type: fm.type || 'memory',
    desc: fm.description || fm.name || fallbackName,
    body: body.trim(),
  };
}

// Read this project's distilled learnings + memory from DevSpace native memory
// (~/.devspace/projects/<hash>/memory) — the same source devspace-learnings.mjs
// injects into Claude on SessionStart. Returns '' when there's nothing.
function readProjectLearnings(projectPath: string): string {
  try {
    const memDir = path.join(
      os.homedir(),
      '.devspace',
      'projects',
      projectHash(projectPath),
      'memory',
    );
    const files = fs
      .readdirSync(memDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    const LEARNING_TYPES = new Set(['lesson', 'workflow', 'preference', 'feedback']);
    const learnings: Array<ReturnType<typeof parseEntry>> = [];
    const memory: Array<ReturnType<typeof parseEntry>> = [];
    for (const f of files) {
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(memDir, f), 'utf8');
      } catch {
        continue;
      }
      const e = parseEntry(raw, f.replace(/\.md$/, ''));
      (LEARNING_TYPES.has(e.type) ? learnings : memory).push(e);
    }
    if (learnings.length === 0 && memory.length === 0) return '';
    const fmt = (e: ReturnType<typeof parseEntry>): string => {
      const oneLine = e.body.replace(/\s+/g, ' ').trim();
      const detail = oneLine && oneLine !== e.desc ? ` — ${oneLine.slice(0, 360)}` : '';
      return `- [${e.type}] ${e.desc}${detail}`;
    };
    const sections: string[] = [];
    if (learnings.length) {
      sections.push(
        'Distilled learnings for this project (apply them; do not relearn):\n' +
          learnings.slice(0, 25).map(fmt).join('\n'),
      );
    }
    if (memory.length) {
      sections.push(
        'Project memory notes:\n' + memory.slice(0, 15).map(fmt).join('\n'),
      );
    }
    return (
      'DevSpace native memory for this codebase — treat as established context:\n\n' +
      sections.join('\n\n')
    );
  } catch {
    return '';
  }
}

// Mirror the user's MemPalace MCP command from its installed Claude plugin so
// OpenCode talks to the SAME palace. Returns the spawn argv or null when absent.
export async function resolveMempalaceMcpCommand(): Promise<string[] | null> {
  let cmd = await readPluginMempalaceCommand();
  // The plugin's .mcp.json hardcodes an interpreter path (a venv/uv python).
  // It can be synced from another host, or the venv can move, so command[0] may
  // not exist on THIS machine — observed as opencode/gemini/antigravity failing
  // with "ENOENT … posix_spawn '~/.venv/bin/python'". Repair the interpreter
  // from the local `mempalace` binary, keeping the args (palace path) intact.
  if (cmd && cmd.length > 0 && !fs.existsSync(cmd[0])) {
    const py = resolveMempalacePython();
    cmd = py ? [py, ...cmd.slice(1)] : null;
  }
  // No plugin .mcp.json at all — derive the whole command from the local binary.
  if (!cmd) {
    const py = resolveMempalacePython();
    if (py) cmd = [py, '-m', 'mempalace.mcp_server'];
  }
  return cmd;
}

async function readPluginMempalaceCommand(): Promise<string[] | null> {
  try {
    const dir = path.join(
      os.homedir(),
      '.claude',
      'plugins',
      'cache',
      'mempalace',
      'mempalace',
    );
    const versions = (await fs.promises.readdir(dir)).sort().reverse();
    for (const v of versions) {
      try {
        const raw = await fs.promises.readFile(
          path.join(dir, v, '.mcp.json'),
          'utf8',
        );
        const parsed = JSON.parse(raw) as {
          mempalace?: { command?: string; args?: string[] };
        };
        const mp = parsed.mempalace;
        if (mp?.command) return [mp.command, ...(mp.args ?? [])];
      } catch {
        // try the next version
      }
    }
  } catch {
    // MemPalace plugin not installed.
  }
  return null;
}

/**
 * Resolve the interpreter that runs MemPalace, host-portably. uv-tool / venv
 * installs ship a `mempalace` console script whose shebang points at the real
 * interpreter — read that, falling back to a sibling `python` in its bin dir.
 * Returns null if no local mempalace install is found.
 */
export function resolveMempalacePython(): string | null {
  const home = os.homedir();
  const bins = [
    path.join(home, '.local', 'bin', 'mempalace'),
    path.join(home, '.local', 'share', 'uv', 'tools', 'mempalace', 'bin', 'mempalace'),
    path.join(home, '.venv', 'bin', 'mempalace'),
    '/opt/homebrew/bin/mempalace',
    '/usr/local/bin/mempalace',
  ];
  const bin = bins.find((b) => fs.existsSync(b));
  if (!bin) return null;
  try {
    const firstLine = fs.readFileSync(bin, 'utf8').split('\n', 1)[0] ?? '';
    if (firstLine.startsWith('#!')) {
      const py = firstLine.slice(2).trim().split(/\s+/)[0];
      if (py && fs.existsSync(py)) return py;
    }
  } catch {
    // not a text script (ELF launcher) — fall through to the sibling python
  }
  const sibling = path.join(path.dirname(bin), 'python');
  return fs.existsSync(sibling) ? sibling : null;
}

// The opencode plugin source — replicates Claude's deterministic hooks:
//   • tool.execute.before(bash): rewrite the command via `rtk rewrite` for token
//     savings; self-gating (no-op when rtk is absent or has no equivalent).
//   • session.idle: distill this project's recent activity into learnings via the
//     bundled Stop-hook script (self-throttled to 30 min + anti-recursion).
function pluginSource(distillScript: string): string {
  return `// DevSpace OpenCode plugin — generated. Claude-hook parity (rtk + distill).
export const DevSpacePlugin = async ({ $, directory }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && output.args && typeof output.args.command === "string") {
        const cmd = output.args.command;
        try {
          const res = await $\`rtk rewrite \${cmd}\`.quiet().nothrow();
          if (res.exitCode === 0) {
            const r = res.stdout.toString().trim();
            if (r && r !== cmd) output.args.command = r;
          }
        } catch (e) {}
      }
    },
    "session.idle": async () => {
      try {
        await $\`env CLAUDE_PROJECT_DIR=\${directory} node ${JSON.stringify(distillScript)}\`.quiet().nothrow();
      } catch (e) {}
    },
  };
};
`;
}

// Materialize the per-(project, profile) opencode config + plugin. Returns the
// dir to point OPENCODE_CONFIG_DIR at. 0o600 (holds the provider key).
export async function ensureOpenCodeConfig(
  profile: CliProfile | null,
  projectPath: string = process.cwd(),
): Promise<{ configDir: string }> {
  const configDir = devspaceConfigDir(projectPath, profile ? profile.id : 'default');
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
  };
  const instructions: string[] = [];

  // 1) MemPalace MCP brain + usage protocol.
  const mempalace = await resolveMempalaceMcpCommand();
  if (mempalace) {
    config.mcp = {
      mempalace: { type: 'local', command: mempalace, enabled: true },
    };
    const protocolPath = path.join(configDir, 'mempalace-protocol.md');
    await atomicWriteAsync(protocolPath, MEMPALACE_PROTOCOL, {
      mode: 0o600,
      dirMode: 0o700,
    });
    instructions.push(protocolPath);
  }

  // 2) This project's distilled learnings (Claude SessionStart-inject parity).
  const learnings = readProjectLearnings(projectPath);
  if (learnings) {
    const learningsPath = path.join(configDir, 'project-learnings.md');
    await atomicWriteAsync(learningsPath, learnings, {
      mode: 0o600,
      dirMode: 0o700,
    });
    instructions.push(learningsPath);
  }
  if (instructions.length > 0) config.instructions = instructions;

  // 3) Deterministic-hook plugin (rtk rewrite + distill-on-idle). Loaded from
  // <configDir>/plugins/ (auto-load — the config `plugin` field npm-resolves
  // paths and HANGS, so local plugins MUST go in the dir, not the field).
  try {
    const { getBundledDistillHookFile } = await import('@main/utils/setupPaths');
    await atomicWriteAsync(
      path.join(configDir, 'plugins', 'devspace.js'),
      pluginSource(getBundledDistillHookFile()),
      { mode: 0o600, dirMode: 0o700 },
    );
  } catch (err) {
    logger.warn(`opencode plugin write failed: ${(err as Error).message}`);
  }

  // 4) Custom OpenAI-compatible provider when a profile is chosen.
  if (profile) {
    const providerId = 'custom';
    config.provider = {
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: profile.name,
        options: {
          baseURL: profile.provider.baseURL,
          apiKey: profile.provider.apiKey,
        },
        models: { [profile.provider.model]: {} },
      },
    };
    config.model = `${providerId}/${profile.provider.model}`;
  }

  await atomicWriteAsync(
    path.join(configDir, 'opencode.json'),
    JSON.stringify(config, null, 2),
    { mode: 0o600, dirMode: 0o700 },
  );
  logger.info(
    `wrote opencode config (${profile ? `provider=${profile.name}` : 'default'}) + plugin → ${configDir}`,
  );
  return { configDir };
}
