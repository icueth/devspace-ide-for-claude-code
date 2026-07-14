import { Copy, FlaskConical, MessageSquare, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Field, Head, inputCls } from '@renderer/components/Flows/FlowInspectorBits';
import { NodeFields } from '@renderer/components/Flows/FlowInspectorNode';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useFlowsStore } from '@renderer/state/flows';
import type { FlowGraph, FlowNode, FlowNodeRun, FlowRun } from '@shared/flowTypes';
import type { ClaudeAuthProfile, CliProfile } from '@shared/types';

interface Props {
  graph: FlowGraph;
  node: FlowNode | null;
  run: FlowRun | null;
  nodeRun: FlowNodeRun | null;
  onUpdateNode: (id: string, patch: Partial<FlowNode>) => void;
  onDeleteNode: (id: string) => void;
  onUpdateMeta: (patch: Partial<Pick<FlowGraph, 'name' | 'description'>>) => void;
  onCloneFlow: () => void;
  onDeleteFlow: () => void;
  onOpenSession: (nodeId: string) => void;
}

export function FlowInspector({
  graph,
  node,
  run,
  nodeRun,
  onUpdateNode,
  onDeleteNode,
  onUpdateMeta,
  onCloneFlow,
  onDeleteFlow,
  onOpenSession,
}: Props) {
  const [authProfiles, setAuthProfiles] = useState<ClaudeAuthProfile[]>([]);
  const [cliProfiles, setCliProfiles] = useState<CliProfile[]>([]);

  useEffect(() => {
    void api.claudeAuth
      .list()
      .then(setAuthProfiles)
      .catch(() => undefined);
    void api.cli
      .listProfiles()
      .then(setCliProfiles)
      .catch(() => undefined);
  }, []);

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface-2">
      {node ? (
        <NodeFields
          node={node}
          nodeRun={nodeRun}
          authProfiles={authProfiles}
          cliProfiles={cliProfiles}
          onUpdate={(patch) => onUpdateNode(node.id, patch)}
          onDelete={() => onDeleteNode(node.id)}
          onOpenSession={() => onOpenSession(node.id)}
        />
      ) : (
        <FlowFields
          graph={graph}
          run={run}
          onUpdateMeta={onUpdateMeta}
          onCloneFlow={onCloneFlow}
          onDeleteFlow={onDeleteFlow}
        />
      )}
    </aside>
  );
}

function FlowFields({
  graph,
  run,
  onUpdateMeta,
  onCloneFlow,
  onDeleteFlow,
}: {
  graph: FlowGraph;
  run: FlowRun | null;
  onUpdateMeta: (patch: Partial<Pick<FlowGraph, 'name' | 'description'>>) => void;
  onCloneFlow: () => void;
  onDeleteFlow: () => void;
}) {
  return (
    <>
      <Head title="Flow settings" kind="flow" />

      <Field label="Name">
        <input
          type="text"
          value={graph.name}
          onChange={(e) => onUpdateMeta({ name: e.target.value })}
          className={inputCls}
        />
      </Field>

      <Field label="Description">
        <textarea
          rows={3}
          value={graph.description}
          placeholder="When should the lead pick this flow? e.g. multi-step feature work with tests"
          onChange={(e) => onUpdateMeta({ description: e.target.value })}
          className={cn(inputCls, 'min-h-[64px] resize-y leading-relaxed')}
        />
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-dim">
          The lead agent reads this verbatim when choosing which flow a task
          belongs to. Be specific about when to use it.
        </p>
      </Field>

      {/* Chat is the ONLY run trigger (product decision) — and chat lives in the
          dock, not here. This box exists so the missing Run button reads as
          intent, not as an unfinished feature. */}
      <div className="mx-3 mt-2 rounded-md border border-border bg-surface-3 p-3">
        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-text">
          <MessageSquare size={12} className="text-accent" />
          Flows run from your claude tab
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
          Runs start from your claude tab in the dock — it picks a flow by
          description and starts it with{' '}
          <code className="font-mono text-accent">run_flow</code>. Pin this flow to
          a tab: right-click the tab → Use flow.
        </p>
      </div>

      <TestNodesPanel />

      {run && (
        <Field label="Latest run">
          <div className="rounded-md border border-border bg-surface p-2 font-mono text-[10.5px] text-text-muted">
            <div className="truncate text-text">{run.task}</div>
            <div className="mt-1 text-text-dim">
              {run.status} · {run.nodes.filter((n) => n.status === 'done').length}/
              {run.nodes.length} done
            </div>
          </div>
        </Field>
      )}

      <div className="mt-auto flex gap-2 border-t border-border p-3">
        {/* A flow carries ONE live run at a time — cloning is how the same
            process runs in parallel (each copy monitored on its own canvas). */}
        <button
          type="button"
          onClick={onCloneFlow}
          title="Duplicate this flow — run the same process in parallel, monitored separately"
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-text-muted transition hover:border-accent hover:text-accent"
        >
          <Copy size={12} />
          Clone flow
        </button>
        <button
          type="button"
          onClick={onDeleteFlow}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-semantic-error transition hover:border-semantic-error"
        >
          <Trash2 size={12} />
          Delete flow
        </button>
      </div>
    </>
  );
}

/**
 * Preflight ("Test nodes"): one tiny probe per distinct CLI/model/profile in
 * this flow — surfaces a broken value here instead of silently mid-run. This
 * is deliberately NOT a run button: probes answer "OK", they never see the
 * flow's briefs; chat remains the only run trigger.
 */
function TestNodesPanel() {
  const testing = useFlowsStore((s) => s.testing);
  const report = useFlowsStore((s) => s.nodeTests);

  return (
    <div className="mx-3 mt-2">
      <button
        type="button"
        disabled={testing}
        onClick={() => void useFlowsStore.getState().testNodes()}
        title="Probe every node's CLI + model + profile with a one-word call — no flow work runs"
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-text-muted transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        <FlaskConical size={12} className={cn(testing && 'animate-pulse')} />
        {testing ? 'Testing nodes…' : 'Test nodes'}
      </button>

      {report && (
        <div className="mt-2 space-y-1 rounded-md border border-border bg-surface p-2">
          {report.graphErrors.map((e) => (
            <div key={e} className="text-[10.5px] leading-relaxed text-semantic-error">
              ✗ graph: {e}
            </div>
          ))}
          {report.nodes.map((r) => (
            <div
              key={r.nodeId}
              className={cn(
                'font-mono text-[10.5px] leading-relaxed',
                r.ok ? 'text-text-muted' : 'text-semantic-error',
              )}
            >
              {r.ok ? '✓' : '✗'} {r.nodeId}: {r.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
