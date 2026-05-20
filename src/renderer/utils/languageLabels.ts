/**
 * Pure filename → human language label map. Deliberately kept free of any
 * `@codemirror/*` imports so the status bar (and anything else that just wants
 * a label) can use it without dragging the CodeMirror engine + 16 grammar
 * packs into the eager boot graph. The cm-heavy resolvers live in
 * `codemirrorLanguages.ts`, which is only imported by the (lazy) editor pane.
 */

export function getLanguageFromFileName(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript (JSX)',
    js: 'JavaScript',
    jsx: 'JavaScript (JSX)',
    mjs: 'JavaScript',
    cjs: 'JavaScript',
    py: 'Python',
    json: 'JSON',
    jsonl: 'JSON Lines',
    css: 'CSS',
    scss: 'SCSS',
    sass: 'Sass',
    less: 'Less',
    html: 'HTML',
    htm: 'HTML',
    xml: 'XML',
    svg: 'SVG',
    md: 'Markdown',
    mdx: 'MDX',
    markdown: 'Markdown',
    yaml: 'YAML',
    yml: 'YAML',
    rs: 'Rust',
    go: 'Go',
    java: 'Java',
    c: 'C',
    h: 'C/C++ Header',
    cpp: 'C++',
    cxx: 'C++',
    cc: 'C++',
    hpp: 'C++ Header',
    php: 'PHP',
    sql: 'SQL',
    sh: 'Shell',
    bash: 'Bash',
    zsh: 'Zsh',
    toml: 'TOML',
    ini: 'INI',
    conf: 'Config',
    txt: 'Plain Text',
  };
  return map[ext ?? ''] ?? 'Plain Text';
}
