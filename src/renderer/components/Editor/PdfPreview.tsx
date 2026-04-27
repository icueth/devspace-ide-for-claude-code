import type { EditorTab } from '@renderer/state/editor';

function formatBytes(n?: number): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface PdfPreviewProps {
  tab: EditorTab;
}

/**
 * Render PDFs through Chromium's built-in viewer — gives zoom, text selection,
 * page navigation, and search "for free" without bundling pdf.js.
 */
export function PdfPreview({ tab }: PdfPreviewProps) {
  if (!tab.dataUrl) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-text-muted">
        Loading PDF…
      </div>
    );
  }
  return (
    <div className="relative h-full w-full bg-surface">
      <iframe
        key={tab.path}
        src={tab.dataUrl}
        title={tab.name}
        className="absolute inset-0 h-full w-full border-0"
      />
      <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/50 px-2 py-0.5 text-[10px] text-white/80">
        {formatBytes(tab.size)}
      </div>
    </div>
  );
}
