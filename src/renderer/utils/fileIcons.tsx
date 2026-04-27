import {
  Binary,
  Book,
  Braces,
  Cog,
  FileCode,
  FileJson,
  FileLock,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Package,
  Palette,
  Scroll,
  Terminal,
  Type,
  type LucideIcon,
} from 'lucide-react';

export interface FileIconSpec {
  Icon: LucideIcon;
  /** Tailwind class or inline color for the icon stroke. */
  color: string;
  /** Short 2-3 char language label (optional) — rendered as a small badge. */
  label?: string;
}

const SPECIAL_NAMES: Record<string, FileIconSpec> = {
  'package.json': { Icon: Package, color: '#8bc34a', label: 'pkg' },
  'package-lock.json': { Icon: Package, color: '#84a88b' },
  'pnpm-lock.yaml': { Icon: Package, color: '#f69220' },
  'pnpm-workspace.yaml': { Icon: Package, color: '#f69220' },
  'yarn.lock': { Icon: Package, color: '#2c8ebb' },
  'bun.lockb': { Icon: Package, color: '#fbf0df' },
  'bun.lock': { Icon: Package, color: '#fbf0df' },
  'tsconfig.json': { Icon: Cog, color: '#3178c6', label: 'ts' },
  'tsconfig.node.json': { Icon: Cog, color: '#3178c6', label: 'ts' },
  'eslint.config.js': { Icon: Cog, color: '#4b32c3' },
  '.eslintrc': { Icon: Cog, color: '#4b32c3' },
  '.prettierrc': { Icon: Cog, color: '#c596c7' },
  'prettier.config.js': { Icon: Cog, color: '#c596c7' },
  'vite.config.ts': { Icon: Cog, color: '#646cff' },
  'vite.config.js': { Icon: Cog, color: '#646cff' },
  'electron.vite.config.ts': { Icon: Cog, color: '#47848f' },
  'webpack.config.js': { Icon: Cog, color: '#8dd6f9' },
  'rollup.config.js': { Icon: Cog, color: '#ef3335' },
  'tailwind.config.js': { Icon: Palette, color: '#38bdf8', label: 'tw' },
  'postcss.config.cjs': { Icon: Palette, color: '#dd3735' },
  'dockerfile': { Icon: Package, color: '#2496ed' },
  'makefile': { Icon: Terminal, color: '#6d8086' },
  'readme.md': { Icon: Book, color: '#f5f5f5' },
  'license': { Icon: Scroll, color: '#cccccc' },
  '.gitignore': { Icon: GitBranch, color: '#f05032' },
  '.gitattributes': { Icon: GitBranch, color: '#f05032' },
  '.env': { Icon: FileLock, color: '#ecd53f' },
  '.env.example': { Icon: FileLock, color: '#ecd53f' },
  '.env.local': { Icon: FileLock, color: '#ecd53f' },
};

