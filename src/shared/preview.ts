// ─── HTML Preview types ──────────────────────────────────────────────────
//
// v0.31: After the Design Studio teardown, design generation is done by
// Claude itself using bundled design skills. Claude writes standalone HTML
// to `<project>/.devspace/preview/<name>.html`. The main process watches
// that directory and the renderer renders the file in a sandboxed iframe
// (Blob URL, `sandbox="allow-scripts"` — no same-origin/popups).

/** A single HTML file under a project's `.devspace/preview/` directory. */
export interface PreviewFileInfo {
  /** Absolute path to the .html file. */
  path: string;
  /** Basename (e.g. "landing.html"). */
  name: string;
  /** Last-modified epoch ms — used as a cache-buster / sort key. */
  mtime: number;
}

/** Main → renderer event when a preview file is added/changed/removed. */
export interface PreviewChangedEvent {
  projectPath: string;
  /** The affected file. */
  file: PreviewFileInfo;
  /** 'add' | 'change' | 'unlink' — drives auto-open vs refresh vs close. */
  kind: 'add' | 'change' | 'unlink';
}
