import * as ContextMenu from '@radix-ui/react-context-menu';

import { cn } from '@renderer/lib/utils';
import type { FlowEdge, FlowNodeKind } from '@shared/flowTypes';

/** Canvas furniture: the zoom cluster and the right-click menu. */

// What the cursor was over when the menu opened — recorded by the canvas in
// its onContextMenu, read by the menu content at render time.
export interface MenuCtx {
  worldX: number;
  worldY: number;
  nodeId: string | null;
  edge: FlowEdge | null;
}

export function ZoomBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-7 items-center justify-center text-text-muted transition hover:bg-accent/10 hover:text-accent"
    >
      {children}
    </button>
  );
}

/**
 * The right-click menu content. Built on @radix-ui/react-context-menu — the
 * SAME primitive every other menu in this app uses (FileTree, EditorTabs,
 * CodeMirror) — because it is the one context-menu implementation proven to
 * open correctly inside this Electron shell; two hand-rolled fixed-position
 * attempts never showed at all.
 *
 * Must be rendered inside the <ContextMenu.Root> whose Trigger wraps the
 * canvas viewport; `ctx` is what the cursor was over when the menu opened.
 */
export function CanvasMenuContent({
  ctx,
  edgeFromGate,
  onAddNode,
  onDeleteNode,
  onDeleteEdge,
  onSetEdgeBranch,
}: {
  ctx: MenuCtx;
  /** ctx.edge leaves a gate — offer the pass/fail branch switch. */
  edgeFromGate: boolean;
  onAddNode: (x: number, y: number, kind: FlowNodeKind) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (edge: FlowEdge) => void;
  onSetEdgeBranch: (edge: FlowEdge, branch: FlowEdge['branch']) => void;
}) {
  // Drop the card centred on the cursor. Half of an agent card is close
  // enough for the smaller kinds — the user drags it anyway.
  const add = (kind: FlowNodeKind) => () =>
    onAddNode(ctx.worldX - 104, ctx.worldY - 39, kind);
  const edge = ctx.edge;

  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        className="z-50 min-w-[200px] rounded-md border border-border-emphasis p-1 text-[12.5px] shadow-lg animate-in fade-in-0 zoom-in-95"
        style={{ backgroundColor: 'var(--color-surface-raised)' }}
      >
        {edge ? (
          <>
            {edgeFromGate && (
              <>
                <Item
                  glyph="✓"
                  disabled={edge.branch !== 'fail'}
                  onSelect={() => onSetEdgeBranch(edge, 'pass')}
                >
                  Make pass branch
                </Item>
                <Item
                  glyph="✗"
                  disabled={edge.branch === 'fail'}
                  onSelect={() => onSetEdgeBranch(edge, 'fail')}
                >
                  Make fail branch (retry)
                </Item>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
              </>
            )}
            <Item danger glyph="✕" onSelect={() => onDeleteEdge(edge)}>
              Delete edge
            </Item>
          </>
        ) : (
          <>
            <Item glyph="⬡" onSelect={add('agent')}>
              Add Agent
            </Item>
            <Item glyph="◇" onSelect={add('gate')}>
              Add Gate (condition)
            </Item>
            <Item glyph="▤" onSelect={add('note')}>
              Add Note
            </Item>
            {ctx.nodeId && (
              <>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
                <Item danger glyph="✕" onSelect={() => onDeleteNode(ctx.nodeId!)}>
                  Delete node
                </Item>
              </>
            )}
          </>
        )}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

function Item({
  children,
  onSelect,
  disabled,
  danger,
  glyph,
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  glyph?: string;
}) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded px-2.5 py-1.5 outline-none',
        disabled
          ? 'text-text-dim'
          : danger
            ? 'text-semantic-error data-[highlighted]:bg-semantic-error/10'
            : 'text-text data-[highlighted]:bg-accent/10',
      )}
    >
      {glyph && <span className="w-3 text-center text-[11px] opacity-70">{glyph}</span>}
      {children}
    </ContextMenu.Item>
  );
}
