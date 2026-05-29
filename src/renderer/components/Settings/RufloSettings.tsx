import {
  CheckCircle2,
  Circle,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Trash2,
  Waves,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { RufloProjectCard } from '@renderer/components/Settings/RufloProjectCard';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import {
  RUFLO_CATALOG,
  type RufloCatalogEntry,
  type RufloMarketplaceStatus,
  type RufloPlugin,
} from '@shared/ruflo';
import type { SetupCheck, SetupStatus } from '@shared/setup';

/**
 * Settings → Ruflo tab. Phase 2 surface for the ruvnet/ruflo plugin
 * ecosystem. The flow is layered:
 *   1. Global install row (read from setup status, link to Setup tab).
 *   2. Marketplace registration (add ruvnet/ruflo).
 *   3. Recommended plugins grid (core, swarm, rag-memory, goals).
 *   4. Full catalog list (collapsible).
 *   5. Per-project init card (the same one that used to live in Setup).
 *
 * All plugin commands shell out to `claude plugin ...` via RufloPluginsService;
 * per-row busy + error state lives here. After every install/uninstall/toggle
 * we refetch listPlugins() to keep the UI in sync with the CLI.
 */
export function RufloSettings() {
  const [plugins, setPlugins] = useState<RufloPlugin[]>([]);
  const [marketplace, setMarketplace] = useState<RufloMarketplaceStatus | null>(
    null,
  );
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  // Per-row busy state keyed by plugin name (catalog row) or full id (installed).
  // Single key at a time mirrors the server-side single-flight lock.
  const [busy, setBusy] = useState<string | null>(null);
  const [marketplaceBusy, setMarketplaceBusy] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const refreshPlugins = useCallback(async () => {
    try {
      const list = await api.ruflo.plugins.list();
      setPlugins(list);
    } catch (err) {
      // listPlugins is best-effort: if claude is missing we just render the
      // catalog with no installed indicators.
      console.warn('[ruflo] plugins.list failed:', err);
      setPlugins([]);
    }
  }, []);

  const refreshMarketplace = useCallback(async () => {
    try {
      const s = await api.ruflo.plugins.marketplaceStatus();
      setMarketplace(s);
    } catch (err) {
      console.warn('[ruflo] marketplaceStatus failed:', err);
      setMarketplace({ added: true });
    }
  }, []);

  const refreshSetup = useCallback(async () => {
    try {
      const s = await api.setup.getStatus();
      setSetupStatus(s);
    } catch (err) {
      console.warn('[ruflo] setup.getStatus failed:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([refreshPlugins(), refreshMarketplace(), refreshSetup()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshPlugins, refreshMarketplace, refreshSetup]);

  // ------------------------------------------------------------------
  // Per-row actions. All clear the row's previous error, set the row as
  // busy, run the action, and refetch the plugin list on success.
  // ------------------------------------------------------------------

  const runAction = useCallback(
    async (
      key: string,
      action: () => Promise<{ ok: boolean; error?: string }>,
    ): Promise<void> => {
      setBusy(key);
      setRowError((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      try {
        const result = await action();
        if (!result.ok && result.error) {
          setRowError((prev) => ({ ...prev, [key]: result.error! }));
        }
        await refreshPlugins();
      } catch (err) {
        setRowError((prev) => ({
          ...prev,
          [key]: (err as Error).message || 'Action failed',
        }));
      } finally {
        setBusy(null);
      }
    },
    [refreshPlugins],
  );

  const handleInstall = useCallback(
    (name: string) =>
      runAction(`install:${name}`, () => api.ruflo.plugins.install(name)),
    [runAction],
  );

  const handleUninstall = useCallback(
    (id: string) =>
      runAction(`uninstall:${id}`, () => api.ruflo.plugins.uninstall(id)),
    [runAction],
  );

  const handleToggle = useCallback(
    (id: string, enable: boolean) =>
      runAction(`toggle:${id}`, () =>
        api.ruflo.plugins.toggle(id, enable),
      ),
    [runAction],
  );

  const handleAddMarketplace = useCallback(async () => {
    setMarketplaceBusy(true);
    setRowError((prev) => {
      if (!('marketplace' in prev)) return prev;
      const next = { ...prev };
      delete next.marketplace;
      return next;
    });
    try {
      const result = await api.ruflo.plugins.marketplaceAdd();
      if (!result.ok && result.error) {
        setRowError((prev) => ({ ...prev, marketplace: result.error! }));
      }
      await refreshMarketplace();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        marketplace: (err as Error).message || 'Failed to add marketplace',
      }));
    } finally {
      setMarketplaceBusy(false);
    }
  }, [refreshMarketplace]);

  // ------------------------------------------------------------------
  // Derived state
  // ------------------------------------------------------------------

  const installedByName = useMemo(() => {
    const map = new Map<string, RufloPlugin>();
    for (const p of plugins) {
      if (p.isRuflo) map.set(p.name, p);
    }
    return map;
  }, [plugins]);

  const recommended = useMemo(
    () => RUFLO_CATALOG.filter((c) => c.recommended),
    [],
  );
  const fullCatalog = RUFLO_CATALOG;

  const rufloCheck = setupStatus?.checks.find((c) => c.id === 'ruflo') ?? null;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-text-muted">
        <Loader2 size={14} className="mr-2 animate-spin" />
        Loading Ruflo…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 py-6">
        <Header />

        <GlobalInstallCard
          check={rufloCheck}
          onRefresh={() => void refreshSetup()}
        />

        <MarketplaceCard
          status={marketplace}
          busy={marketplaceBusy}
          error={rowError.marketplace}
          onAdd={() => void handleAddMarketplace()}
        />

        <RecommendedGrid
          entries={recommended}
          installedByName={installedByName}
          busy={busy}
          rowError={rowError}
          onInstall={(name) => void handleInstall(name)}
          onUninstall={(id) => void handleUninstall(id)}
          onToggle={(id, enable) => void handleToggle(id, enable)}
        />

        <AllPluginsList
          entries={fullCatalog}
          installedByName={installedByName}
          busy={busy}
          rowError={rowError}
          onInstall={(name) => void handleInstall(name)}
          onUninstall={(id) => void handleUninstall(id)}
          onToggle={(id, enable) => void handleToggle(id, enable)}
        />

        <RufloProjectCard />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header() {
  return (
    <div className="flex items-start gap-3">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] text-white"
        style={{
          background: 'linear-gradient(135deg, var(--color-accent), #22d3ee)',
          boxShadow: '0 4px 16px rgba(34,211,238,0.25)',
        }}
      >
        <Waves size={16} strokeWidth={2.25} />
      </span>
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[15px] font-semibold text-text">
          Ruflo for Claude Code
        </h2>
        <p className="text-[11.5px] text-text-muted">
          Multi-agent orchestration, vector memory, and goal planning for
          Claude Code.{' '}
          <a
            href="#"
            className="text-accent hover:underline"
            onClick={(e) => {
              e.preventDefault();
              void api.app.openExternal('https://github.com/ruvnet/ruflo');
            }}
          >
            ruvnet/ruflo
            <ExternalLink size={9} className="ml-0.5 inline" />
          </a>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Global install row — read-only mirror of the Setup tab's ruflo check.
// ---------------------------------------------------------------------------

function GlobalInstallCard({
  check,
  onRefresh,
}: {
  check: SetupCheck | null;
  onRefresh: () => void;
}) {
  const installed = check?.state === 'ok';

  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface-2/60">
      <div className="border-b border-border-subtle px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
        Global install
      </div>
      <div className="flex items-center gap-3 px-3 py-3">
        {installed ? (
          <CheckCircle2 size={14} className="shrink-0 text-semantic-success" />
        ) : (
          <Circle size={14} className="shrink-0 text-text-muted" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-text">ruflo CLI</span>
            {check?.version && (
              <span className="rounded-full bg-surface-3 px-1.5 py-[1px] font-mono text-[9.5px] text-text-muted">
                {check.version}
              </span>
            )}
          </div>
          {installed && check?.path ? (
            <span className="truncate font-mono text-[10px] text-text-muted">
              {tilde(check.path)}
            </span>
          ) : (
            <span className="text-[11px] text-text-muted">
              Not installed — install from the Setup tab.
            </span>
          )}
        </div>
        {installed ? (
          <button
            type="button"
            onClick={onRefresh}
            title="Re-check install status"
            className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-surface-3 px-2 py-1 text-[10.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text"
          >
            <RefreshCw size={10} />
            Re-check
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent('devspace:switch-settings-tab', {
                  detail: { tab: 'setup' },
                }),
              );
            }}
            className="inline-flex items-center gap-1 rounded-[6px] border border-accent/40 bg-accent/10 px-2.5 py-1 text-[10.5px] text-accent transition hover:bg-accent/20"
          >
            Open Setup tab
            <ExternalLink size={9} />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

function MarketplaceCard({
  status,
  busy,
  error,
  onAdd,
}: {
  status: RufloMarketplaceStatus | null;
  busy: boolean;
  error?: string;
  onAdd: () => void;
}) {
  const added = status?.added ?? true;
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface-2/60">
      <div className="border-b border-border-subtle px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
        Marketplace
      </div>
      <div className="flex items-center gap-3 px-3 py-3">
        {added ? (
          <CheckCircle2 size={14} className="shrink-0 text-semantic-success" />
        ) : (
          <Circle size={14} className="shrink-0 text-text-muted" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[12px] font-medium text-text">ruvnet/ruflo</span>
          <span className="text-[11px] text-text-muted">
            {added
              ? 'Marketplace registered — plugins can be installed by name.'
              : 'Add this marketplace before installing any Ruflo plugin.'}
          </span>
          {error && (
            <span className="text-[10.5px] text-semantic-error">{error}</span>
          )}
        </div>
        {!added && (
          <button
            type="button"
            onClick={onAdd}
            disabled={busy}
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-accent/40 bg-accent/10 px-2.5 py-1 text-[10.5px] text-accent transition hover:bg-accent/20',
              busy && 'pointer-events-none opacity-60',
            )}
          >
            {busy ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
            {busy ? 'Adding…' : 'Add marketplace'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recommended grid
// ---------------------------------------------------------------------------

interface PluginRowHandlers {
  busy: string | null;
  rowError: Record<string, string>;
  onInstall: (name: string) => void;
  onUninstall: (id: string) => void;
  onToggle: (id: string, enable: boolean) => void;
}

function RecommendedGrid({
  entries,
  installedByName,
  ...handlers
}: {
  entries: readonly RufloCatalogEntry[];
  installedByName: Map<string, RufloPlugin>;
} & PluginRowHandlers) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface-2/60">
      <div className="border-b border-border-subtle px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted">
        Recommended
      </div>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        {entries.map((entry) => (
          <PluginCard
            key={entry.name}
            entry={entry}
            installed={installedByName.get(entry.name) ?? null}
            {...handlers}
          />
        ))}
      </div>
    </div>
  );
}

function PluginCard({
  entry,
  installed,
  busy,
  rowError,
  onInstall,
  onUninstall,
  onToggle,
}: {
  entry: RufloCatalogEntry;
  installed: RufloPlugin | null;
} & PluginRowHandlers) {
  const installKey = `install:${entry.name}`;
  const uninstallKey = installed ? `uninstall:${installed.id}` : '';
  const toggleKey = installed ? `toggle:${installed.id}` : '';

  const installing = busy === installKey;
  const uninstalling = busy === uninstallKey;
  const toggling = busy === toggleKey;

  const err =
    rowError[installKey] ?? rowError[uninstallKey] ?? rowError[toggleKey];

  return (
    <div className="flex flex-col gap-1.5 rounded-[8px] border border-border-subtle bg-surface-3/50 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-semibold text-text">
              {entry.label}
            </span>
            <CategoryChip category={entry.category} />
            {installed && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide',
                  installed.enabled
                    ? 'bg-[rgba(34,197,94,0.12)] text-semantic-success'
                    : 'bg-surface-3 text-text-muted',
                )}
              >
                {installed.enabled ? 'enabled' : 'disabled'}
              </span>
            )}
          </div>
          <span className="text-[11px] leading-snug text-text-muted">
            {entry.description}
          </span>
          {installed?.version && (
            <span className="font-mono text-[9.5px] text-text-muted">
              v{installed.version}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {installed ? (
          <>
            <button
              type="button"
              onClick={() => onToggle(installed.id, !installed.enabled)}
              disabled={busy !== null}
              className={cn(
                'inline-flex items-center gap-1 rounded-[6px] border border-border bg-surface-3 px-2 py-1 text-[10.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              {toggling ? (
                <Loader2 size={10} className="animate-spin" />
              ) : null}
              {installed.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              onClick={() => onUninstall(installed.id)}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded-[6px] border border-semantic-error/40 bg-semantic-error/10 px-2 py-1 text-[10.5px] text-semantic-error transition hover:bg-semantic-error/20 disabled:pointer-events-none disabled:opacity-50"
            >
              {uninstalling ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <Trash2 size={10} />
              )}
              Uninstall
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onInstall(entry.name)}
            disabled={busy !== null}
            className={cn(
              'inline-flex items-center gap-1 rounded-[6px] border border-accent/40 bg-accent/10 px-2.5 py-1 text-[10.5px] text-accent transition hover:bg-accent/20 disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            {installing ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Download size={10} />
            )}
            {installing ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>

      {err && (
        <span className="break-words text-[10.5px] text-semantic-error">
          {err}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// All plugins list (collapsible)
// ---------------------------------------------------------------------------

function AllPluginsList({
  entries,
  installedByName,
  ...handlers
}: {
  entries: readonly RufloCatalogEntry[];
  installedByName: Map<string, RufloPlugin>;
} & PluginRowHandlers) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface-2/60">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between border-b border-border-subtle px-3 py-1.5 text-left text-[10.5px] font-semibold uppercase tracking-wide text-text-muted transition hover:text-text"
      >
        <span>All plugins ({entries.length})</span>
        <span className="text-[10px] text-text-muted">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      {open && (
        <ul className="flex flex-col">
          {entries.map((entry, i) => (
            <li
              key={entry.name}
              className={cn(
                'px-3 py-2',
                i !== entries.length - 1 && 'border-b border-border-subtle',
              )}
            >
              <PluginRow
                entry={entry}
                installed={installedByName.get(entry.name) ?? null}
                {...handlers}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PluginRow({
  entry,
  installed,
  busy,
  rowError,
  onInstall,
  onUninstall,
  onToggle,
}: {
  entry: RufloCatalogEntry;
  installed: RufloPlugin | null;
} & PluginRowHandlers) {
  const installKey = `install:${entry.name}`;
  const uninstallKey = installed ? `uninstall:${installed.id}` : '';
  const toggleKey = installed ? `toggle:${installed.id}` : '';

  const installing = busy === installKey;
  const uninstalling = busy === uninstallKey;
  const toggling = busy === toggleKey;

  const err =
    rowError[installKey] ?? rowError[uninstallKey] ?? rowError[toggleKey];

  return (
    <div className="flex items-start gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-text">
            {entry.label}
          </span>
          <CategoryChip category={entry.category} />
          {entry.recommended && (
            <span className="rounded-full bg-[rgba(76,141,255,0.15)] px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-accent">
              recommended
            </span>
          )}
          {installed && (
            <span
              className={cn(
                'rounded-full px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide',
                installed.enabled
                  ? 'bg-[rgba(34,197,94,0.12)] text-semantic-success'
                  : 'bg-surface-3 text-text-muted',
              )}
            >
              {installed.enabled ? 'enabled' : 'disabled'}
            </span>
          )}
        </div>
        <span className="text-[11px] leading-snug text-text-muted">
          {entry.description}
        </span>
        {err && (
          <span className="break-words text-[10.5px] text-semantic-error">
            {err}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {installed ? (
          <>
            <button
              type="button"
              onClick={() => onToggle(installed.id, !installed.enabled)}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-surface-3 px-2 py-1 text-[10.5px] text-text-secondary transition hover:border-border-hi hover:bg-surface-4 hover:text-text disabled:pointer-events-none disabled:opacity-50"
            >
              {toggling ? <Loader2 size={10} className="animate-spin" /> : null}
              {installed.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              onClick={() => onUninstall(installed.id)}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded-[6px] border border-semantic-error/40 bg-semantic-error/10 px-2 py-1 text-[10.5px] text-semantic-error transition hover:bg-semantic-error/20 disabled:pointer-events-none disabled:opacity-50"
            >
              {uninstalling ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <Trash2 size={10} />
              )}
              Uninstall
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onInstall(entry.name)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded-[6px] border border-accent/40 bg-accent/10 px-2.5 py-1 text-[10.5px] text-accent transition hover:bg-accent/20 disabled:pointer-events-none disabled:opacity-50"
          >
            {installing ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Download size={10} />
            )}
            {installing ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
}

function CategoryChip({ category }: { category: RufloCatalogEntry['category'] }) {
  return (
    <span className="rounded-full bg-surface-3 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-text-muted">
      {category}
    </span>
  );
}

function tilde(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}
