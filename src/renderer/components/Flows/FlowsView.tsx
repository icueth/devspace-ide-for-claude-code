import { Plus, Spline } from 'lucide-react';
import { useEffect } from 'react';

import { FlowCanvas } from '@renderer/components/Flows/FlowCanvas';
import { FlowChatPanel } from '@renderer/components/Flows/FlowChatPanel';
import { FlowInspector } from '@renderer/components/Flows/FlowInspector';
import { FlowRunLog } from '@renderer/components/Flows/FlowRunLog';
import { openFlowSession } from '@renderer/lib/flowSession';
import { cn } from '@renderer/lib/utils';
import { latestRunFor, statusByNode, useFlowsStore } from '@renderer/state/flows';
import { FLOW_TEMPLATES } from '@renderer/state/flowTemplates';
import type { FlowNodeRun } from '@shared/flowTypes';

interface Props {
  projectPath: string;
}

export function FlowsView({ projectPath }: Props) {
  const flows = useFlowsStore((s) => s.flows);
  const runs = useFlowsStore((s) => s.runs);
  const draft = useFlowsStore((s) => s.draft);
  const loading = useFlowsStore((s) => s.loading);
  const selectedFlowId = useFlowsStore((s) => s.selectedFlowId);
  const selectedNodeId = useFlowsStore((s) => s.selectedNodeId);
  const loadForProject = useFlowsStore((s) => s.loadForProject);
  const flush = useFlowsStore((s) => s.flush);

  useEffect(() => {
    void loadForProject(projectPath);
  }, [projectPath, loadForProject]);

  // Debounced saves die with the tab otherwise — flush the pending write on
  // unmount (tab close, project switch) and when the window loses focus.
  useEffect(() => {
    const onBlur = () => void flush();
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      void flush();
    };
  }, [flush]);

  const run = draft ? latestRunFor(runs, draft.id) : null;
  const statuses = statusByNode(run);
  const sessionKeys: Record<string, string> = {};
  const nodeRuns: Record<string, FlowNodeRun> = {};
  for (const n of run?.nodes ?? []) {
    nodeRuns[n.nodeId] = n;
    if (n.sessionKey) sessionKeys[n.nodeId] = n.sessionKey;
  }

  const openSession = (nodeId: string) => {
    const key = sessionKeys[nodeId];
    if (run && key) openFlowSession(run, key);
  };

  const selectedNode = draft?.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const nodeRun = selectedNodeId ? (nodeRuns[selectedNodeId] ?? null) : null;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-text-muted">
        Loading flows…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <FlowList selectedFlowId={selectedFlowId} />

      {/* Chat sits LEFT of the canvas (mockup order): it is the entry point to
          the whole feature — you talk first, the canvas shows what happens.
          It renders with or without a flow; you can ask the lead for work
          before any flow exists. */}
      <FlowChatPanel projectPath={projectPath} />

      {draft ? (
        <>
          {/* Canvas + run log share a column: the log reads the run the canvas
              is showing, so it must never outlive it. */}
          <div className="flex min-w-0 flex-1 flex-col">
            <FlowCanvas
              graph={draft}
              statuses={statuses}
              nodeRuns={nodeRuns}
              sessionKeys={sessionKeys}
              selectedNodeId={selectedNodeId}
              onSelectNode={useFlowsStore.getState().selectNode}
              onMoveNode={useFlowsStore.getState().moveNode}
              onAddNode={useFlowsStore.getState().addNode}
              onConnect={useFlowsStore.getState().connect}
              onDeleteNode={useFlowsStore.getState().deleteNode}
              onDisconnect={(edge) =>
                useFlowsStore.getState().disconnect(edge.from, edge.to, edge.branch)
              }
              onSetEdgeBranch={useFlowsStore.getState().setEdgeBranch}
              onOpenSession={openSession}
            />
            <FlowRunLog run={run} />
          </div>
          <FlowInspector
            graph={draft}
            node={selectedNode}
            run={run}
            nodeRun={nodeRun}
            onUpdateNode={useFlowsStore.getState().updateNode}
            onDeleteNode={useFlowsStore.getState().deleteNode}
            onUpdateMeta={useFlowsStore.getState().updateFlowMeta}
            onDeleteFlow={() => {
              if (draft) void useFlowsStore.getState().deleteFlow(draft.id);
            }}
            onOpenSession={openSession}
          />
        </>
      ) : (
        <EmptyState hasFlows={flows.length > 0} />
      )}
    </div>
  );
}

