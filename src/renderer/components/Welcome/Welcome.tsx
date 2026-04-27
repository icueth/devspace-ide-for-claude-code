import { ArrowRight, FolderPlus, Keyboard } from 'lucide-react';
import { useMemo } from 'react';

import { useWorkspaceStore } from '@renderer/state/workspace';
import type { Workspace } from '@shared/types';

const GRADIENTS = [
  'linear-gradient(135deg, #4c8dff, #2b5fc7)',
  'linear-gradient(135deg, #a855f7, #7c3aed)',
  'linear-gradient(135deg, #22c55e, #15803d)',
  'linear-gradient(135deg, #f59e0b, #b45309)',
  'linear-gradient(135deg, #ec4899, #be185d)',
  'linear-gradient(135deg, #14b8a6, #0f766e)',
  'linear-gradient(135deg, #06b6d4, #0369a1)',
  'linear-gradient(135deg, #ef4444, #b91c1c)',
];

function gradientForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

function initialsFor(name: string): string {
  const parts = name.split(/[\s/_\-.]+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function formatRelative(ts: number | undefined): string {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function shortenPath(full: string): string {
  return full.replace(/^\/Users\/[^/]+/, '~');
}

interface WelcomeProps {
  version: string;
}

export function Welcome({ version }: WelcomeProps) {
  const active = useWorkspaceStore((s) => s.active);
  const known = useWorkspaceStore((s) => s.known);
  const projects = useWorkspaceStore((s) => s.projects);
  const pickFolder = useWorkspaceStore((s) => s.pickFolder);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);

  const recent = useMemo(
    () => [...known].sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)).slice(0, 8),
    [known],
  );

  return (
    <div className="relative flex flex-1 overflow-y-auto bg-surface">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 18% 8%, rgba(76,141,255,0.08), transparent 55%), radial-gradient(circle at 82% 24%, rgba(168,85,247,0.06), transparent 50%)',
        }}
      />

      <div className="relative z-[1] mx-auto flex w-full max-w-[860px] flex-col gap-9 px-10 py-14">
        <header className="flex items-start gap-4">
          <div
            className="h-14 w-14 shrink-0 rounded-[16px]"
            style={{
              background:
                'linear-gradient(135deg, var(--color-accent) 0%, #a855f7 55%, #ec4899 100%)',
              boxShadow:
                '0 10px 30px rgba(76,141,255,0.28), inset 0 1px 0 rgba(255,255,255,0.2)',
            }}
            aria-hidden
          />
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-3">
              <h1 className="text-[26px] font-bold tracking-tight text-text">devspace</h1>
              <span className="text-[11px] text-text-dim">v{version}</span>
            </div>
            <p className="text-[13.5px] text-text-secondary">
              One-window Mac dev workspace · Claude Code CLI at the core
            </p>
          </div>
        </header>

        {!active ? (
          <NoWorkspaceState
            recent={recent}
            onOpenFolder={() => void pickFolder()}
            onPickWorkspace={(id) => void setActive(id)}
          />
        ) : (
          <NoProjectState
            workspaceName={active.name}
            projectCount={projects.length}
            projects={projects}
            onPickProject={(id) => setActiveProject(id)}
          />
        )}

        <Shortcuts />
      </div>
    </div>
  );
}

interface NoWorkspaceStateProps {
  recent: Workspace[];
  onOpenFolder: () => void;
  onPickWorkspace: (id: string) => void;
}

