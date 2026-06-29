import * as Dialog from '@radix-ui/react-dialog';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';
import type { ClaudeAuthProfile, CliId, CliProfile } from '@shared/types';

// Per-tab credential dialogs for the CLI dock's new-tab menu:
//   • ManageAuthDialog    — Claude auth profiles (subscription / API key)
//   • ManageOpenCodeDialog — OpenCode custom providers (baseURL / key / model)
// Extracted from CliTabBar to keep that file under the 500-line cap.

export function ManageAuthDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<ClaudeAuthProfile[]>([]);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void api.claudeAuth.list().then(setProfiles).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const add = async (): Promise<void> => {
    if (!name.trim() || !apiKey.trim() || busy) return;
    setBusy(true);
    try {
      await api.claudeAuth.save({
        name: name.trim(),
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
      });
      setName('');
      setApiKey('');
      setBaseUrl('');
      setModel('');
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-24 z-50 w-[min(520px,90vw)] overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl">
          <Dialog.Title className="border-b border-border-subtle bg-surface-sidebar px-4 py-2 text-[12px] font-medium text-text">
            Claude auth profiles
          </Dialog.Title>
          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="text-[11px] leading-relaxed text-text-muted">
              Each chat tab can launch on a different auth. Subscription uses your
              claude login; an API profile injects ANTHROPIC_API_KEY (+ optional
              base URL) for that tab only — so you can run both at once.
            </p>
            <div className="flex flex-col gap-1.5">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-[6px] border border-border bg-surface-2 px-2.5 py-1.5 text-[12px]"
                >
                  <span
                    className={cn(
                      'h-[6px] w-[6px] shrink-0 rounded-full',
                      p.kind === 'subscription'
                        ? 'bg-accent'
                        : 'bg-semantic-success',
                    )}
                  />
                  <span className="truncate text-text">{p.name}</span>
                  {p.baseUrl && (
                    <span className="truncate font-mono text-[9.5px] text-text-dim">
                      {p.baseUrl}
                    </span>
                  )}
                  {p.model && (
                    <span className="truncate font-mono text-[9.5px] text-text-dim">
                      {p.model}
                    </span>
                  )}
                  <span className="flex-1" />
                  {p.kind === 'api' ? (
                    <button
                      type="button"
                      onClick={() => void api.claudeAuth.delete(p.id).then(reload)}
                      title="Delete profile"
                      className="text-text-muted transition hover:text-semantic-error"
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : (
                    <span className="text-[9px] text-text-dim">built-in</span>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1 flex flex-col gap-2 rounded-[7px] border border-border-subtle bg-surface-2 p-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Add API profile
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (e.g. Work API)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
              />
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type="password"
                placeholder="ANTHROPIC_API_KEY (sk-ant-…)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[12px] text-text outline-none focus:border-accent"
              />
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="Base URL (optional — gateway/proxy)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text outline-none focus:border-accent"
              />
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model (optional — e.g. claude-opus-4-8, or gateway model id)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => void add()}
                disabled={busy || !name.trim() || !apiKey.trim()}
                className="self-end rounded-[6px] bg-accent px-3 py-1 text-[11px] font-medium text-white transition hover:opacity-90 disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Add profile'}
              </button>
            </div>
          </div>
          <div className="flex justify-end border-t border-border-subtle bg-surface-sidebar px-3 py-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1 text-[11px] text-text-secondary transition hover:bg-surface-overlay hover:text-text"
            >
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ManageCliProviderDialog({
  open,
  onClose,
  cliId,
  title,
}: {
  open: boolean;
  onClose: () => void;
  cliId: Exclude<CliId, 'claude'>;
  title: string;
}) {
  const [profiles, setProfiles] = useState<CliProfile[]>([]);
  const [name, setName] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [contextWindow, setContextWindow] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void api.cli
      .listProfiles(cliId)
      .then(setProfiles)
      .catch(() => undefined);
  }, [cliId]);
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const add = async (): Promise<void> => {
    if (
      !name.trim() ||
      !baseURL.trim() ||
      !apiKey.trim() ||
      !model.trim() ||
      busy
    )
      return;
    setBusy(true);
    try {
      await api.cli.saveProfile({
        name: name.trim(),
        cliId,
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        contextLimit: contextWindow.trim()
          ? Number(contextWindow.trim())
          : undefined,
      });
      setName('');
      setBaseURL('');
      setApiKey('');
      setModel('');
      setContextWindow('');
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-24 z-50 w-[min(520px,90vw)] overflow-hidden rounded-lg border border-border-emphasis bg-surface-raised shadow-2xl">
          <Dialog.Title className="border-b border-border-subtle bg-surface-sidebar px-4 py-2 text-[12px] font-medium text-text">
            {title}
          </Dialog.Title>
          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="text-[11px] leading-relaxed text-text-muted">
              A custom OpenAI-compatible provider (base URL + key + model) an
              OpenCode tab launches against — isolated per profile via
              OPENCODE_CONFIG_DIR. Pick &ldquo;Default&rdquo; in the + menu to use
              your own ~/.config/opencode instead.
            </p>
            <div className="flex flex-col gap-1.5">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-[6px] border border-border bg-surface-2 px-2.5 py-1.5 text-[12px]"
                >
                  <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-semantic-success" />
                  <span className="truncate text-text">{p.name}</span>
                  <span className="truncate font-mono text-[9.5px] text-text-dim">
                    {p.provider.model}
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => void api.cli.deleteProfile(p.id).then(reload)}
                    title="Delete provider"
                    className="text-text-muted transition hover:text-semantic-error"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-1 flex flex-col gap-2 rounded-[7px] border border-border-subtle bg-surface-2 p-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Add provider
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (e.g. AEON Qwen)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 text-[12px] text-text outline-none focus:border-accent"
              />
              <input
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder="Base URL (e.g. https://host:8000/v1)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text outline-none focus:border-accent"
              />
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type="password"
                placeholder="API key"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[12px] text-text outline-none focus:border-accent"
              />
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model id (e.g. Qwen3.6-27B)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text outline-none focus:border-accent"
              />
              <input
                value={contextWindow}
                onChange={(e) =>
                  setContextWindow(e.target.value.replace(/[^0-9]/g, ''))
                }
                inputMode="numeric"
                placeholder="Context window tokens (optional — Codex needs it for custom models, e.g. 8192)"
                className="rounded-[6px] border border-border bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => void add()}
                disabled={
                  busy ||
                  !name.trim() ||
                  !baseURL.trim() ||
                  !apiKey.trim() ||
                  !model.trim()
                }
                className="self-end rounded-[6px] bg-accent px-3 py-1 text-[11px] font-medium text-white transition hover:opacity-90 disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Add provider'}
              </button>
            </div>
          </div>
          <div className="flex justify-end border-t border-border-subtle bg-surface-sidebar px-3 py-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1 text-[11px] text-text-secondary transition hover:bg-surface-overlay hover:text-text"
            >
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
