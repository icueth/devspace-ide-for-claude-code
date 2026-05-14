import {
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  PlayCircle,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import type {
  DesignAppPlan,
  DesignAppPlanStatus,
  DesignScreenStatus,
  PlannedScreen,
} from '@shared/design';

export interface AppPlanCardProps {
  plan: DesignAppPlan;
  projectPath: string;
  /**
   * Selects the (already-materialized) screen in the parent DesignView's
   * screen list. No-op when the screen hasn't been materialized yet.
   */
  onSelectScreen: (screenId: string) => void;
  /** Re-opens the AppPlanDialog at Stage 2 for this plan. */
  onOpenPlan: (plan: DesignAppPlan) => void;
  /** Triggers the parent's confirm + delete flow. */
  onDelete: (appId: string) => void;
  /** Triggers `api.design.runBatch` for this plan. */
  onRunBatch: (appId: string) => void;
}

/**
 * Sidebar card representing one DesignAppPlan. Header shows the app name
 * + a status pill; the body lists planned screens with status dots. A "…"
 * menu in the header offers re-open / generate-all / delete.
 *
 * The component never owns its own dialogs — every destructive action is
 * delegated upward so the parent can present a single confirm UX.
 */
export function AppPlanCard({
  plan,
  projectPath: _projectPath,
  onSelectScreen,
  onOpenPlan,
  onDelete,
  onRunBatch,
}: AppPlanCardProps) {
  const [open, setOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the popover menu on outside click / Esc.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

  const canGenerate = plan.status === 'approved';
  const isBatching = plan.screens.some((s) => s.status === 'generating');

  return (
    <div className="border-b border-border-subtle bg-surface-2/40">
      {/* Header */}
      <div className="group flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Collapse' : 'Expand'}
          className="rounded p-0.5 text-text-muted transition hover:bg-surface-3 hover:text-text"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        <Layers size={10} className="shrink-0 text-text-muted" />
        <span
          className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-text"
          title={plan.name}
        >
          {plan.name}
        </span>
        <StatusPill status={plan.status} batching={isBatching} />
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title="App actions"
            className="rounded p-0.5 text-text-muted opacity-0 transition hover:bg-surface-3 hover:text-text group-hover:opacity-100 aria-expanded:opacity-100"
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={12} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-[110%] z-30 w-[180px] rounded-[8px] border border-border bg-surface-2 p-1 shadow-[0_18px_40px_rgba(0,0,0,0.5)]"
            >
              <MenuButton
                label="Open plan editor"
                icon={<Pencil size={11} />}
                onClick={() => {
                  setMenuOpen(false);
                  onOpenPlan(plan);
                }}
              />
              <MenuButton
                label={isBatching ? 'Generating…' : 'Generate all'}
                icon={
                  isBatching ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <PlayCircle size={11} />
                  )
                }
                disabled={!canGenerate || isBatching}
                onClick={() => {
                  setMenuOpen(false);
                  onRunBatch(plan.appId);
                }}
              />
              <div className="my-1 h-px bg-border-subtle" />
              <MenuButton
                label="Delete app"
                icon={<Trash2 size={11} />}
                danger
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(plan.appId);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Body — planned screen list */}
      {open && (
        <ul className="pb-1">
          {plan.screens.length === 0 ? (
            <li className="px-3 pb-1 text-[10.5px] text-text-dim">
              No screens in this plan.
            </li>
          ) : (
            plan.screens.map((s) => (
              <PlannedScreenRow
                key={s.id}
                screen={s}
                onClick={() => {
                  if (s.screenId) onSelectScreen(s.screenId);
                }}
              />
            ))
          )}
        </ul>
      )}

      {plan.planError && (
        <div className="px-3 pb-2 text-[10px] text-semantic-error">
          {plan.planError}
        </div>
      )}
    </div>
  );
}

interface PlannedScreenRowProps {
  screen: PlannedScreen;
  onClick: () => void;
}

function PlannedScreenRow({ screen, onClick }: PlannedScreenRowProps) {
  const clickable = !!screen.screenId;
  return (
    <li>
      <button
        type="button"
        disabled={!clickable}
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] transition',
          clickable
            ? 'text-text-secondary hover:bg-surface-3 hover:text-text'
            : 'cursor-default text-text-muted',
        )}
        title={
          clickable ? screen.brief : 'Will be created when the plan is approved.'
        }
      >
        <ScreenStatusDot status={screen.status} />
        <span className="min-w-0 flex-1 truncate">{screen.name}</span>
      </button>
    </li>
  );
}

function ScreenStatusDot({ status }: { status: DesignScreenStatus }) {
  const color =
    status === 'ready'
      ? 'bg-semantic-success'
      : status === 'generating'
        ? 'bg-accent animate-pulse'
        : status === 'error'
          ? 'bg-semantic-error'
          : 'bg-text-dim';
  return (
    <span
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', color)}
      title={status}
    />
  );
}

function StatusPill({
  status,
  batching,
}: {
  status: DesignAppPlanStatus;
  batching: boolean;
}) {
  const label = batching && status === 'approved' ? 'running' : status;
  const tone =
    status === 'completed'
      ? 'bg-semantic-success/15 text-semantic-success'
      : status === 'approved'
        ? batching
          ? 'bg-accent/15 text-accent'
          : 'bg-accent/10 text-accent'
        : status === 'cancelled'
          ? 'bg-text-dim/20 text-text-dim'
          : 'bg-surface-3 text-text-muted';
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide',
        tone,
      )}
      title={`Plan status: ${status}`}
    >
      {label}
    </span>
  );
}

interface MenuButtonProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

function MenuButton({ label, icon, onClick, disabled, danger }: MenuButtonProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-[5px] text-left text-[11.5px] transition',
        disabled
          ? 'cursor-not-allowed text-text-muted opacity-60'
          : danger
            ? 'text-[#fca5a5] hover:bg-[rgba(239,68,68,0.18)] hover:text-[#fee2e2]'
            : 'text-text-secondary hover:bg-[rgba(76,141,255,0.18)] hover:text-text',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
