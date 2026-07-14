import { SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  Field,
  Head,
  ModeBtn,
  ModelField,
  inputCls,
} from '@renderer/components/Flows/FlowInspectorBits';
import { cn } from '@renderer/lib/utils';
import type { FlowNode, FlowNodeRun } from '@shared/flowTypes';
import type { ClaudeAuthProfile, CliId, CliProfile } from '@shared/types';

const CLI_IDS: CliId[] = ['claude', 'codex', 'gemini', 'opencode', 'antigravity'];

interface Props {
  node: FlowNode;
  nodeRun: FlowNodeRun | null;
  authProfiles: ClaudeAuthProfile[];
  cliProfiles: CliProfile[];
  onUpdate: (patch: Partial<FlowNode>) => void;
  onDelete: () => void;
  onOpenSession: () => void;
}

/** Kind-aware node inspector: agent, gate, or note. */
export function NodeFields(props: Props) {
  switch (props.node.kind ?? 'agent') {
    case 'gate':
      return <GateFields {...props} />;
    case 'note':
      return <NoteFields {...props} />;
    default:
      return <AgentFields {...props} />;
  }
}

function AgentFields({
  node,
  nodeRun,
  authProfiles,
  cliProfiles,
  onUpdate,
  onDelete,
  onOpenSession,
}: Props) {
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

      {/* One flat picker, dock-style: built-in CLIs plus every custom provider
          profile as a first-class entry ("codex · MaxPlus"), so choosing a
          custom setup is one click — not provider first, profile second. */}
      <Field label="CLI">
        <select
          value={node.cliProfileId ? `${node.cliId}::${node.cliProfileId}` : node.cliId}
          onChange={(e) => {
            const [cliId, profileId] = e.target.value.split('::') as [
              CliId,
              string | undefined,
            ];
            // Headless is `claude -p` only (see flowTypes / validateGraph):
            // switching to another provider must not leave an unrunnable graph.
            // `model` values are provider-specific ('opus' means nothing to
            // codex) — a provider change always clears it. Auth profile is a
            // claude thing — dropped when leaving claude.
            onUpdate({
              cliId,
              cliProfileId: profileId || undefined,
              model: undefined,
              ...(cliId !== 'claude'
                ? {
                    authProfileId: undefined,
                    ...(node.mode === 'headless' ? { mode: 'interactive' as const } : {}),
                  }
                : {}),
            });
          }}
          className={inputCls}
        >
          {CLI_IDS.map((id) => (
            <option key={id} value={id}>
              {id === 'claude' ? 'claude' : `${id} (default)`}
            </option>
          ))}
          {cliProfiles.length > 0 && (
            <optgroup label="Custom profiles">
              {cliProfiles.map((p) => (
                <option key={p.id} value={`${p.cliId}::${p.id}`}>
                  {p.cliId} · {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>

      {/* The custom-profile choice lives in the CLI picker above; claude keeps
          its separate credentials select (same split as the dock's + menu). */}
      {isClaude && (
        <Field label="Auth profile">
          <select
            value={node.authProfileId ?? ''}
            onChange={(e) => onUpdate({ authProfileId: e.target.value || undefined })}
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
      )}

      {/* claude, codex, and gemini all take a per-session model flag; opencode
          and antigravity have none, so their model stays profile-driven. */}
      {['claude', 'codex', 'gemini'].includes(node.cliId) && (
        <ModelField
          cliId={node.cliId}
          value={node.model}
          onChange={(model) => onUpdate({ model })}
        />
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
            Headless is claude-only — {node.cliId} nodes run as a terminal pane.
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

      {nodeRun?.attempts && nodeRun.attempts > 1 && (
        <Field label="Attempts">
          <div className="rounded-md border border-semantic-warning/40 bg-semantic-warning/10 px-2 py-1.5 font-mono text-[11px] text-semantic-warning">
            re-queued by a gate · attempt {nodeRun.attempts}
          </div>
        </Field>
      )}

      {nodeRun?.error && (
        <Field label="Last error">
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-semantic-error/40 bg-surface p-2 font-mono text-[10.5px] text-semantic-error">
            {nodeRun.error}
          </pre>
        </Field>
      )}

      <Footer onDelete={onDelete}>
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
      </Footer>
    </>
  );
}

function GateFields({ node, nodeRun, onUpdate, onDelete }: Props) {
  return (
    <>
      <Head title={node.role || 'gate'} kind="gate" />

      <Field label="Gate name">
        <input
          type="text"
          value={node.role}
          placeholder="tests pass?"
          onChange={(e) => onUpdate({ role: e.target.value })}
          className={inputCls}
        />
      </Field>

      <Field label="Condition">
        <textarea
          rows={4}
          value={node.condition ?? ''}
          placeholder="The tester's output shows the suite passing with 0 failures."
          onChange={(e) => onUpdate({ condition: e.target.value })}
          className={cn(inputCls, 'min-h-[72px] resize-y leading-relaxed')}
        />
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-dim">
          A claude judge reads the upstream output and answers{' '}
          <code className="font-mono text-semantic-success">PASS</code> or{' '}
          <code className="font-mono text-semantic-error">FAIL</code>. Write it so a
          one-word answer is possible.
        </p>
      </Field>

      <MaxRetriesField node={node} onUpdate={onUpdate} />

      {/* The gate judge always runs on claude -p, whatever the node's cliId. */}
      <ModelField
        cliId="claude"
        value={node.model}
        onChange={(model) => onUpdate({ model })}
      />

      {nodeRun?.verdict && (
        <Field label="Latest verdict">
          <div
            className={cn(
              'rounded-md border px-2 py-1.5 font-mono text-[11px]',
              nodeRun.verdict === 'pass'
                ? 'border-semantic-success/40 bg-semantic-success/10 text-semantic-success'
                : 'border-semantic-error/40 bg-semantic-error/10 text-semantic-error',
            )}
          >
            {nodeRun.verdict.toUpperCase()}
            {nodeRun.attempts && nodeRun.attempts > 1
              ? ` · attempt ${nodeRun.attempts}`
              : ''}
          </div>
        </Field>
      )}

      {nodeRun?.error && (
        <Field label="Last error">
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-semantic-error/40 bg-surface p-2 font-mono text-[10.5px] text-semantic-error">
            {nodeRun.error}
          </pre>
        </Field>
      )}

      <Footer onDelete={onDelete} />
    </>
  );
}

/**
 * Max retries, committed on blur / Enter — never per keystroke.
 *
 * Clamping as the user types cannot work: the way to reach "10" is to type "1"
 * first, and a clamp on every change rewrites that to 1 (and persists it) before
 * the 0 arrives — the field is unable to hold two digits. So the input owns its
 * text while focused, and only a finished edit is clamped and written back.
 */
function MaxRetriesField({
  node,
  onUpdate,
}: {
  node: FlowNode;
  onUpdate: (patch: Partial<FlowNode>) => void;
}) {
  const current = node.maxRetries ?? 3;
  const [text, setText] = useState(String(current));

  // Re-sync when the inspector switches node, or when a commit clamps the value
  // under us (15 → 10). Not while typing: the node's value does not move then.
  useEffect(() => {
    setText(String(node.maxRetries ?? 3));
  }, [node.id, node.maxRetries]);

  const commit = (): void => {
    const n = Math.round(Number(text.trim()));
    if (!text.trim() || !Number.isFinite(n)) {
      setText(String(current)); // '' or junk — the last good value stands
      return;
    }
    const clamped = Math.min(10, Math.max(1, n));
    setText(String(clamped));
    if (clamped !== current) onUpdate({ maxRetries: clamped });
  };

  return (
    <Field label="Max retries">
      <input
        type="number"
        min={1}
        max={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        className={inputCls}
      />
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-dim">
        How many times the fail branch may re-queue its target before the run
        fails. The fail edge is the only legal cycle in a flow.
      </p>
    </Field>
  );
}

function NoteFields({ node, onUpdate, onDelete }: Props) {
  return (
    <>
      <Head title="Note" kind="note" />

      <Field label="Text">
        <textarea
          rows={8}
          value={node.noteText ?? ''}
          placeholder="Why is this flow shaped like this?"
          onChange={(e) => onUpdate({ noteText: e.target.value })}
          className={cn(inputCls, 'min-h-[140px] resize-y leading-relaxed')}
        />
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-dim">
          Notes are annotations for whoever reads the canvas next. They are never
          executed and may not carry edges.
        </p>
      </Field>

      <Footer onDelete={onDelete} />
    </>
  );
}

function Footer({
  children,
  onDelete,
}: {
  children?: React.ReactNode;
  onDelete: () => void;
}) {
  return (
    <div className="mt-auto flex gap-2 border-t border-border p-3">
      {children}
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
  );
}