function NoWorkspaceState({ recent, onOpenFolder, onPickWorkspace }: NoWorkspaceStateProps) {
  return (
    <section className="flex flex-col gap-4">
      <button
        onClick={onOpenFolder}
        className="group relative flex items-center gap-3 rounded-[12px] border border-border-subtle px-5 py-4 text-left transition hover:border-accent hover:shadow-lg focus:border-accent focus:outline-none"
        style={{
          background:
            'linear-gradient(135deg, rgba(76,141,255,0.12), rgba(168,85,247,0.08))',
        }}
      >
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-white"
          style={{
            background: 'linear-gradient(135deg, var(--color-accent), #a855f7)',
            boxShadow: '0 4px 12px rgba(76,141,255,0.25)',
          }}
        >
          <FolderPlus size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-text">Open folder…</div>
          <div className="mt-0.5 text-[11.5px] text-text-muted">
            Pick a parent folder — we&rsquo;ll detect the projects inside
          </div>
        </div>
        <ArrowRight
          size={14}
          className="text-text-muted transition group-hover:translate-x-0.5 group-hover:text-text"
        />
      </button>

      {recent.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="px-1 text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
            Recent workspaces
          </h2>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {recent.map((w) => (
              <button
                key={w.id}
                onClick={() => onPickWorkspace(w.id)}
                className="group flex items-center gap-3 rounded-[10px] border border-border-subtle bg-surface-3 px-3 py-2.5 text-left transition hover:border-border-hi hover:bg-surface-4"
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-[11px] font-bold uppercase text-white"
                  style={{ background: gradientForName(w.name) }}
                >
                  {initialsFor(w.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-text">
                    {w.name}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-text-muted">
                    <span className="truncate">{shortenPath(w.path)}</span>
                    {w.lastOpened ? (
                      <>
                        <span className="shrink-0">·</span>
                        <span className="shrink-0">{formatRelative(w.lastOpened)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

interface NoProjectStateProps {
  workspaceName: string;
  projectCount: number;
  projects: import('@shared/types').Project[];
  onPickProject: (id: string) => void;
}

function NoProjectState({
  workspaceName,
  projectCount,
  projects,
  onPickProject,
}: NoProjectStateProps) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[14px] font-semibold text-text">
          Pick a project in <span className="text-accent-2">{workspaceName}</span>
        </h2>
        <span className="text-[11px] text-text-muted">
          {projectCount} project{projectCount === 1 ? '' : 's'}
        </span>
      </div>

      {projects.length === 0 ? (
        <div className="rounded-[10px] border border-border-subtle bg-surface-3 px-4 py-8 text-center">
          <div className="text-[13px] text-text-secondary">No projects detected.</div>
          <div className="mt-1 text-[11px] text-text-muted">
            A project needs <code className="rounded bg-surface-4 px-1">.git</code>,{' '}
            <code className="rounded bg-surface-4 px-1">package.json</code>,{' '}
            <code className="rounded bg-surface-4 px-1">go.mod</code>, etc.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => onPickProject(p.id)}
              className="group flex items-center gap-3 rounded-[10px] border border-border-subtle bg-surface-3 px-3 py-2.5 text-left transition hover:border-accent hover:bg-surface-4"
            >
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-[11px] font-bold uppercase text-white"
                style={{ background: gradientForName(p.name) }}
              >
                {initialsFor(p.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-text">
                    {p.name}
                  </span>
                  {p.isWorkspaceRoot && (
                    <span className="shrink-0 rounded-full border border-[rgba(168,85,247,0.3)] bg-[rgba(168,85,247,0.12)] px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-accent-2">
                      root
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[10.5px] text-text-muted">
                  {p.detectedRuntime.length > 0
                    ? p.detectedRuntime.join(' · ')
                    : p.vcs === 'git'
                      ? 'git'
                      : 'project'}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Shortcuts() {
  const items: Array<{ keys: string; desc: string }> = [
    { keys: '⌘P', desc: 'Quick open file' },
    { keys: '⌘⇧F', desc: 'Search in project' },
    { keys: '⌘⇧T', desc: 'Team mode cycle' },
    { keys: '⌘⇧L', desc: 'Send selection to Claude' },
    { keys: '⌘S', desc: 'Save file' },
    { keys: '⌘W', desc: 'Close tab' },
    { keys: '⌘G', desc: 'Go to line' },
    { keys: '⌘+ / ⌘−', desc: 'Editor zoom' },
  ];
  return (
    <section className="rounded-[10px] border border-border-subtle bg-surface-2/60 p-4 backdrop-blur">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
        <Keyboard size={10} /> Shortcuts
      </h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {items.map((it) => (
          <div key={it.keys} className="flex items-center gap-2.5">
            <kbd className="shrink-0 rounded-[5px] border border-border-subtle bg-surface-4 px-1.5 py-[2px] font-mono text-[10px] text-text-secondary">
              {it.keys}
            </kbd>
            <span className="text-[11.5px] text-text-secondary">{it.desc}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
