#!/usr/bin/env node
/*
 * Downloads `uv` (Astral's Python package manager) for every platform we
 * ship and unpacks the binary into resources/mempalace-uv/<platform>/.
 * Runs at build time; the result is bundled via electron-builder
 * `extraResources` so MemPalaceService can spawn uv on a clean install
 * without depending on the user having Python.
 *
 * Usage:
 *   node scripts/fetch-uv.mjs                # current platform only
 *   node scripts/fetch-uv.mjs --all          # every platform we support
 *   UV_VERSION=0.5.20 node scripts/fetch-uv.mjs --all
 */
import { createWriteStream, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { mkdir, rm, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir, arch as osArch, platform as osPlatform } from 'node:os';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'resources', 'mempalace-uv');

const UV_VERSION = process.env.UV_VERSION ?? '0.5.20';

// Astral publishes static binaries as <triple>.tar.gz (Unix) or .zip (Windows).
const TARGETS = {
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    ext: 'tar.gz',
    binary: 'uv',
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    ext: 'tar.gz',
    binary: 'uv',
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-gnu',
    ext: 'tar.gz',
    binary: 'uv',
  },
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc',
    ext: 'zip',
    binary: 'uv.exe',
  },
};

function currentPlatformKey() {
  const p = osPlatform();
  const a = osArch();
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'win32' && a === 'x64') return 'win32-x64';
  throw new Error(`Unsupported host: ${p}-${a}`);
}

async function download(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} → ${res.status}`);
  }
  await mkdir(dirname(destPath), { recursive: true });
  await pipeline(res.body, createWriteStream(destPath));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

async function extractTarball(archive, destDir) {
  await mkdir(destDir, { recursive: true });
  await run('tar', ['-xzf', archive, '-C', destDir, '--strip-components=1']);
}

async function extractZip(archive, destDir) {
  await mkdir(destDir, { recursive: true });
  // Use bsdtar (default on macOS/Linux) or PowerShell on Windows.
  if (osPlatform() === 'win32') {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${archive}" -DestinationPath "${destDir}" -Force`,
    ]);
  } else {
    await run('unzip', ['-q', '-o', archive, '-d', destDir]);
  }
}

async function fetchTarget(key, { force = false } = {}) {
  const cfg = TARGETS[key];
  if (!cfg) throw new Error(`Unknown target ${key}`);

  const targetDir = join(OUT_DIR, key);
  const finalPath = join(targetDir, cfg.binary);
  if (!force && existsSync(finalPath)) {
    process.stdout.write(`  • ${key}: already present, skipping\n`);
    return;
  }

  const archiveName = `uv-${cfg.triple}.${cfg.ext}`;
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archiveName}`;

  const work = join(tmpdir(), `devspace-uv-${key}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const archivePath = join(work, archiveName);

  process.stdout.write(`→ ${key}: downloading ${UV_VERSION}…\n`);
  await download(url, archivePath);

  const extractDir = join(work, 'extract');
  if (cfg.ext === 'tar.gz') {
    await extractTarball(archivePath, extractDir);
  } else {
    await extractZip(archivePath, extractDir);
    // Windows zip nests under uv-<triple>/uv.exe — flatten so binary lives
    // directly inside extractDir for the same lookup below.
    const nested = join(extractDir, `uv-${cfg.triple}`);
    if (existsSync(join(nested, cfg.binary))) {
      await rename(join(nested, cfg.binary), join(extractDir, cfg.binary));
    }
  }

  await mkdir(targetDir, { recursive: true });
  await rename(join(extractDir, cfg.binary), finalPath);

  if (cfg.binary === 'uv') {
    chmodSync(finalPath, 0o755);
  }

  await rm(work, { recursive: true, force: true });
  process.stdout.write(`  ✓ ${finalPath}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const all = args.includes('--all');
  const mac = args.includes('--mac');

  let keys;
  if (all) keys = Object.keys(TARGETS);
  else if (mac) keys = ['darwin-arm64', 'darwin-x64'];
  else keys = [currentPlatformKey()];

  await mkdir(OUT_DIR, { recursive: true });

  for (const key of keys) {
    try {
      await fetchTarget(key, { force });
    } catch (err) {
      process.stderr.write(`  ✗ ${key}: ${err.message}\n`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.message}\n`);
  process.exit(1);
});
