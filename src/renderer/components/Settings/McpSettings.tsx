import {
  ChevronDown,
  ChevronRight,
  Folder,
  Globe,
  Plug,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import { useWorkspaceStore } from '@renderer/state/workspace';
import type {
  McpHttpServer,
  McpScope,
  McpServer,
  McpServerEntry,
  McpStdioServer,
  McpTransport,
} from '@shared/types';

/**
 * MCP server management. Lists servers from ~/.claude.json (global) and
 * <project>/.mcp.json (per-project), each editable inline. Critical:
 * the global file is shared with the rest of claude's settings — the
 * backend only touches the `mcpServers` key so we don't clobber the
 * 100KB of unrelated state living alongside.
 */
export function McpSettings() {
  const activeProject = useWorkspaceStore((s) => {
    const id = s.activeProjectId;
    return s.projects.find((p) => p.id === id) ?? null;
  });

  const [entries, setEntries] = useState<McpServerEntry[]>([]);
  const [collapsed, setCollapsed] = useState<Record<McpScope, boolean>>({
    global: false,
    project: false,
  });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpServerEntry | null>(null);
  const [draftName, setDraftName] = useState('');
  const [originalName, setOriginalName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [creatingScope, setCreatingScope] = useState<McpScope | null>(null);
  const [newName, setNewName] = useState('');
  const [newTransport, setNewTransport] = useState<McpTransport>('stdio');

  const reload = useCallback(async () => {
    try {
      const list = await api.mcp.list(activeProject?.path ?? null);
      setEntries(list);
      return list;
    } catch (err) {
      setError(`Failed to read MCP config: ${(err as Error).message}`);
      return [];
    }
  }, [activeProject?.path]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.path]);

  // Re-load the draft whenever the selection key changes. Key = scope+name
  // so renames flow naturally.
  useEffect(() => {
    if (!selectedKey) {
      setDraft(null);
      setOriginalName(null);
      return;
    }
    const [scope, ...rest] = selectedKey.split(':');
    const name = rest.join(':');
    const found = entries.find((e) => e.scope === scope && e.name === name);
    if (found) {
      setDraft(found);
      setDraftName(found.name);
      setOriginalName(found.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, entries.length]);

  const dirty = useMemo(() => {
    if (!draft || !originalName) return false;
    const found = entries.find(
      (e) => e.scope === draft.scope && e.name === originalName,
    );
    if (!found) return true;
    return (
      JSON.stringify(found.server) !== JSON.stringify(draft.server) ||
      found.name !== draftName
    );
  }, [draft, draftName, originalName, entries]);

  const grouped = useMemo(() => {
    const g: Record<McpScope, McpServerEntry[]> = { global: [], project: [] };
    for (const e of entries) g[e.scope].push(e);
    return g;
  }, [entries]);

  const onSave = useCallback(async () => {
    if (!draft || !originalName || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (draftName !== originalName) {
        await api.mcp.rename(draft.scope, draft.filePath, originalName, draftName);
      }
      const saved = await api.mcp.save({ ...draft, name: draftName });
      const list = await reload();
      setEntries(list);
      setSelectedKey(`${saved.scope}:${saved.name}`);
      setOriginalName(saved.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, draftName, originalName, saving, reload]);

  const onDelete = useCallback(async () => {
    if (!draft) return;
    const ok = window.confirm(
      `Delete MCP server "${draft.name}"?\n\nIt will be removed from ${draft.filePath}.`,
    );
    if (!ok) return;
    try {
      await api.mcp.delete(draft.scope, draft.filePath, draft.name);
      setSelectedKey(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [draft, reload]);

  const onCreate = useCallback(
    async (scope: McpScope) => {
      if (!newName.trim()) return;
      const initial: McpServer =
        newTransport === 'stdio'
          ? { transport: 'stdio', command: '' }
          : { transport: newTransport, url: '' };
      try {
        const created = await api.mcp.create(
          scope,
          scope === 'project' ? (activeProject?.path ?? null) : null,
          newName.trim(),
          initial,
        );
        await reload();
        setSelectedKey(`${created.scope}:${created.name}`);
        setCreatingScope(null);
        setNewName('');
        setNewTransport('stdio');
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [newName, newTransport, activeProject?.path, reload],
  );

  return (
    <div className="flex h-full">
      <aside
        className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-border"
        style={{ background: 'var(--color-surface-2)' }}
      >
        {(['global', 'project'] as McpScope[]).map((scope) => {
          const list = grouped[scope];
          const isCollapsed = collapsed[scope];
          const canCreate =
            scope === 'global' || (scope === 'project' && !!activeProject);
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
                  {scope === 'global' ? <Globe size={11} /> : <Folder size={11} />}
                  <span className="flex-1">
                    {scope === 'global' ? 'Global' : 'Project'}
                  </span>
                  <span className="text-text-dim">({list.length})</span>
                </button>
                {canCreate && (
                  <button
                    onClick={() => {
                      setCreatingScope(scope);
                      setNewName('');
                      setNewTransport('stdio');
                    }}
                    title={`New ${scope} server`}
                    className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-text"
                  >
                    <Plus size={11} />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="flex flex-col py-1">
                  {creatingScope === scope && (
                    <div className="flex flex-col gap-1 px-2 py-1.5">
                      <input
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void onCreate(scope);
                          if (e.key === 'Escape') setCreatingScope(null);
                        }}
                        autoFocus
                        placeholder="server-name"
                        className="rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
                      />
                      <div className="flex items-center gap-1">
                        <TransportPick
                          value={newTransport}
                          onChange={setNewTransport}
                        />
                        <button
                          onClick={() => void onCreate(scope)}
                          className="ml-auto rounded-[5px] bg-accent px-2 py-1 text-[10px] text-white hover:brightness-110"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  )}
                  {list.length === 0 && creatingScope !== scope && (
                    <div className="px-3 py-2 text-[10.5px] text-text-dim">
                      No MCP servers here.
                    </div>
                  )}
                  {list.map((e) => {
                    const key = `${e.scope}:${e.name}`;
                    const isActive = selectedKey === key;
                    return (
                      <button
                        key={key}
                        onClick={() => setSelectedKey(key)}
                        title={`${e.server.transport} · ${'command' in e.server ? e.server.command : e.server.url}`}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] transition',
                          isActive
                            ? 'bg-[rgba(76,141,255,0.18)] text-text'
                            : 'text-text-secondary hover:bg-surface-3 hover:text-text',
                        )}
                      >
                        <Plug size={11} className="shrink-0 text-accent" />
                        <span className="min-w-0 flex-1 truncate font-mono">
                          {e.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] uppercase text-text-muted">
                          {e.server.transport}
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
            Open a project to enable project-scoped MCP servers.
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {draft ? (
          <ServerEditor
            entry={draft}
            name={draftName}
            dirty={dirty}
            saving={saving}
            error={error}
            onChange={setDraft}
            onNameChange={setDraftName}
            onSave={onSave}
            onDelete={onDelete}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
            <div className="text-center">
              <Plug size={24} className="mx-auto mb-2 text-text-dim" />
              <div>Select an MCP server to edit it.</div>
              <div className="mt-1 text-[10.5px] text-text-dim">
                Click <Plus size={9} className="-mt-0.5 inline" /> to add a new
                stdio / http / sse server.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TransportPick({
  value,
  onChange,
}: {
  value: McpTransport;
  onChange: (t: McpTransport) => void;
}) {
  const items: McpTransport[] = ['stdio', 'http', 'sse'];
  return (
    <div className="inline-flex h-[22px] rounded-[5px] border border-border-subtle bg-surface-3">
      {items.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={cn(
            'px-1.5 text-[10px] transition first:rounded-l-[5px] last:rounded-r-[5px]',
            value === t
              ? 'bg-surface-4 text-text'
              : 'text-text-secondary hover:text-text',
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

interface ServerEditorProps {
  entry: McpServerEntry;
  name: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onChange: (next: McpServerEntry) => void;
  onNameChange: (name: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

function ServerEditor({
  entry,
  name,
  dirty,
  saving,
  error,
  onChange,
  onNameChange,
  onSave,
  onDelete,
}: ServerEditorProps) {
  const update = useCallback(
    (server: McpServer) => onChange({ ...entry, server }),
    [entry, onChange],
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

  const transport = entry.server.transport;

  const switchTransport = useCallback(
    (t: McpTransport) => {
      if (t === entry.server.transport) return;
      if (t === 'stdio') {
        update({ transport: 'stdio', command: '' });
      } else {
        update({ transport: t, url: '' });
      }
    },
    [entry.server.transport, update],
  );

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface-2/60 px-3">
        <span className="truncate font-mono text-[10.5px] text-text-muted">
          {entry.filePath.replace(/^\/Users\/[^/]+/, '~')}
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
          title="Delete this server"
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
        <div className="mx-auto max-w-[640px] space-y-4">
          <Field label="Name" hint="Server identifier shown in claude tool calls">
            <input
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              className="w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[11.5px] text-text focus:border-accent focus:outline-none"
            />
          </Field>

          <Field label="Transport">
            <TransportPick value={transport} onChange={switchTransport} />
          </Field>

          {entry.server.transport === 'stdio' ? (
            <StdioFields
              server={entry.server}
              onChange={(s) => update(s)}
            />
          ) : (
            <HttpFields server={entry.server} onChange={(s) => update(s)} />
          )}
        </div>
      </div>
    </>
  );
}

function StdioFields({
  server,
  onChange,
}: {
  server: McpStdioServer;
  onChange: (next: McpStdioServer) => void;
}) {
  return (
    <>
      <Field label="Command" hint="Executable path or PATH-resolved binary">
        <input
          type="text"
          value={server.command}
          onChange={(e) => onChange({ ...server, command: e.target.value })}
          placeholder="e.g. /usr/local/bin/my-mcp-server"
          className="w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[11.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
        />
      </Field>

      <Field
        label="Args"
        hint="One per line. Each line is one argv token (no shell parsing)"
      >
        <textarea
          value={(server.args ?? []).join('\n')}
          onChange={(e) =>
            onChange({
              ...server,
              args: e.target.value
                ? e.target.value.split('\n').filter((l) => l.length > 0)
                : undefined,
            })
          }
          rows={3}
          placeholder="mcp&#10;--verbose"
          className="w-full resize-none rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
        />
      </Field>

      <KvField
        label="Environment variables"
        hint="Passed to the child process"
        value={server.env}
        onChange={(env) => onChange({ ...server, env })}
        keyPlaceholder="VAR_NAME"
        valuePlaceholder="value"
      />
    </>
  );
}

function HttpFields({
  server,
  onChange,
}: {
  server: McpHttpServer;
  onChange: (next: McpHttpServer) => void;
}) {
  return (
    <>
      <Field label="URL">
        <input
          type="text"
          value={server.url}
          onChange={(e) => onChange({ ...server, url: e.target.value })}
          placeholder="https://example.com/mcp"
          className="w-full rounded-[6px] border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-[11.5px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
        />
      </Field>

      <KvField
        label="Headers"
        hint="`${ENV_VAR}` values are substituted by claude at request time"
        value={server.headers}
        onChange={(headers) => onChange({ ...server, headers })}
        keyPlaceholder="Authorization"
        valuePlaceholder="Bearer ${MY_TOKEN}"
      />
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
      <div className="mb-1 text-[11px] font-medium text-text">
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

interface KvFieldProps {
  label: string;
  hint?: string;
  value: Record<string, string> | undefined;
  onChange: (value: Record<string, string> | undefined) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}

function KvField({
  label,
  hint,
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: KvFieldProps) {
  const entries = Object.entries(value ?? {});
  const update = (next: Array<[string, string]>) => {
    const filtered = next.filter(([k]) => k.trim().length > 0);
    if (filtered.length === 0) {
      onChange(undefined);
    } else {
      onChange(Object.fromEntries(filtered));
    }
  };
  return (
    <Field label={label} hint={hint}>
      <div className="space-y-1">
        {entries.map(([k, v], idx) => (
          <div key={idx} className="flex items-center gap-1">
            <input
              type="text"
              value={k}
              onChange={(e) => {
                const next: Array<[string, string]> = [...entries];
                next[idx] = [e.target.value, v];
                update(next);
              }}
              placeholder={keyPlaceholder}
              className="w-[40%] rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
            />
            <input
              type="text"
              value={v}
              onChange={(e) => {
                const next: Array<[string, string]> = [...entries];
                next[idx] = [k, e.target.value];
                update(next);
              }}
              placeholder={valuePlaceholder}
              className="flex-1 rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
            />
            <button
              onClick={() => {
                const next = entries.filter((_, i) => i !== idx);
                update(next);
              }}
              className="rounded p-1 text-text-muted transition hover:bg-surface-3 hover:text-semantic-error"
              title="Remove this entry"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
        <button
          onClick={() => update([...entries, ['', '']])}
          className="inline-flex items-center gap-1 rounded-[5px] border border-border-subtle bg-surface-3 px-2 py-1 text-[10.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
        >
          <Plus size={10} />
          Add
        </button>
      </div>
    </Field>
  );
}