const BY_EXTENSION: Record<string, FileIconSpec> = {
  // Scripts
  ts: { Icon: FileCode, color: '#3178c6', label: 'ts' },
  tsx: { Icon: FileCode, color: '#3178c6', label: 'tsx' },
  js: { Icon: FileCode, color: '#f7df1e', label: 'js' },
  jsx: { Icon: FileCode, color: '#f7df1e', label: 'jsx' },
  mjs: { Icon: FileCode, color: '#f7df1e' },
  cjs: { Icon: FileCode, color: '#f7df1e' },
  py: { Icon: FileCode, color: '#3776ab', label: 'py' },
  pyi: { Icon: FileCode, color: '#3776ab' },
  rs: { Icon: FileCode, color: '#ce422b', label: 'rs' },
  go: { Icon: FileCode, color: '#00add8', label: 'go' },
  java: { Icon: FileCode, color: '#f89820', label: 'java' },
  kt: { Icon: FileCode, color: '#7f52ff', label: 'kt' },
  swift: { Icon: FileCode, color: '#f05138', label: 'swift' },
  c: { Icon: FileCode, color: '#a8b9cc', label: 'c' },
  h: { Icon: FileCode, color: '#a8b9cc' },
  cpp: { Icon: FileCode, color: '#00599c', label: 'c++' },
  hpp: { Icon: FileCode, color: '#00599c' },
  cc: { Icon: FileCode, color: '#00599c' },
  cs: { Icon: FileCode, color: '#9b4f97', label: 'c#' },
  rb: { Icon: FileCode, color: '#cc342d', label: 'rb' },
  php: { Icon: FileCode, color: '#777bb4', label: 'php' },
  lua: { Icon: FileCode, color: '#000080', label: 'lua' },
  dart: { Icon: FileCode, color: '#0175c2', label: 'dart' },
  ex: { Icon: FileCode, color: '#6e4a7e' },
  exs: { Icon: FileCode, color: '#6e4a7e' },
  erl: { Icon: FileCode, color: '#a90533' },
  scala: { Icon: FileCode, color: '#dc322f' },
  zig: { Icon: FileCode, color: '#f7a41d' },
  nim: { Icon: FileCode, color: '#ffe953' },

  // Shell
  sh: { Icon: Terminal, color: '#89e051' },
  bash: { Icon: Terminal, color: '#89e051' },
  zsh: { Icon: Terminal, color: '#89e051' },
  fish: { Icon: Terminal, color: '#4aae47' },

  // Web
  html: { Icon: FileCode, color: '#e34c26', label: 'html' },
  htm: { Icon: FileCode, color: '#e34c26' },
  css: { Icon: Palette, color: '#1572b6', label: 'css' },
  scss: { Icon: Palette, color: '#cf649a', label: 'scss' },
  sass: { Icon: Palette, color: '#cf649a' },
  less: { Icon: Palette, color: '#1d365d' },
  vue: { Icon: FileCode, color: '#4fc08d' },
  svelte: { Icon: FileCode, color: '#ff3e00' },
  astro: { Icon: FileCode, color: '#ff5d01' },

  // Data
  json: { Icon: FileJson, color: '#f5c518' },
  jsonl: { Icon: FileJson, color: '#f5c518' },
  yaml: { Icon: Braces, color: '#cb171e' },
  yml: { Icon: Braces, color: '#cb171e' },
  toml: { Icon: Braces, color: '#9c4221' },
  xml: { Icon: Braces, color: '#0060ac' },
  csv: { Icon: FileText, color: '#66b241' },
  sql: { Icon: FileCode, color: '#e38c00' },

  // Text / docs
  md: { Icon: Book, color: '#f5f5f5', label: 'md' },
  mdx: { Icon: Book, color: '#1b1f23', label: 'mdx' },
  markdown: { Icon: Book, color: '#f5f5f5' },
  rst: { Icon: Book, color: '#8bcaf6' },
  txt: { Icon: FileText, color: '#bfbfbf' },
  log: { Icon: FileText, color: '#8b8b8b' },

  // Fonts / binaries
  woff: { Icon: Type, color: '#ec615f' },
  woff2: { Icon: Type, color: '#ec615f' },
  ttf: { Icon: Type, color: '#ec615f' },
  otf: { Icon: Type, color: '#ec615f' },

  // Images (preview path) — icon shown when listed
  png: { Icon: ImageIcon, color: '#8bc34a' },
  jpg: { Icon: ImageIcon, color: '#8bc34a' },
  jpeg: { Icon: ImageIcon, color: '#8bc34a' },
  gif: { Icon: ImageIcon, color: '#8bc34a' },
  webp: { Icon: ImageIcon, color: '#8bc34a' },
  svg: { Icon: ImageIcon, color: '#ffb13b' },
  bmp: { Icon: ImageIcon, color: '#8bc34a' },
  ico: { Icon: ImageIcon, color: '#8bc34a' },
  avif: { Icon: ImageIcon, color: '#8bc34a' },
  heic: { Icon: ImageIcon, color: '#8bc34a' },
  tif: { Icon: ImageIcon, color: '#8bc34a' },
  tiff: { Icon: ImageIcon, color: '#8bc34a' },

  // Documents
  pdf: { Icon: Book, color: '#ef4444', label: 'pdf' },

  // Archives / binary lockfiles
  zip: { Icon: Binary, color: '#b88d3f' },
  tar: { Icon: Binary, color: '#b88d3f' },
  gz: { Icon: Binary, color: '#b88d3f' },
  bz2: { Icon: Binary, color: '#b88d3f' },
  xz: { Icon: Binary, color: '#b88d3f' },
  exe: { Icon: Binary, color: '#7e7e7e' },
  dmg: { Icon: Binary, color: '#7e7e7e' },
};

const DEFAULT_SPEC: FileIconSpec = { Icon: FileText, color: '#9ca3af' };

export function getFileIcon(fileName: string): FileIconSpec {
  const lower = fileName.toLowerCase();
  const special = SPECIAL_NAMES[lower];
  if (special) return special;
  const ext = lower.split('.').pop() ?? '';
  return BY_EXTENSION[ext] ?? DEFAULT_SPEC;
}
