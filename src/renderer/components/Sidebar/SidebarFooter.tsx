import { FilePlus2, GitBranch } from 'lucide-react';

import { usePromptStore } from '@renderer/state/prompt';
import { useGitStore } from '@renderer/state/git';
import { useWorkspaceStore } from '@renderer/state/workspace';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';

interface Props {
  projectPath: string;
  onOpenGit: () => void;
}

/**
 * Sticky footer at the bottom of the sidebar. Exposes the two actions the
 * user reaches for constantly (new file + branch picker) plus a settings
 * pass-through — no more hunting through menus.
 */
export function SidebarFooter({ projectPath, onOpenGit }: Props) {
  const askPrompt = usePromptStore((s) => s.ask);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const gitSnapshot = useGitStore((s) =>
    activeProjectId ? s.byProject[activeProjectId] : undefined,
  );
  const refreshGit = useGitStore((s) => s.refresh);

  const branch = gitSnapshot?.branch ?? null;

  const createFile = () => {
    askPrompt({
      title: 'New file',
      placeholder: 'filename.ext',
      confirmLabel: 'Create',
      onConfirm: async (name) => {
        try {
          await api.fs.create(`${projectPath}/${name}`, 'file');
          if (activeProjectId) void refreshGit(activeProjectId, projectPath);
        } catch (err) {
          console.error('create file failed', err);
        }
      },
    });
  };

  return (
    <div
      className="relative z-[1] flex shrink-0 items-center gap-1.5 border-t border-border bg-surface-2 px-2.5 py-2"
    >
      <FooterBtn onClick={createFile} primary title="New file">
        <FilePlus2 size={11} strokeWidth={2.5} />
        <span>New</span>
      </FooterBtn>
      <FooterBtn
        title={branch ? `Branch · ${branch}` : 'No git'}
        className="min-w-0 flex-1"
        onClick={onOpenGit}
      >
        <GitBranch size={11} />
        <span className="truncate">{branch ?? '(no git)'}</span>
      </FooterBtn>
    </div>
  );
}

function FooterBtn({
  children,
  onClick,
  primary,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  primary?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex h-7 items-center justify-center gap-1.5 rounded-[6px] border px-2.5 text-[10.5px] font-medium transition',
        primary
          ? 'border-transparent text-white hover:brightness-110'
          : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
        className,
      )}
      style={
        primary
          ? {
              background: 'var(--color-accent-3)',
              boxShadow: '0 2px 8px var(--color-accent-glow)',
            }
          : undefined
      }
    >
      {children}
    </button>
  );
}
