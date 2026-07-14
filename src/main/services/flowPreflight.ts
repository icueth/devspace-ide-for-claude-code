// Agent Flow — node preflight ("Test nodes" on the canvas).
//
// One tiny one-shot call per DISTINCT (cli, model, profile) combo answers the
// question the first live runs kept failing on: does this node's runtime
// actually work? A wrong --model makes claude -p exit 1 with NOTHING on either
// stream, and a missing/broken CLI kills a fan-out node mid-run — both are
// cheap to catch here, on the canvas, before any real work is briefed.
//
// This is NOT a run trigger. Probes send "reply OK" and never see the flow's
// prompts; chat remains the only way to start a flow.

import { spawn } from 'node:child_process';

import { resolveAuthEnvPairs } from '@main/services/ClaudeAuthService';
import {
  codexModelArgs,
  resolveClaudeBinary,
} from '@main/services/ClaudeCliLauncher';
import { ensureCodexConfig } from '@main/services/codexConfig';
import { getCliProfile } from '@main/services/CliProfileService';
import { kindOf, validateGraph } from '@main/services/flowScheduler';
import { enrichedPath, findExecutable } from '@main/utils/setupPaths';
import type {
  FlowGraph,
  FlowNode,
  FlowNodeTestResult,
  FlowTestReport,
} from '@shared/flowTypes';

// Generous enough for a cold CLI start + an xhigh-effort "OK", far below a
// wedged process. A probe that can't answer a one-word prompt in this window
// is a real finding, not a false alarm.
const PROBE_TIMEOUT_MS = 90_000;
const PROBE_PROMPT = 'Reply with exactly: OK';

interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

/** One short-lived child: prompt on stdin, verdict from exit code + streams. */
function probeSpawn(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>,
  label: string,
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (o: ProbeOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(o);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, PATH: enrichedPath(), ...extraEnv },
      });
    } catch (err) {
      finish({ ok: false, detail: `${label} — spawn failed: ${(err as Error).message}` });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ ok: false, detail: `${label} — no answer within ${PROBE_TIMEOUT_MS / 1000}s` });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => {
      out = (out + d.toString()).slice(-2_000);
    });
    child.stderr?.on('data', (d) => {
      err = (err + d.toString()).slice(-2_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, detail: `${label} — ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code === 0 && out.trim()) {
        finish({ ok: true, detail: `${label} — OK (${secs}s)` });
        return;
      }
      // The claude bad-model signature: exit 1, silent on BOTH streams.
      const why =
        err.trim() ||
        out.trim().slice(-300) ||
        `exit ${code} with no output — check the model / auth values`;
      finish({ ok: false, detail: `${label} — ${why}` });
    });

    try {
      child.stdin?.write(PROBE_PROMPT);
      child.stdin?.end();
    } catch {
      /* the child's own exit drives the result */
    }
  });
}

/** Probe one distinct runtime combo. */
async function probeCombo(
  node: FlowNode,
  projectPath: string,
): Promise<ProbeOutcome> {
  const model = (node.model ?? '').trim();

  switch (node.cliId) {
    case 'claude': {
      const bin = await resolveClaudeBinary();
      if (!bin) return { ok: false, detail: 'claude — not found on PATH' };
      const auth = await resolveAuthEnvPairs(node.authProfileId);
      const env: Record<string, string> = {};
      for (const pair of auth) {
        const eq = pair.indexOf('=');
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return probeSpawn(
        bin,
        ['-p', '--dangerously-skip-permissions', ...(model ? ['--model', model] : [])],
        projectPath,
        env,
        `claude${model ? ` · ${model}` : ''}`,
      );
    }

    case 'codex': {
      const bin = await findExecutable('codex');
      if (!bin) return { ok: false, detail: 'codex — not found on PATH' };
      const env: Record<string, string> = {};
      if (node.cliProfileId) {
        const profile = await getCliProfile(node.cliProfileId);
        if (!profile || profile.cliId !== 'codex') {
          return { ok: false, detail: 'codex — profile not found (was it deleted?)' };
        }
        const { configDir, keyEnv, keyValue } = await ensureCodexConfig(
          profile,
          projectPath,
        );
        env.CODEX_HOME = configDir;
        env[keyEnv] = keyValue;
      }
      // `codex exec` = codex's own non-interactive mode; the prompt rides argv.
      return probeSpawn(
        bin,
        [
          'exec',
          '--dangerously-bypass-approvals-and-sandbox',
          ...codexModelArgs(node.model),
          PROBE_PROMPT,
        ],
        projectPath,
        env,
        `codex${model ? ` · ${model}` : ''}`,
      );
    }

    case 'gemini': {
      const bin = await findExecutable('gemini');
      if (!bin) return { ok: false, detail: 'gemini — not found on PATH' };
      // A bare positional prompt answers once and exits — a ready-made probe.
      return probeSpawn(
        bin,
        [...(model ? ['-m', model] : []), PROBE_PROMPT],
        projectPath,
        {},
        `gemini${model ? ` · ${model}` : ''}`,
      );
    }

    default: {
      // No non-interactive mode to probe — binary presence is still worth
      // knowing (a missing CLI is the most common way a node dies mid-run).
      const bin = await findExecutable(node.cliId === 'antigravity' ? 'agy' : node.cliId);
      return bin
        ? { ok: true, detail: `${node.cliId} — binary found (runtime not probed)` }
        : { ok: false, detail: `${node.cliId} — not found on PATH` };
    }
  }
}

const comboKey = (n: FlowNode): string =>
  [n.cliId, n.model ?? '', n.authProfileId ?? '', n.cliProfileId ?? ''].join('|');

/**
 * Preflight every executable node. Distinct combos are probed once and shared
 * (three codex nodes on one profile = one probe); same-CLI probes run
 * sequentially — codex's npm self-update is not concurrency-safe (learned the
 * hard way in run dzuqwx).
 */
export async function testFlowNodes(
  projectPath: string,
  graph: FlowGraph,
): Promise<FlowTestReport> {
  const graphErrors = validateGraph(graph);

  const executable = graph.nodes.filter((n) => kindOf(n) !== 'note');
  const combos = new Map<string, FlowNode>();
  for (const n of executable) {
    if (!combos.has(comboKey(n))) combos.set(comboKey(n), n);
  }

  // Group by CLI: parallel across CLIs, sequential within one.
  const byCli = new Map<string, Array<[string, FlowNode]>>();
  for (const [key, node] of combos) {
    const list = byCli.get(node.cliId) ?? [];
    list.push([key, node]);
    byCli.set(node.cliId, list);
  }

  const outcomes = new Map<string, ProbeOutcome>();
  await Promise.all(
    [...byCli.values()].map(async (list) => {
      for (const [key, node] of list) {
        outcomes.set(key, await probeCombo(node, projectPath));
      }
    }),
  );

  const nodes: FlowNodeTestResult[] = executable.map((n) => {
    const o = outcomes.get(comboKey(n)) ?? {
      ok: false,
      detail: 'not probed',
    };
    return { nodeId: n.id, ok: o.ok, detail: o.detail };
  });

  return { graphErrors, nodes };
}