function FlowList({ selectedFlowId }: { selectedFlowId: string | null }) {
  const flows = useFlowsStore((s) => s.flows);
  const runs = useFlowsStore((s) => s.runs);
  const selectFlow = useFlowsStore((s) => s.selectFlow);
  const createFlow = useFlowsStore((s) => s.createFlow);

  return (
    <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
          Flows
        </span>
        <button
          type="button"
          // Wrapped: onClick would otherwise hand the MouseEvent to templateId.
          onClick={() => createFlow()}
          title="New empty flow"
          aria-label="New flow"
          className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition hover:bg-accent/10 hover:text-accent"
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5">
        {flows.map((f) => {
          const running = latestRunFor(runs, f.id)?.status === 'running';
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => selectFlow(f.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition',
                f.id === selectedFlowId
                  ? 'bg-accent/10 text-text'
                  : 'text-text-muted hover:bg-surface-3 hover:text-text',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  running
                    ? 'bg-semantic-success shadow-[0_0_6px_var(--color-accent)]'
                    : 'bg-text-dim',
                )}
              />
              <span className="truncate">{f.name}</span>
            </button>
          );
        })}
      </div>

      <TemplateRail />
    </nav>
  );
}

/** Templates are the real "new flow" path — a blank canvas teaches nothing. */
function TemplateRail() {
  const createFlow = useFlowsStore((s) => s.createFlow);
  return (
    <div className="shrink-0 border-t border-border p-1.5">
      <span className="mb-1 block px-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-dim">
        Templates
      </span>
      {FLOW_TEMPLATES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => createFlow(t.id)}
          title={t.blurb}
          className="mb-1 w-full rounded-md border border-border bg-surface-3 px-2 py-1.5 text-left transition hover:border-accent/40 hover:bg-accent/5"
        >
          <div className="truncate font-mono text-[10px] text-text-dim">{t.glyph}</div>
          <div className="mt-0.5 truncate text-[12px] font-medium text-text">
            {t.title}
          </div>
          <div className="truncate text-[10px] text-text-muted">{t.blurb}</div>
        </button>
      ))}
    </div>
  );
}

function EmptyState({ hasFlows }: { hasFlows: boolean }) {
  const createFlow = useFlowsStore((s) => s.createFlow);
  return (
    <div className="flex flex-1 items-center justify-center bg-surface">
      <div className="max-w-sm rounded-xl border border-border bg-surface-2 p-6 text-center">
        <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
          <Spline size={16} />
        </div>
        <h2 className="text-[14px] font-semibold text-text">
          {hasFlows ? 'Pick a flow' : 'No flows yet'}
        </h2>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-muted">
          A flow is a graph of real CLI agents — each node runs an agent, each
          edge hands its output to the next. Start from a template, then ask the
          lead in chat to run it.
        </p>

        <div className="mt-4 space-y-1.5 text-left">
          {FLOW_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => createFlow(t.id)}
              className="flex w-full items-center gap-3 rounded-md border border-border bg-surface-3 px-3 py-2 transition hover:border-accent/40 hover:bg-accent/5"
            >
              <span className="shrink-0 font-mono text-[10px] text-text-dim">
                {t.glyph}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-text">
                  {t.title}
                </span>
                <span className="block truncate text-[10.5px] text-text-muted">
                  {t.blurb}
                </span>
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => createFlow()}
          className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] text-text-muted transition hover:text-accent"
        >
          <Plus size={12} />
          or start from an empty flow
        </button>
      </div>
    </div>
  );
}
