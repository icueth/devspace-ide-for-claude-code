import { MessageSquare, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type {
  FlowGraph,
  FlowNode,
  FlowNodeRun,
  FlowRun,
} from '@shared/flowTypes';
import type { CliId, ClaudeAuthProfile, CliProfile } from '@shared/types';

const CLI_IDS: CliId[] = ['claude', 'codex', 'gemini', 'opencode', 'antigravity'];

interface Props {
  graph: FlowGraph;
  node: FlowNode | null;
  run: FlowRun | null;
  nodeRun: FlowNodeRun | null;
  onUpdateNode: (id: string, patch: Partial<FlowNode>) => void;
  onDeleteNode: (id: string) => void;
  onUpdateMeta: (patch: Partial<Pick<FlowGraph, 'name' | 'description'>>) => void;
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
  onDeleteFlow,
  onOpenSession,
}: Props) {
  const [authProfiles, setAuthProfiles] = useState<ClaudeAuthProfile[]>([]);
  const [cliProfiles, setCliProfiles] = useState<CliProfile[]>([]);

  useEffect(() => {
    void api.claudeAuth.list().then(setAuthProfiles).catch(() => undefined);
    void api.cli.listProfiles().then(setCliProfiles).catch(() => undefined);
  }, []);

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-surface-2">
      {node ? (
        <NodeFields
          node={node}
          nodeRun={nodeRun}
          authProfiles={authProfiles}
          cliProfiles={cliProfiles.filter((p) => p.cliId === node.cliId)}
          onUpdate={(patch) => onUpdateNode(node.id, patch)}
          onDelete={() => onDeleteNode(node.id)}
          onOpenSession={() => onOpenSession(node.id)}
        />
      ) : (
        <FlowFields
          graph={graph}
          run={run}
          onUpdateMeta={onUpdateMeta}
          onDeleteFlow={onDeleteFlow}
        />
      )}
    </aside>
  );
}

function NodeFields({
  node,
  nodeRun,
  authProfiles,
  cliProfiles,
  onUpdate,
  onDelete,
  onOpenSession,
}: {
  node: FlowNode;
  nodeRun: FlowNodeRun | null;
  authProfiles: ClaudeAuthProfile[];
  cliProfiles: CliProfile[];
  onUpdate: (patch: Partial<FlowNode>) => void;
  onDelete: () => void;
  onOpenSession: () => void;
}) {
  const isClaude = node.cliId === 'claude';
  return (
    <>
      <Head title={node.role || 'agent'} kind="agent" />

      <Field label="Role name">
        <input
          type="text"
          value={node.role}
          onChange={(e) => onUpdate({ role: e.target.value })}
          className={inputCls}
        />
      </Field>

      <Field label="CLI provider">
        <select
          value={node.cliId}
          onChange={(e) => {
            const cliId = e.target.value as CliId;
            // Headless is `claude -p` only (see flowTypes / validateGraph):
            // switching to another provider must not leave an unrunnable graph.
            onUpdate({
              cliId,
              cliProfileId: undefined,
              ...(cliId !== 'claude' && node.mode === 'headless'
                ? { mode: 'interactive' as const }
                : {}),
            });
          }}
          className={inputCls}
        >
          {CLI_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </Field>

      {isClaude ? (
        <Field label="Auth profile">
          <select
            value={node.authProfileId ?? ''}
            onChange={(e) =>
              onUpdate({ authProfileId: e.target.value || undefined })
            }
            className={inputCls}
          >
            {/* '' = whatever the CLI would use on its own (subscription). */}
            <option value="">Default</option>
            {authProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label="CLI profile">
          <select
            value={node.cliProfileId ?? ''}
            onChange={(e) =>
              onUpdate({ cliProfileId: e.target.value || undefined })
            }
            className={inputCls}
          >
            <option value="">{node.cliId} default</option>
            {cliProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Execution">
        <div className="flex overflow-hidden rounded-md border border-border">
          <ModeBtn
            on={node.mode === 'headless'}
            disabled={!isClaude}
            title={
              isClaude
                ? 'claude -p — output is captured and handed downstream'
                : 'Headless runs `claude -p` — only available for the claude CLI'
            }
            onClick={() => onUpdate({ mode: 'headless' })}
          >
            Headless
          </ModeBtn>
          <ModeBtn
            on={node.mode === 'interactive'}
            title="A real tmux session you can dock and watch"
            onClick={() => onUpdate({ mode: 'interactive' })}
          >
            Terminal pane
          </ModeBtn>
        </div>
        {!isClaude && (
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-dim">
            Headless is claude-only in phase 1 — {node.cliId} nodes run as a
            terminal pane.
          </p>
        )}
      </Field>

      <Field label="Role prompt">
        <textarea
          rows={5}
          value={node.rolePrompt}
          placeholder="What does this agent do with the upstream output?"
          onChange={(e) => onUpdate({ rolePrompt: e.target.value })}
          className={cn(inputCls, 'min-h-[80px] resize-y leading-relaxed')}
        />
      </Field>

      {nodeRun?.error && (
        <Field label="Last error">
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-semantic-error/40 bg-surface p-2 font-mono text-[10.5px] text-semantic-error">
            {nodeRun.error}
          </pre>
        </Field>
      )}

      <div className="mt-auto flex gap-2 border-t border-border p-3">
        {nodeRun?.sessionKey && (
          <button
            type="button"
            onClick={onOpenSession}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border-emphasis bg-surface-3 px-2 py-1.5 text-[12px] text-text transition hover:border-accent hover:text-accent"
          >
            <SquareArrowOutUpRight size={11} />
            Open live session
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          title="Delete node"
          aria-label="Delete node"
          className="flex items-center justify-center rounded-md border border-border px-2.5 py-1.5 text-semantic-error transition hover:border-semantic-error"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </>
  );
}

function FlowFields({
  graph,
  run,
  onUpdateMeta,
  onDeleteFlow,
}: {
  graph: FlowGraph;
  run: FlowRun | null;
  onUpdateMeta: (patch: Partial<Pick<FlowGraph, 'name' | 'description'>>) => void;
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

      {/* Chat is the ONLY run trigger (product decision) — the canvas designs
          and monitors. This box exists so the missing Run button reads as
          intent, not as an unfinished feature. */}
      <div className="mx-3 mt-2 rounded-md border border-border bg-surface-3 p-3">
        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-text">
          <MessageSquare size={12} className="text-accent" />
          Flows run from chat
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-muted">
          Ask the lead agent in a CLI session — it picks a flow by description
          and starts it with its <code className="font-mono text-accent">run_flow</code>{' '}
          tool. There is no Run button here by design.
        </p>
      </div>

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

      <div className="mt-auto flex border-t border-border p-3">
        <button
          type="button"
          onClick={onDeleteFlow}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-semantic-error transition hover:border-semantic-error"
        >
          <Trash2 size={12} />
          Delete flow
        </button>
      </div>
    </>
  );
}

const inputCls =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text outline-none transition focus:border-accent';

function Head({ title, kind }: { title: string; kind: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
      <h2 className="flex-1 truncate text-[13.5px] font-semibold text-text">{title}</h2>
      <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9.5px] text-text-dim">
        {kind}
      </span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3">
      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </label>
      {children}
    </div>
  );
}

function ModeBtn({
  on,
  disabled,
  title,
  onClick,
  children,
}: {
  on: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'flex-1 px-2 py-1.5 text-[11.5px] transition',
        on ? 'bg-accent/10 text-accent' : 'bg-surface text-text-muted hover:text-text',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      {children}
    </button>
  );
}
