import { cn } from '@renderer/lib/utils';

/** Shared form furniture for the inspector panels. */

export const inputCls =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12.5px] text-text outline-none transition focus:border-accent';

// Claude models a node may pin. Suggestions, not a closed list: `--model` also
// takes aliases and full ids, and the CLI's own default (empty) is valid.
// Values `claude --model` actually accepts: the CLI's short aliases. Marketing
// names ("opus-4.8", "fable-5") make print-mode exit 1 with model_not_found —
// the first real flow run died on exactly that. Full ids (claude-opus-4-8)
// also work; the free-text input allows them.
export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];

export function Head({ title, kind }: { title: string; kind: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
      <h2 className="flex-1 truncate text-[13.5px] font-semibold text-text">{title}</h2>
      <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[9.5px] text-text-dim">
        {kind}
      </span>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-3 pt-3">
      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </label>
      {children}
    </div>
  );
}

export function ModeBtn({
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

/** The model picker — free text; claude gets alias suggestions (CLAUDE_MODELS),
 *  codex/gemini ride their profile's provider so any model it serves is legal. */
export function ModelField({
  cliId,
  value,
  onChange,
}: {
  cliId: string;
  value: string | undefined;
  onChange: (model: string | undefined) => void;
}) {
  const isClaude = cliId === 'claude';
  return (
    <Field label="Model">
      <input
        type="text"
        list={isClaude ? 'flow-claude-models' : undefined}
        value={value ?? ''}
        placeholder={isClaude ? 'CLI default' : 'profile default'}
        onChange={(e) => onChange(e.target.value.trim() || undefined)}
        className={inputCls}
      />
      {isClaude && (
        <datalist id="flow-claude-models">
          {CLAUDE_MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      )}
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-dim">
        {isClaude ? (
          <>
            Passed as <code className="font-mono text-accent">--model</code> — a claude
            alias (fable / opus / sonnet / haiku) or a full model id. Leave empty for
            the CLI's default.
          </>
        ) : (
          <>
            Passed as{' '}
            <code className="font-mono text-accent">
              {cliId === 'gemini' ? '-m' : '--model'}
            </code>{' '}
            — any model your {cliId} profile's provider serves. Leave empty for the
            profile's own default.
          </>
        )}
      </p>
    </Field>
  );
}
