import { FilePlus2, GitBranch, Settings } from 'lucide-react';

import { usePromptStore } from '@renderer/state/prompt';
import { useGitStore } from '@renderer/state/git';
import { useWorkspaceStore } from '@renderer/state/workspace';
import { api } from '@renderer/lib/api';
import { cn } from '@renderer/lib/utils';

interface Props {
  projectPath: string;
  onOpenSettings: () => void;
}

/**
 * Sticky footer at the bottom of the sidebar. Exposes the two actions the
 * user reaches for constantly (new file + branch picker) plus a settings
 * pass-through — no more hunting through menus.
 */
export function SidebarFooter({ projectPath, onOpenSettings }: Props) {
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
      className="relative z-[1] flex shrink-0 items-center gap-1.5 border-t border-border-subtle px-2.5 py-2"
      style={{
        background:
          'linear-gradient(180deg, var(--color-surface-2), var(--color-surface-3))',
      }}
    >
      <FooterBtn onClick={createFile} primary title="New file">
        <FilePlus2 size={11} strokeWidth={2.5} />
        <span>New</span>
      </FooterBtn>
      <FooterBtn
        title={branch ? `Branch · ${branch}` : 'No git'}
        className="flex-1 min-w-0"
      >
        <GitBranch size={11} />
        <span className="truncate">{branch ?? '(no git)'}</span>
      </FooterBtn>
      <FooterBtn
        title="Claude settings (~/.claude)"
        onClick={onOpenSettings}
      >
        <Settings size={11} />
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
        'inline-flex items-center justify-center gap-1.5 rounded-[7px] border px-2.5 py-[5px] text-[10.5px] font-medium transition',
        primary
          ? 'border-transparent text-white hover:brightness-110'
          : 'border-border-subtle bg-surface-3 text-text-secondary hover:border-border-hi hover:bg-surface-4 hover:text-text',
        className,
      )}
      style={
        primary
          ? {
              background:
                'linear-gradient(135deg, var(--color-accent), var(--color-accent-3))',
              boxShadow: '0 2px 8px rgba(76,141,255,0.2)',
            }
          : undefined
      }
    >
      {children}
    </button>
  );
}
