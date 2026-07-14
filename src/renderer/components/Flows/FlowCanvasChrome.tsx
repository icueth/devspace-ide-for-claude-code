import { createPortal } from 'react-dom';

import { cn } from '@renderer/lib/utils';
import type { FlowEdge, FlowNodeKind } from '@shared/flowTypes';

/** Canvas furniture: the zoom cluster and the right-click menu. */

export interface Menu {
  clientX: number;
  clientY: number;
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

export function ContextMenu({
  menu,
  edgeFromGate,
  onClose,
  onAddNode,
  onDeleteNode,
  onDeleteEdge,
  onSetEdgeBranch,
}: {
  menu: Menu;
  /** menu.edge leaves a gate — offer the pass/fail branch switch. */
  edgeFromGate: boolean;
  onClose: () => void;
  onAddNode: (x: number, y: number, kind: FlowNodeKind) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (edge: FlowEdge) => void;
  onSetEdgeBranch: (edge: FlowEdge, branch: FlowEdge['branch']) => void;
}) {
  const add = (kind: FlowNodeKind) => () => {
    // Drop the card centred on the cursor. Half of an agent card is close
    // enough for the smaller kinds — the user drags it anyway.
    onAddNode(menu.worldX - 104, menu.worldY - 39, kind);
    onClose();
  };
  const edge = menu.edge;

  // Portalled to <body>: the canvas viewport is overflow-hidden and sits below
  // transformed ancestors (the workbench zoom), which hijack position:fixed —
  // rendered in place the menu lands outside the clip box and never shows.
  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        style={{
          left: Math.min(menu.clientX, window.innerWidth - 216),
          top: Math.min(menu.clientY, window.innerHeight - 220),
        }}
        className="fixed z-50 min-w-[200px] rounded-lg border border-border-emphasis bg-surface-3 p-1 shadow-2xl shadow-black/60"
      >
        {edge ? (
          <>
            {edgeFromGate && (
              <>
                <MenuItem
                  glyph="✓"
                  disabled={edge.branch !== 'fail'}
                  onClick={() => {
                    onSetEdgeBranch(edge, 'pass');
                    onClose();
                  }}
                >
                  Make pass branch
                </MenuItem>
                <MenuItem
                  glyph="✗"
                  disabled={edge.branch === 'fail'}
                  onClick={() => {
                    onSetEdgeBranch(edge, 'fail');
                    onClose();
                  }}
                >
                  Make fail branch (retry)
                </MenuItem>
                <hr className="my-1 border-border" />
              </>
            )}
            <MenuItem
              danger
              glyph="✕"
              onClick={() => {
                onDeleteEdge(edge);
                onClose();
              }}
            >
              Delete edge
            </MenuItem>
          </>
        ) : (
          <>
            <MenuItem onClick={add('agent')} glyph="⬡">
              Add Agent
            </MenuItem>
            <MenuItem onClick={add('gate')} glyph="◇">
              Add Gate (condition)
            </MenuItem>
            <MenuItem onClick={add('note')} glyph="▤">
              Add Note
            </MenuItem>
            {menu.nodeId && (
              <>
                <hr className="my-1 border-border" />
                <MenuItem
                  danger
                  glyph="✕"
                  onClick={() => {
                    onDeleteNode(menu.nodeId!);
                    onClose();
                  }}
                >
                  Delete node
                </MenuItem>
              </>
            )}
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
  danger,
  glyph,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  glyph?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12.5px] transition',
        disabled
          ? 'cursor-default text-text-dim'
          : danger
            ? 'text-semantic-error hover:bg-semantic-error/10'
            : 'text-text hover:bg-accent/10',
      )}
    >
      {glyph && <span className="w-3 text-center text-[11px] opacity-70">{glyph}</span>}
      {children}
    </button>
  );
}
