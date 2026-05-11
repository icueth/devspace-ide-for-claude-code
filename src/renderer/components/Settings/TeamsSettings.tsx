import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  Globe,
  Plus,
  Save,
  Trash2,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type {
  AgentDef,
  TeamDef,
  TeamMember,
  TeamMode,
  TeamScope,
} from '@shared/types';

const MODE_OPTIONS: Array<{ id: TeamMode; label: string; hint: string }> = [
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    hint: 'claude dispatches to agents via Task tool',
  },
  {
    id: 'sequential',
    label: 'Sequential',
    hint: 'each step pipes output to the next',
  },
  {
    id: 'parallel',
    label: 'Parallel',
    hint: 'fan out → aggregate (not yet implemented)',
  },
];

/**
 * Settings tab for managing team configs. Teams live at
 * <project>/.devspace/teams.json so the picker requires an active
 * project. Each team is a list of agent slugs + a mode. Members reference
 * the Agents tab — slugs are validated against the agents list.
 */
export function TeamsSettings() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });

  const [teams, setTeams] = useState<TeamDef[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [collapsed, setCollapsed] = useState<Record<TeamScope, boolean>>({
    global: false,
    project: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TeamDef | null>(null);
  const [original, setOriginal] = useState<TeamDef | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingScope, setCreatingScope] = useState<TeamScope | null>(null);
  const [newName, setNewName] = useState('');

  const reload = useCallback(async () => {
    const list = await api.teams.list(activeProject?.path ?? null);
    setTeams(list);
    return list;
  }, [activeProject]);

  useEffect(() => {
    void reload();
    void api.agents.list(activeProject?.path ?? null).then(setAgents);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.path]);

  // Hydrate draft whenever the selected team changes.
  useEffect(() => {
    if (!selectedId) {
      setDraft(null);
      setOriginal(null);
      return;
    }
    const t = teams.find((x) => x.id === selectedId);
    if (t) {
      setDraft(structuredClone(t));
      setOriginal(t);
    }
  }, [selectedId, teams]);

  const dirty = useMemo(() => {
    if (!draft || !original) return false;
    return JSON.stringify(draft) !== JSON.stringify(original);
  }, [draft, original]);

  // Notify the rest of the renderer (specifically open ChatPanels) that
  // teams for this project changed. Without this the chat picker would
  // only refresh on full window focus / reload, leading to "I made a
  // team and it doesn't show up" confusion. Global team changes are
  // broadcast without a projectPath so any open chat refreshes.
  const broadcastTeamsChanged = useCallback(
    (scope: TeamScope) => {
      window.dispatchEvent(
        new CustomEvent('devspace:teams-changed', {
          detail: {
            scope,
            projectPath: scope === 'global' ? null : activeProject?.path,
          },
        }),
      );
    },
    [activeProject],
  );

  const onCreate = useCallback(
    async (scope: TeamScope) => {
      if (scope === 'project' && !activeProject) return;
      if (!newName.trim()) return;
      try {
        const fresh: TeamDef = {
          id: crypto.randomUUID(),
          name: newName.trim(),
          mode: 'orchestrator',
          members: [],
        };
        const saved = await api.teams.save(
          scope,
          scope === 'project' ? (activeProject?.path ?? null) : null,
          fresh,
        );
        await reload();
        broadcastTeamsChanged(scope);
        setSelectedId(saved.id);
        setCreatingScope(null);
        setNewName('');
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [activeProject, newName, reload, broadcastTeamsChanged],
  );

  const onSave = useCallback(async () => {
    if (!draft || saving) return;
    const scope = draft.scope ?? 'project';
    if (scope === 'project' && !activeProject) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api.teams.save(
        scope,
        scope === 'project' ? (activeProject?.path ?? null) : null,
        draft,
      );
      await reload();
      broadcastTeamsChanged(scope);
      setOriginal(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [activeProject, draft, saving, reload, broadcastTeamsChanged]);

  const onDelete = useCallback(async () => {
    if (!draft) return;
    const scope = draft.scope ?? 'project';
    if (scope === 'project' && !activeProject) return;
    const ok = window.confirm(
      `Delete team "${draft.name}"? This will remove it from ${scope === 'global' ? '~/.devspace/teams.json' : 'this project'}.`,
    );
    if (!ok) return;
    try {
      await api.teams.delete(
        scope,
        scope === 'project' ? (activeProject?.path ?? null) : null,
        draft.id,
      );
      setSelectedId(null);
      await reload();
      broadcastTeamsChanged(scope);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeProject, draft, reload, broadcastTeamsChanged]);

  const grouped = useMemo(() => {
    const g: Record<TeamScope, TeamDef[]> = { global: [], project: [] };
    for (const t of teams) g[t.scope ?? 'project'].push(t);
    return g;
  }, [teams]);

  return (
    <div className="flex h-full">
      <aside
        className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-border"
        style={{ background: 'var(--color-surface-2)' }}
      >
        {(['global', 'project'] as TeamScope[]).map((scope) => {
          const list = grouped[scope];
          const isCollapsed = collapsed[scope];
          const canCreate = scope === 'global' || !!activeProject;
          return (
            <div key={scope} className="flex flex-col">
              <div className="flex items-center gap-1 border-b border-border-subtle bg-surface-3/40 px-2 py-2">
                <button
                  onClick={() =>
                    setCollapsed((p) => ({ ...p, [scope]: !isCollapsed }))
                  }
                  className="flex flex-1 items-center gap-1 text-left text-[10.5px] font-semibold uppercase tracking-wide text-text-muted transition hover:text-text"
                >
                  {isCollapsed ? (
                    <ChevronRight size={10} />
                  ) : (
                    <ChevronDown size={10} />
                  )}
                  {scope === 'global' ? (
                    <Globe size={11} />
                  ) : (
                    <Folder size={11} />
                  )}
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={
                      scope === 'project' && activeProject
                        ? activeProject.path
                        : scope === 'global'
                          ? '~/.devspace/teams.json'
                          : undefined
                    }
                  >
                    {scope === 'global' ? (
                      'Global'
                    ) : (
                      <>
                        Project
                        {activeProject && (
                          <span className="ml-1 text-text-dim normal-case tracking-normal">
                            · {activeProject.name}
                          </span>
                        )}
                      </>
                    )}
                  </span>
                  <span className="text-text-dim">({list.length})</span>
                </button>
                {canCreate && (
                  <button
                    onClick={() => {
                      setCreatingScope(scope);
                      setNewName('');
                    }}
                    title={`New ${scope} team`}
                    className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
                  >
                    <Plus size={11} />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="flex flex-col py-1">
                  {creatingScope === scope && (
                    <div className="flex items-center gap-1 px-2 py-1.5">
                      <input
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void onCreate(scope);
                          if (e.key === 'Escape') setCreatingScope(null);
                        }}
                        autoFocus
                        placeholder="Team name"
                        className="min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
                      />
                      <button
                        onClick={() => void onCreate(scope)}
                        className="rounded-[5px] bg-accent px-2 py-1 text-[10px] text-white hover:brightness-110"
                      >
                        Add
                      </button>
                    </div>
                  )}
                  {list.length === 0 && creatingScope !== scope && (
                    <div className="px-3 py-2 text-[10.5px] text-text-dim">
                      {scope === 'project' && !activeProject
                        ? 'Open a project first.'
                        : 'No teams here.'}
                    </div>
                  )}
                  {list.map((t) => {
                    const isActive = selectedId === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSelectedId(t.id)}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition',
                          isActive
                            ? 'bg-[rgba(76,141,255,0.18)] text-text'
                            : 'text-text-secondary hover:bg-surface-3 hover:text-text',
                        )}
                      >
                        <Users size={11} className="shrink-0 text-accent" />
                        <span className="min-w-0 flex-1 truncate font-mono">
                          {t.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] uppercase text-text-muted">
                          {t.mode}
                        </span>
                        <span className="shrink-0 text-[9.5px] text-text-dim">
                          {t.members.length}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!activeProject && (
          <div className="mt-auto px-3 py-3 text-[10px] text-text-dim">
            Open a project to manage project-scoped teams.
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {draft ? (
          <TeamEditor
            team={draft}
            agents={agents}
            dirty={dirty}
            saving={saving}
            error={error}
            projectName={activeProject?.name}
            projectPath={activeProject?.path}
            onChange={setDraft}
            onSave={onSave}
            onDelete={onDelete}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
            <div className="text-center">
              <Users size={24} className="mx-auto mb-2 text-text-dim" />
              <div>Select a team to edit it.</div>
              <div className="mt-1 text-[10.5px] text-text-dim">
                Teams persist at <span className="font-mono">.devspace/teams.json</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface TeamEditorProps {
  team: TeamDef;
  agents: AgentDef[];
  dirty: boolean;
  saving: boolean;
  error: string | null;
  // The project this team belongs to when scope === 'project'. Used to
  // surface the project name in the editor header so the user always
  // knows which project's teams.json they're writing to.
  projectName?: string;
  projectPath?: string;
  onChange: (next: TeamDef) => void;
  onSave: () => void;
  onDelete: () => void;
}

function TeamEditor({
  team,
  agents,
  dirty,
  saving,
  error,
  projectName,
  projectPath,
  onChange,
  onSave,
  onDelete,
}: TeamEditorProps) {
  const update = useCallback(
    (patch: Partial<TeamDef>) => onChange({ ...team, ...patch }),
    [team, onChange],
  );

  const addMember = useCallback(
    (slug: string) => {
      if (team.members.some((m) => m.agentSlug === slug)) return;
      update({ members: [...team.members, { agentSlug: slug }] });
    },
    [team.members, update],
  );

  const removeMember = useCallback(
    (idx: number) => {
      update({ members: team.members.filter((_, i) => i !== idx) });
    },
    [team.members, update],
  );

  const moveMember = useCallback(
    (idx: number, delta: number) => {
      const next = [...team.members];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return;
      [next[idx], next[target]] = [next[target]!, next[idx]!];
      update({ members: next });
    },
    [team.members, update],
  );

  const updateMember = useCallback(
    (idx: number, patch: Partial<TeamMember>) => {
      const next = [...team.members];
      next[idx] = { ...next[idx]!, ...patch };
      update({ members: next });
    },
    [team.members, update],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) onSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, onSave]);

  const availableAgents = agents.filter(
    (a) => !team.members.some((m) => m.agentSlug === a.slug),
  );

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface-2/60 px-3">
        <Users size={11} className="text-accent" />
        <span className="font-mono text-[11.5px] text-text">{team.name}</span>
        <span
          className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-[1px] text-[9.5px] uppercase text-text-muted"
          title={
            team.scope === 'global'
              ? '~/.devspace/teams.json'
              : projectPath
                ? `${projectPath}/.devspace/teams.json`
                : '<project>/.devspace/teams.json'
          }
        >
          {team.scope === 'global' ? <Globe size={9} /> : <Folder size={9} />}
          {team.scope ?? 'project'}
          {team.scope !== 'global' && projectName && (
            <span className="ml-1 normal-case tracking-normal text-text-secondary">
              · {projectName}
            </span>
          )}
        </span>
        {dirty && (
          <span className="rounded-full bg-[rgba(245,158,11,0.18)] px-2 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[#fcd34d]">
            modified
          </span>
        )}
        <div className="flex-1" />
        {error && (
          <span className="truncate text-[10.5px] text-semantic-error">{error}</span>
        )}
        <button
          onClick={onDelete}
          title="Delete this team"
          className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-semantic-error"
        >
          <Trash2 size={12} />
        </button>
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className={cn(
            'inline-flex items-center gap-1 rounded-[6px] px-3 py-[5px] text-[11px] font-medium transition',
            !dirty || saving
              ? 'pointer-events-none border border-border bg-surface-3 text-text-muted opacity-50'
              : 'text-white hover:brightness-110',
          )}
          style={
            !dirty || saving
              ? undefined
              : {
                  background:
                    'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
                  boxShadow: '0 2px 8px rgba(76,141,255,0.25)',
                }
          }
        >
          <Save size={11} />
          {saving ? 'Saving…' : 'Save (⌘S)'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-[680px] space-y-4">
          <Field label="Name">
            <input
              type="text"
              value={team.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] text-text focus:border-accent focus:outline-none"
            />
          </Field>

          <Field label="Mode" hint="How members coordinate">
            <div className="space-y-1.5">
              {MODE_OPTIONS.map((m) => (
                <label
                  key={m.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-[7px] border px-3 py-2 transition',
                    team.mode === m.id
                      ? 'border-accent bg-accent/10'
                      : 'border-border-subtle bg-surface-3 hover:border-border-hi',
                  )}
                >
                  <input
                    type="radio"
                    name="mode"
                    checked={team.mode === m.id}
                    onChange={() => update({ mode: m.id })}
                    className="mt-0.5 h-3 w-3 accent-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] font-medium text-text">
                      {m.label}
                      {m.id === 'parallel' && (
                        <span className="ml-2 text-[9.5px] uppercase text-text-dim">
                          beta · TBD
                        </span>
                      )}
                    </div>
                    <div className="text-[10.5px] text-text-muted">{m.hint}</div>
                  </div>
                </label>
              ))}
            </div>
          </Field>

          <Field
            label="Members"
            hint={
              team.mode === 'sequential'
                ? 'Run in this order; each step feeds the next'
                : team.mode === 'parallel'
                  ? 'All run in parallel; aggregator merges'
                  : 'Available to claude via the Task tool'
            }
          >
            {team.members.length === 0 ? (
              <div className="rounded-[6px] border border-dashed border-border bg-surface-3 px-3 py-3 text-center text-[11px] text-text-muted">
                No members yet. Add from the dropdown below.
              </div>
            ) : (
              <div className="space-y-1">
                {team.members.map((m, idx) => {
                  const agent = agents.find((a) => a.slug === m.agentSlug);
                  return (
                    <div
                      key={`${m.agentSlug}-${idx}`}
                      className="flex items-center gap-1.5 rounded-[7px] border border-border-subtle bg-surface-3 px-2 py-1.5"
                    >
                      <div className="flex flex-col">
                        <button
                          onClick={() => moveMember(idx, -1)}
                          disabled={idx === 0}
                          className="text-text-muted disabled:opacity-30"
                          title="Move up"
                        >
                          <ChevronUp size={10} />
                        </button>
                        <button
                          onClick={() => moveMember(idx, 1)}
                          disabled={idx === team.members.length - 1}
                          className="text-text-muted disabled:opacity-30"
                          title="Move down"
                        >
                          <ChevronDown size={10} />
                        </button>
                      </div>
                      <Bot
                        size={12}
                        className="text-accent"
                        style={agent?.color ? { color: agent.color } : undefined}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[11.5px] text-text">
                          {agent?.name ?? m.agentSlug}
                          {!agent && (
                            <span className="ml-1 text-[10px] text-semantic-error">
                              (missing)
                            </span>
                          )}
                        </div>
                        {agent && (
                          <div className="truncate text-[10px] text-text-muted">
                            {agent.description}
                          </div>
                        )}
                      </div>
                      <select
                        value={m.modelOverride ?? ''}
                        onChange={(e) =>
                          updateMember(idx, {
                            modelOverride: e.target.value || undefined,
                          })
                        }
                        title="Override model for this member"
                        className="rounded-[5px] border border-border-subtle bg-surface px-1.5 py-[2px] text-[10px] text-text focus:border-accent focus:outline-none"
                      >
                        <option value="">{agent?.model ?? 'default'}</option>
                        <option value="sonnet">sonnet</option>
                        <option value="opus">opus</option>
                        <option value="haiku">haiku</option>
                      </select>
                      <button
                        onClick={() => removeMember(idx)}
                        className="rounded p-1 text-text-muted hover:bg-surface hover:text-semantic-error"
                        title="Remove from team"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {availableAgents.length > 0 && (
              <div className="mt-2">
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) addMember(e.target.value);
                  }}
                  className="w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11px] text-text focus:border-accent focus:outline-none"
                >
                  <option value="">+ Add agent…</option>
                  {availableAgents.map((a) => (
                    <option key={a.slug} value={a.slug}>
                      {a.name} ({a.scope === 'global' ? '~' : 'project'}) — {a.description.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </Field>

          {team.mode === 'parallel' && (
            <Field
              label="Aggregator"
              hint="Which member produces the final merged summary"
            >
              <select
                value={team.aggregatorSlug ?? ''}
                onChange={(e) =>
                  update({ aggregatorSlug: e.target.value || undefined })
                }
                className="w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 text-[11.5px] text-text focus:border-accent focus:outline-none"
              >
                <option value="">(first member)</option>
                {team.members.map((m) => (
                  <option key={m.agentSlug} value={m.agentSlug}>
                    {agents.find((a) => a.slug === m.agentSlug)?.name ?? m.agentSlug}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {agents.length === 0 && (
            <div className="rounded-[8px] border border-border-subtle bg-surface-2 px-3 py-2.5 text-[11px] text-text-muted">
              No agents available. Create some in the <strong className="text-text">Agents</strong> tab first.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-text">
        {label}
        {hint && (
          <span className="ml-1.5 text-[10px] font-normal text-text-dim">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ChevronRight is imported for the sidebar collapse arrows in other tabs;
// keep an explicit re-export so the import doesn't accidentally tree-shake.
void ChevronRight;
