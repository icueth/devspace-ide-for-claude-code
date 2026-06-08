#!/usr/bin/env node
/*
 * Freezes `graphifyy` (PyPI) into a per-OS standalone binary with PyInstaller
 * --onedir and unpacks it into resources/graphify/<platform>/. Native C
 * extensions (CPython, tree-sitter grammar .so/.pyd) CANNOT cross-compile, so
 * this runs ONCE PER OS/ARCH on its own runner (current platform only).
 *
 * Python is pinned to 3.12 and provisioned via `uv` (DevSpace already
 * standardizes on uv for its Python story) so the freeze is reproducible
 * regardless of the host's default python3, and so we dodge bleeding-edge
 * wheel / PyInstaller gaps on newer interpreters. graspologic (Leiden) is
 * gated to python<3.13 and is intentionally NOT installed; graphify falls
 * back to networkx-Louvain.
 *
 * The result is bundled via electron-builder `extraResources`, resolved at
 * runtime by src/main/utils/graphifyPaths.ts — no Python on user machines.
 *
 * Requires: uv on PATH (https://docs.astral.sh/uv/).
 *
 * Usage:
 *   node scripts/freeze-graphify.mjs            # freeze for the current host
 *   GRAPHIFY_VERSION=0.8.35 node scripts/freeze-graphify.mjs
 *   GRAPHIFY_PYTHON=3.12 node scripts/freeze-graphify.mjs
 *   node scripts/freeze-graphify.mjs --force    # rebuild even if present
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, readdir, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir, arch as osArch, platform as osPlatform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'resources', 'graphify');
const ENTRY = join(__dirname, 'graphify', 'entry.py');
const GEN_IMPORTS = join(__dirname, 'graphify', 'gen_grammar_imports.py');

const GRAPHIFY_VERSION = process.env.GRAPHIFY_VERSION ?? '0.8.35';
const GRAPHIFY_PYTHON = process.env.GRAPHIFY_PYTHON ?? '3.12';
const IS_WIN = osPlatform() === 'win32';

// Heavy / unused-offline modules excluded to keep the freeze minimal + green.
// (Optional extras we don't install; excluding stops PyInstaller from
//  following any stray lazy import in graphify source.)
const EXCLUDES = [
  'graspologic', 'numba', 'llvmlite', 'scipy', 'sklearn',
  'matplotlib', 'pandas', 'faster_whisper', 'ctranslate2', 'boto3', 'botocore',
  'tiktoken', 'openai', 'anthropic', 'gensim', 'umap', 'hyppo', 'pot',
  'starlette', 'uvicorn',
];

function platformKey() {
  const p = osPlatform();
  const a = osArch();
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'win32' && a === 'x64') return 'win32-x64';
  throw new Error(`Unsupported host: ${p}-${a}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'inherit'], ...opts });
    let out = '';
    child.stdout?.on('data', (d) => { out += d; process.stdout.write(d); });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`)));
  });
}

async function main() {
  const force = process.argv.includes('--force');
  const key = platformKey();
  const exeName = IS_WIN ? 'graphify.exe' : 'graphify';
  const finalDir = join(OUT_DIR, key);

  if (!force && existsSync(join(finalDir, exeName))) {
    process.stdout.write(`  • ${key}: already frozen, skipping (use --force to rebuild)\n`);
    return;
  }

  const work = join(tmpdir(), `devspace-graphify-${key}-freeze`);
  const venvPy = join(work, 'venv', IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python');
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  process.stdout.write(`→ ${key}: uv venv (Python ${GRAPHIFY_PYTHON}) + graphifyy[mcp]==${GRAPHIFY_VERSION}\n`);
  await run('uv', ['venv', '--python', GRAPHIFY_PYTHON, join(work, 'venv')]);
  await run('uv', ['pip', 'install', '--python', venvPy,
    'pyinstaller>=6.0', `graphifyy[mcp]==${GRAPHIFY_VERSION}`]);

  process.stdout.write(`→ ${key}: enumerating tree-sitter grammars\n`);
  const grammarsOut = await run(venvPy, [GEN_IMPORTS]);
  const grammars = JSON.parse(grammarsOut.trim().split('\n').pop());
  process.stdout.write(`  • ${grammars.length} grammars: ${grammars.join(', ')}\n`);

  const piArgs = [
    '-m', 'PyInstaller', '--noconfirm', '--onedir', '--name', 'graphify',
    '--distpath', join(work, 'dist'),
    '--workpath', join(work, 'build'),
    '--specpath', work,
    '--collect-binaries', 'tree_sitter',
  ];
  for (const g of grammars) piArgs.push('--hidden-import', g, '--collect-binaries', g);
  for (const e of EXCLUDES) piArgs.push('--exclude-module', e);
  piArgs.push(ENTRY);

  process.stdout.write(`→ ${key}: running PyInstaller\n`);
  await run(venvPy, piArgs);

  // PyInstaller --onedir emits <dist>/graphify/{graphify[.exe], _internal/}.
  // Move that tree into resources/graphify/<key>/ so the resolver finds
  // <key>/graphify[.exe] directly (mirrors mempalace-uv/<key>/uv).
  await rm(finalDir, { recursive: true, force: true });
  await mkdir(finalDir, { recursive: true });
  const built = join(work, 'dist', 'graphify');
  for (const entry of await readdir(built)) {
    await rename(join(built, entry), join(finalDir, entry));
  }

  await rm(work, { recursive: true, force: true });
  process.stdout.write(`  ✓ ${join(finalDir, exeName)}\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n`);
  process.exit(1);
});
