import { ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { useMemo } from 'react';

import { cn } from '@renderer/lib/utils';
import { useGitStore } from '@renderer/state/git';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type { Project } from '@shared/types';

const PROJECT_GRADIENTS = [
  'linear-gradient(135deg, #4c8dff, #2b5fc7)',      // blue
  'linear-gradient(135deg, #a855f7, #7c3aed)',      // purple
  'linear-gradient(135deg, #22c55e, #15803d)',      // green
  'linear-gradient(135deg, #f59e0b, #b45309)',      // orange
  'linear-gradient(135deg, #ec4899, #be185d)',      // pink
  'linear-gradient(135deg, #14b8a6, #0f766e)',      // teal
  'linear-gradient(135deg, #06b6d4, #0369a1)',      // cyan
  'linear-gradient(135deg, #ef4444, #b91c1c)',      // red
];

function gradientForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PROJECT_GRADIENTS[h % PROJECT_GRADIENTS.length];
}

function initialsFor(name: string): string {
  const parts = name.split(/[\s/_\-.]+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toLowerCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toLowerCase();
  return (parts[0][0] + parts[1][0]).toLowerCase();
}

export function ProjectList() {
  const projects = useWorkspaceStore((s) => s.projects);
  const active = useWorkspaceStore((s) => s.active);
  const scanning = useWorkspaceStore((s) => s.scanning);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const openedProjectIds = useWorkspaceStore((s) => s.openedProjectIds);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const closeProject = useWorkspaceStore((s) => s.closeProject);
  const allExpanded = useWorkspaceStore((s) => s.allExpanded);
  const setAllExpanded = useWorkspaceStore((s) => s.setAllExpanded);

  const rootProject = useMemo(
    () => projects.find((p) => p.isWorkspaceRoot) ?? null,
    [projects],
  );

  const opened = useMemo(
    () =>
      openedProjectIds
        .map((id) => projects.find((p) => p.id === id))
        .filter((p): p is Project => !!p)
        .filter((p) => !p.isWorkspaceRoot),
    [openedProjectIds, projects],
  );

  const rest = useMemo(() => {
    const openedSet = new Set(openedProjectIds);
    return projects.filter((p) => !openedSet.has(p.id) && !p.isWorkspaceRoot);
  }, [projects, openedProjectIds]);

  if (!active) {
    return (
      <div className="px-3 py-5 text-center text-[11px] text-text-muted">
        Pick a workspace to list projects.
      </div>
    );
  }

  if (scanning) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        Scanning {active.name}…
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="px-3 py-5 text-center text-[11px] text-text-muted">
        No projects found in {active.name}.
      </div>
    );
  }

  // When nothing is open yet, default to showing the full list — otherwise the
  // sidebar is empty. Once the user opens something, "All" collapses so the
  // file tree below has room; they can click to expand again any time.
  const showAll = opened.length === 0 ? true : allExpanded;

  return (
    <div className="flex flex-col gap-[2px]">
      {rootProject && (
        <div className="flex flex-col gap-[2px]">
          <SectionLabel label="Root" count={1} />
          <ProjectRow
            project={rootProject}
            isActive={rootProject.id === activeProjectId}
            isOpen={openedProjectIds.includes(rootProject.id)}
            onClick={() => setActiveProject(rootProject.id)}
            onClose={
              openedProjectIds.includes(rootProject.id)
                ? () => closeProject(rootProject.id)
                : undefined
            }
          />
          {(opened.length > 0 || rest.length > 0) && (
            <div className="mx-2 my-1.5 border-t border-border-subtle" />
          )}
        </div>
      )}

      {opened.length > 0 && (
        <div className="flex flex-col gap-[2px]">
          <SectionLabel label="Open" count={opened.length} />
          {opened.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              isActive={p.id === activeProjectId}
              isOpen
              onClick={() => setActiveProject(p.id)}
              onClose={() => closeProject(p.id)}
            />
          ))}
        </div>
      )}

      {rest.length > 0 && (
        <>
          {opened.length > 0 && (
            <div className="mx-2 my-1.5 border-t border-border-subtle" />
          )}
          <button
            onClick={() => setAllExpanded(!showAll)}
            className={cn(
              'mx-1 mb-1 flex items-center justify-between rounded-[6px] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted transition',
              'hover:bg-surface-3 hover:text-text-secondary',
            )}
            title={showAll ? 'Collapse list' : 'Expand list'}
          >
            <span className="flex items-center gap-1.5">
              {showAll ? (
                <ChevronDown size={10} className="text-text-muted" strokeWidth={2.5} />
              ) : (
                <ChevronRight size={10} className="text-text-muted" strokeWidth={2.5} />
              )}
              All
            </span>
            <span className="font-mono text-[9.5px] text-text-dim">{rest.length}</span>
          </button>
          {showAll && (
            <div className="flex flex-col gap-[2px]">
              {rest.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  isActive={false}
                  isOpen={false}
                  onClick={() => setActiveProject(p.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-1 flex items-center justify-between px-3 pt-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
      <span className="flex items-center gap-1.5">
        <span className="h-[3px] w-[3px] rounded-full bg-accent-2" />
        {label}
      </span>
      <span className="font-mono text-[9.5px] text-text-dim">{count}</span>
    </div>
  );
}

interface ProjectRowProps {
  project: Project;
  isActive: boolean;
  isOpen: boolean;
  onClick: () => void;
  onClose?: () => void;
}

function ProjectRow({ project, isActive, isOpen, onClick, onClose }: ProjectRowProps) {
  const gitSnapshot = useGitStore((s) => s.byProject[project.id]);
  const dirtyCount = gitSnapshot?.files.length ?? 0;
  const ahead = gitSnapshot?.ahead ?? 0;

  return (
    <div
      className={cn(
        'group relative mx-1 flex items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 transition-all duration-150',
        isActive
          ? 'text-text'
          : 'text-text-secondary hover:bg-surface-3 hover:text-text',
      )}
      style={
        isActive
          ? {
              background:
                'linear-gradient(135deg, rgba(76,141,255,0.18), rgba(168,85,247,0.1) 60%, transparent)',
              boxShadow:
                'inset 0 0 0 1px rgba(76,141,255,0.25), 0 2px 8px rgba(76,141,255,0.12)',
            }
          : undefined
      }
    >
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <div
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-[10.5px] font-bold uppercase text-white"
          style={{
            background: gradientForName(project.name),
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.15), 0 2px 4px rgba(0,0,0,0.25)',
          }}
        >
          {initialsFor(project.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate text-[12.5px]',
              isActive ? 'font-medium text-text' : 'font-normal',
            )}
          >
            {project.name}
          </div>
          <div className="mt-[1px] flex items-center gap-2 font-mono text-[9.5px] text-text-muted">
            {dirtyCount > 0 ? (
              <span className="text-semantic-warning">●{dirtyCount}M</span>
            ) : project.vcs === 'git' ? (
              <span className="text-semantic-success">✓ clean</span>
            ) : (
              <span className="text-text-dim">{project.detectedRuntime[0] ?? 'project'}</span>
            )}
            {ahead > 0 && <span className="text-accent-2">↑{ahead}</span>}
          </div>
        </div>
      </button>

      {isOpen ? (
        <span
          className={cn(
            'h-[7px] w-[7px] shrink-0 rounded-full',
            isActive ? 'bg-semantic-success live-pulse' : 'bg-text-dim opacity-50',
          )}
          style={
            isActive
              ? { boxShadow: '0 0 8px #22c55e, 0 0 0 3px rgba(34,197,94,0.18)' }
              : undefined
          }
          aria-hidden
        />
      ) : (
        <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-text-dim opacity-30" aria-hidden />
      )}

      {onClose && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 transition',
            'group-hover:opacity-70 hover:bg-surface-4 hover:opacity-100 hover:text-text',
          )}
          title="Close project"
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}
