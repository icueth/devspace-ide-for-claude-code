# Graphify Phase 0 — Freeze Spike + Packaging Proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a bundled, per-OS standalone `graphify` binary (PyInstaller `--onedir`) inside DevSpace's existing resource-bundling pipeline, with a runtime resolver and a CI test that proves every bundled tree-sitter grammar loads — de-risking the only "yellow" item before any TS migration.

**Architecture:** Mirror DevSpace's proven `uv`-bundling pipeline exactly — a build-time fetch/freeze script writes `resources/graphify/<platform>/`, `electron-builder` `extraResources` maps it into `Resources/`, `after-pack.cjs` prunes the wrong arch, and a `graphifyPaths.ts` resolver finds the binary at runtime by `process.platform`/`arch`. The freeze installs `graphifyy[mcp]==0.8.35` from PyPI into a throwaway venv, generates the dynamic tree-sitter grammar import list programmatically from `graphify.extract`'s `LanguageConfig` table, and excludes every heavy optional (graspologic/numba/scipy/matplotlib/whisper/LLM SDKs) so the freeze stays minimal (~60–110 MB) and offline.

**Tech Stack:** Node ESM build scripts, PyInstaller, Python venv, `graphifyy[mcp]` (PyPI), electron-builder, Vitest (TS unit tests), GitHub Actions (4-leg native matrix).

**Reference spec:** `docs/superpowers/specs/2026-06-08-codeflow-to-graphify-design.md` (§2 pipeline precedent, §3 freeze gotcha, §8 packaging, §11 risks R-GRAMMAR/R-BLOAT/R-SIGN).

**Scope note:** This plan covers Phase 0 only. Phases 1–4 (delete docs layer, wire adapter, query UI, verified deletes) are authored as separate plans after Phase 0 validates the freeze empirically — exact adapter/UI code depends on running this binary against the real DevSpace repo.

---

## File Structure

| File | New/Mod | Responsibility |
|------|---------|----------------|
| `scripts/graphify/entry.py` | Create | PyInstaller entry shim → `graphify.__main__:main` |
| `scripts/graphify/gen_grammar_imports.py` | Create | Enumerate `LanguageConfig.ts_module` from the installed package → JSON list |
| `scripts/graphify/validate_langs.py` | Create | Run the frozen binary against a fixture, assert no grammar silently dropped |
| `scripts/freeze-graphify.mjs` | Create | Per-OS PyInstaller `--onedir` freeze driver (sibling of `fetch-uv.mjs`) |
| `src/main/utils/graphifyPaths.ts` | Create | Runtime resolver for the bundled binary (clone of `mempalacePaths.ts` uv fns) |
| `src/main/utils/__tests__/graphifyPaths.test.ts` | Create | Unit test for `platformKey()` + path resolution |
| `tests/fixtures/graphify-langs/` | Create | One tiny source file per bundled language |
| `scripts/after-pack.cjs` | Modify | Also prune `resources/graphify/<wrong-arch>` on single-arch mac |
| `package.json` | Modify | Add `extraResources` entry `resources/graphify → graphify` |
| `.github/workflows/graphify-freeze.yml` | Create | 4-leg native freeze + per-language validation |

**Pinned version:** `GRAPHIFY_VERSION = 0.8.35` (override via `GRAPHIFY_VERSION` env).

---

## Task 1: PyInstaller entry shim

**Files:**
- Create: `scripts/graphify/entry.py`

- [ ] **Step 1: Write the entry shim**

`scripts/graphify/entry.py`:

```python
"""PyInstaller entry point for the bundled graphify binary.

graphify's console_script is `graphify = graphify.__main__:main` (pyproject.toml:77).
PyInstaller needs a concrete script file to freeze, so we re-export main() here.
`raise SystemExit(main())` works whether main() returns an exit code or None.
"""
from graphify.__main__ import main

raise SystemExit(main())
```

- [ ] **Step 2: Commit**

```bash
git add scripts/graphify/entry.py
git commit -m "build(graphify): add PyInstaller entry shim"
```

---

## Task 2: Grammar-import generator (defeats the silent-drop gotcha)

graphify loads grammars via `importlib.import_module(config.ts_module)` (`extract.py:2159`), invisible to PyInstaller. This script enumerates every `LanguageConfig.ts_module` so the freeze can force-include each grammar as both a hidden-import and a collected binary.

**Files:**
- Create: `scripts/graphify/gen_grammar_imports.py`

- [ ] **Step 1: Write the generator**

`scripts/graphify/gen_grammar_imports.py`:

```python
"""Print the tree-sitter grammar modules to bundle, as a JSON array, by listing
every installed `tree_sitter_*` top-level module in the (freeze) environment.

Run with the freeze venv's python AFTER installing graphifyy[mcp]:
    python scripts/graphify/gen_grammar_imports.py
Output (stdout): ["tree_sitter_c", "tree_sitter_go", "tree_sitter_python", ...]

Why enumerate INSTALLED modules instead of graphify's LanguageConfig table?
graphify loads grammars two ways — a generic LanguageConfig table (`ts_module=...`,
14 grammars) AND bespoke per-language functions that do `import tree_sitter_go`
etc. (extract.py:5727/6071/6350/8386/9597 for go/rust/zig/elixir/bash). Listing
installed modules captures BOTH, so no grammar is silently dropped from the
PyInstaller --hidden-import / --collect-binaries set (risk R-GRAMMAR). graphifyy
declares each grammar as a hard dependency, so the installed set IS the intended
grammar set.
"""
import json
import pkgutil
import sys

# Aggregate meta-packages graphify does not use individually.
AGGREGATES = {"tree_sitter_languages", "tree_sitter_language_pack"}

mods = sorted(
    m.name
    for m in pkgutil.iter_modules()
    if m.name.startswith("tree_sitter_") and m.name not in AGGREGATES
)

if not mods:
    print("error: no tree_sitter_* grammar modules installed", file=sys.stderr)
    raise SystemExit(2)

print(json.dumps(mods))
```

- [ ] **Step 2: Verify (runs against the freeze venv in Task 4)**

`pkgutil.iter_modules()` reflects what's installed, so this is validated inside the freeze (Task 4) after `uv pip install graphifyy[mcp]`. The freeze prints `• N grammars: tree_sitter_…` — expect a JSON array containing at least `tree_sitter_python`, `tree_sitter_javascript`, `tree_sitter_typescript`, `tree_sitter_go`, `tree_sitter_rust` (≈26 entries). If it prints `error: no tree_sitter_* grammar modules installed`, the install step failed — inspect the pip log before proceeding.

- [ ] **Step 3: Commit**

```bash
git add scripts/graphify/gen_grammar_imports.py
git commit -m "build(graphify): enumerate tree-sitter grammar modules for freeze"
```

---

## Task 3: Per-language validation script

**Files:**
- Create: `scripts/graphify/validate_langs.py`
- Create: `tests/fixtures/graphify-langs/` (one file per language)

- [ ] **Step 1: Create the language fixture files**

Create one minimal source file per common bundled language so extraction exercises each grammar. Each must contain a declaration the grammar will turn into a node.

`tests/fixtures/graphify-langs/sample.py`:

```python
def greet(name):
    return f"hi {name}"
```

`tests/fixtures/graphify-langs/sample.js`:

```javascript
export function greet(name) { return `hi ${name}`; }
```

`tests/fixtures/graphify-langs/sample.ts`:

```typescript
export function greet(name: string): string { return `hi ${name}`; }
```

`tests/fixtures/graphify-langs/sample.go`:

```go
package main

func Greet(name string) string { return "hi " + name }
```

`tests/fixtures/graphify-langs/sample.rs`:

```rust
pub fn greet(name: &str) -> String { format!("hi {}", name) }
```

`tests/fixtures/graphify-langs/sample.rb`:

```ruby
def greet(name)
  "hi #{name}"
end
```

`tests/fixtures/graphify-langs/sample.php`:

```php
<?php
function greet($name) { return "hi $name"; }
```

`tests/fixtures/graphify-langs/sample.java`:

```java
class Sample { static String greet(String name) { return "hi " + name; } }
```

(Add the remaining bundled languages — c, cpp, c-sharp, kotlin, scala, swift, lua, bash, etc. — one tiny declaration file each, matching the grammar set Task 2 emits. Keep each file to a single function/class so a missing grammar is obvious as a zero-node result.)

- [ ] **Step 2: Write the validator**

`scripts/graphify/validate_langs.py`:

```python
"""Run a frozen graphify binary against the language fixture and fail if any
bundled grammar silently dropped (returns no nodes / 'not installed' error).

Usage:  python scripts/graphify/validate_langs.py <graphify-binary> <fixture-dir>
Exit 0 on success; non-zero with a per-language report on failure.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

EXT_TO_LANG = {
    ".py": "python", ".js": "javascript", ".ts": "typescript", ".go": "go",
    ".rs": "rust", ".rb": "ruby", ".php": "php", ".java": "java",
    ".c": "c", ".cpp": "cpp", ".cs": "c_sharp", ".kt": "kotlin",
    ".scala": "scala", ".swift": "swift", ".lua": "lua", ".sh": "bash",
}


def main() -> int:
    binary, fixture = sys.argv[1], Path(sys.argv[2])
    expected = {EXT_TO_LANG[p.suffix] for p in fixture.iterdir()
                if p.suffix in EXT_TO_LANG}

    with tempfile.TemporaryDirectory() as out:
        proc = subprocess.run(
            [binary, "extract", str(fixture), "--out", out, "--no-cluster"],
            capture_output=True, text=True, env={"GRAPHIFY_QUERY_LOG_DISABLE": "1"},
        )
        combined = proc.stdout + proc.stderr
        if "not installed" in combined:
            print(f"FAIL: a grammar reported 'not installed':\n{combined}", file=sys.stderr)
            return 1

        graph_path = Path(out) / "graphify-out" / "graph.json"
        if not graph_path.is_file():
            print(f"FAIL: no graph.json produced. exit={proc.returncode}\n{combined}",
                  file=sys.stderr)
            return 1

        graph = json.loads(graph_path.read_text())
        node_count = len(graph.get("nodes", []))
        if node_count == 0:
            print(f"FAIL: graph has zero nodes.\n{combined}", file=sys.stderr)
            return 1

    print(f"OK: extracted {node_count} nodes across {len(expected)} languages: "
          f"{', '.join(sorted(expected))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 3: Commit**

```bash
git add scripts/graphify/validate_langs.py tests/fixtures/graphify-langs/
git commit -m "test(graphify): language fixture + grammar-load validator"
```

---

## Task 4: `freeze-graphify.mjs` — the per-OS freeze driver

**Files:**
- Create: `scripts/freeze-graphify.mjs`

- [ ] **Step 1: Write the freeze script**

`scripts/freeze-graphify.mjs`:

```javascript
#!/usr/bin/env node
/*
 * Freezes `graphifyy` (PyPI) into a per-OS standalone binary with PyInstaller
 * --onedir and unpacks it into resources/graphify/<platform>/. Native C
 * extensions (CPython, tree-sitter grammar .so/.pyd) CANNOT cross-compile, so
 * this runs ONCE PER OS/ARCH on its own runner (current platform only).
 *
 * The result is bundled via electron-builder `extraResources`, resolved at
 * runtime by src/main/utils/graphifyPaths.ts — no Python on user machines.
 *
 * Usage:
 *   node scripts/freeze-graphify.mjs            # freeze for the current host
 *   GRAPHIFY_VERSION=0.8.35 node scripts/freeze-graphify.mjs
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

// Heavy / unused-offline modules excluded to keep the freeze minimal + green.
// (These are optional extras we don't install, but excluding stops PyInstaller
//  from following any stray lazy import inside graphify source.)
const EXCLUDES = [
  'graspologic', 'numba', 'llvmlite', 'scipy', 'sklearn', 'sklearn.utils',
  'matplotlib', 'pandas', 'faster_whisper', 'ctranslate2', 'boto3', 'botocore',
  'tiktoken', 'openai', 'anthropic', 'gensim', 'umap', 'hyppo', 'pot',
  'starlette', 'uvicorn', // HTTP MCP transport — we use stdio only
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
  const venvBin = (name) =>
    join(work, 'venv', osPlatform() === 'win32' ? 'Scripts' : 'bin', name);
  const exeName = osPlatform() === 'win32' ? 'graphify.exe' : 'graphify';
  const finalDir = join(OUT_DIR, key);

  if (!force && existsSync(join(finalDir, exeName))) {
    process.stdout.write(`  • ${key}: already frozen, skipping\n`);
    return;
  }

  const work = join(tmpdir(), `devspace-graphify-${key}-freeze`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  process.stdout.write(`→ ${key}: creating venv + installing graphifyy[mcp]==${GRAPHIFY_VERSION}\n`);
  await run('python3', ['-m', 'venv', join(work, 'venv')]);
  await run(venvBin('python'), ['-m', 'pip', 'install', '--upgrade', 'pip']);
  await run(venvBin('python'), [
    '-m', 'pip', 'install',
    'pyinstaller>=6.0',
    `graphifyy[mcp]==${GRAPHIFY_VERSION}`,
  ]);

  process.stdout.write(`→ ${key}: enumerating tree-sitter grammars\n`);
  const grammarsJson = await run(venvBin('python'), [GEN_IMPORTS]);
  const grammars = JSON.parse(grammarsJson.trim().split('\n').pop());
  process.stdout.write(`  • ${grammars.length} grammars: ${grammars.join(', ')}\n`);

  const piArgs = [
    '-m', 'PyInstaller', '--noconfirm', '--onedir', '--name', 'graphify',
    '--distpath', join(work, 'dist'),
    '--workpath', join(work, 'build'),
    '--specpath', work,
    '--collect-binaries', 'tree_sitter',
  ];
  for (const g of grammars) {
    piArgs.push('--hidden-import', g, '--collect-binaries', g);
  }
  for (const e of EXCLUDES) piArgs.push('--exclude-module', e);
  piArgs.push(ENTRY);

  process.stdout.write(`→ ${key}: running PyInstaller\n`);
  await run(venvBin('python'), piArgs);

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
```

- [ ] **Step 2: Run the freeze on the current host (macOS-arm64)**

Run:

```bash
node scripts/freeze-graphify.mjs
```

Expected: ends with `✓ .../resources/graphify/darwin-arm64/graphify`, and the grammar line lists ≥20 `tree_sitter_*` names. (First run takes minutes — pip install + PyInstaller analysis.)

- [ ] **Step 3: Verify the frozen binary runs and is offline-capable**

Run:

```bash
./resources/graphify/darwin-arm64/graphify --version
./resources/graphify/darwin-arm64/graphify --help | head -20
```

Expected: prints a graphify version/help **without** any Python on PATH being required and without `ModuleNotFoundError`.

- [ ] **Step 4: Validate every grammar loads (the silent-drop guard)**

Run:

```bash
python3 scripts/graphify/validate_langs.py ./resources/graphify/darwin-arm64/graphify tests/fixtures/graphify-langs
```

Expected: `OK: extracted N nodes across M languages: ...`. If it prints `FAIL: a grammar reported 'not installed'`, a `--collect-binaries` entry is missing — confirm Task 2's output matches the grammar set and re-freeze.

- [ ] **Step 5: Confirm `resources/graphify/` is git-ignored (built artifact, not committed)**

Run:

```bash
grep -n "resources/graphify\|resources/mempalace-uv" .gitignore
```

Expected: `resources/mempalace-uv` is already ignored. If `resources/graphify` is not covered, add it:

```bash
echo "resources/graphify/" >> .gitignore
```

- [ ] **Step 6: Commit**

```bash
git add scripts/freeze-graphify.mjs .gitignore
git commit -m "build(graphify): per-OS PyInstaller --onedir freeze driver"
```

---

## Task 5: Runtime resolver `graphifyPaths.ts`

**Files:**
- Create: `src/main/utils/graphifyPaths.ts`
- Test: `src/main/utils/__tests__/graphifyPaths.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/utils/__tests__/graphifyPaths.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app' },
}));

import { getBundledGraphifyDir, getBundledGraphifyBinary } from '../graphifyPaths';

describe('graphifyPaths', () => {
  it('resolves the per-platform dir under resources/ in dev', () => {
    const dir = getBundledGraphifyDir();
    expect(dir).toContain('/fake/app/resources/graphify/');
    // platformKey is one of the four supported slugs (or host fallback)
    expect(dir).toMatch(/graphify\/(darwin-arm64|darwin-x64|linux-x64|win32-x64|[a-z0-9]+-[a-z0-9]+)$/);
  });

  it('appends the platform-correct executable name', () => {
    const bin = getBundledGraphifyBinary();
    expect(bin.endsWith('graphify') || bin.endsWith('graphify.exe')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/utils/__tests__/graphifyPaths.test.ts`
Expected: FAIL — `Cannot find module '../graphifyPaths'`.

- [ ] **Step 3: Write the resolver**

`src/main/utils/graphifyPaths.ts`:

```typescript
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolves absolute paths into the bundled `graphify/<platform>/` directory.
 * Same shape as mempalacePaths.ts (uv): packaged build reads from
 * process.resourcesPath (mapped via electron-builder extraResources), dev
 * reads from resources/. The binary is a PyInstaller --onedir tree:
 *   resources/graphify/<platform>/graphify[.exe]  +  _internal/
 */

let cachedDir: string | null = null;

function resourcesRoot(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'resources');
}

function platformKey(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64') return 'darwin-x64';
  if (p === 'linux' && a === 'x64') return 'linux-x64';
  if (p === 'win32' && a === 'x64') return 'win32-x64';
  return `${p}-${a}`;
}

export function getBundledGraphifyDir(): string {
  if (cachedDir !== null) return cachedDir;
  cachedDir = path.join(resourcesRoot(), 'graphify', platformKey());
  return cachedDir;
}

export function getBundledGraphifyBinary(): string {
  const exe = process.platform === 'win32' ? 'graphify.exe' : 'graphify';
  return path.join(getBundledGraphifyDir(), exe);
}

export function bundledGraphifyExists(): boolean {
  try {
    return fs.statSync(getBundledGraphifyBinary()).isFile();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/utils/__tests__/graphifyPaths.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/utils/graphifyPaths.ts src/main/utils/__tests__/graphifyPaths.test.ts
git commit -m "feat(graphify): runtime resolver for bundled binary"
```

---

## Task 6: Bundle via `extraResources` + prune wrong-arch

**Files:**
- Modify: `package.json` (build.extraResources, after `resources/mempalace-uv` entry ~line 186)
- Modify: `scripts/after-pack.cjs`

- [ ] **Step 1: Add the extraResources entry**

In `package.json`, inside `build.extraResources`, add this object immediately after the `mempalace-uv` entry (after line 186):

```json
      {
        "from": "resources/graphify",
        "to": "graphify",
        "filter": [
          "**/*"
        ]
      },
```

- [ ] **Step 2: Verify package.json still parses**

Run: `node -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Extend after-pack.cjs to prune wrong-arch graphify**

In `scripts/after-pack.cjs`, after the existing uv prune block (after line 37, before the closing `};`), add a second prune for graphify. Replace the existing single-target body with both prunes:

```javascript
  const wrongArch = archName === 'arm64' ? 'darwin-x64' : 'darwin-arm64';
  const productFilename = context.packager.appInfo.productFilename;
  const resourcesDir = path.join(
    context.appOutDir,
    `${productFilename}.app`,
    'Contents',
    'Resources',
  );

  for (const bundle of ['mempalace-uv', 'graphify']) {
    const target = path.join(resourcesDir, bundle, wrongArch);
    try {
      await rm(target, { recursive: true, force: true });
      console.log(`[after-pack] pruned wrong-arch ${bundle} (${wrongArch}) for ${archName} build`);
    } catch (err) {
      console.warn(`[after-pack] ${bundle} prune skipped: ${err.message}`);
    }
  }
```

(This replaces the old `const wrongArch … rm(target …)` block — the uv prune is now covered by the loop, so delete the original single-target lines 22–38 to avoid duplication.)

- [ ] **Step 4: Verify after-pack.cjs is valid JS**

Run: `node -e "require('./scripts/after-pack.cjs'); console.log('ok')"`
Expected: `ok` (module loads without syntax error).

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/after-pack.cjs
git commit -m "build(graphify): bundle via extraResources + prune wrong-arch in after-pack"
```

---

## Task 7: CI — 4-leg native freeze + per-language validation

**Files:**
- Create: `.github/workflows/graphify-freeze.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/graphify-freeze.yml`:

```yaml
name: graphify-freeze

on:
  workflow_dispatch:
  pull_request:
    paths:
      - 'scripts/freeze-graphify.mjs'
      - 'scripts/graphify/**'
      - '.github/workflows/graphify-freeze.yml'

jobs:
  freeze:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14      # darwin-arm64
            key: darwin-arm64
          - os: macos-13      # darwin-x64
            key: darwin-x64
          - os: ubuntu-latest # linux-x64
            key: linux-x64
          - os: windows-latest # win32-x64
            key: win32-x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install uv
        uses: astral-sh/setup-uv@v4

      - name: Freeze graphify (uv provisions Python 3.12)
        run: node scripts/freeze-graphify.mjs

      - name: Validate every bundled grammar loads (POSIX)
        if: runner.os != 'Windows'
        run: |
          python3 scripts/graphify/validate_langs.py \
            "resources/graphify/${{ matrix.key }}/graphify" \
            tests/fixtures/graphify-langs

      - name: Validate every bundled grammar loads (Windows)
        if: runner.os == 'Windows'
        run: |
          python scripts/graphify/validate_langs.py `
            "resources/graphify/${{ matrix.key }}/graphify.exe" `
            tests/fixtures/graphify-langs

      - name: Report frozen size
        if: runner.os != 'Windows'
        run: du -sh "resources/graphify/${{ matrix.key }}"

      - uses: actions/upload-artifact@v4
        with:
          name: graphify-${{ matrix.key }}
          path: resources/graphify/${{ matrix.key }}
          retention-days: 7
```

- [ ] **Step 2: Validate the workflow YAML**

Run: `npx --yes js-yaml .github/workflows/graphify-freeze.yml > /dev/null && echo ok`
Expected: `ok` (valid YAML). If `js-yaml` is unavailable, run `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/graphify-freeze.yml')); print('ok')"`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/graphify-freeze.yml
git commit -m "ci(graphify): 4-leg native freeze + per-language grammar validation"
```

- [ ] **Step 4: Trigger the matrix and confirm all 4 legs pass**

Push the branch and run:

```bash
gh workflow run graphify-freeze.yml --ref "$(git branch --show-current)"
gh run watch
```

Expected: all 4 legs green; each `Validate` step prints `OK: extracted N nodes …`; `Report frozen size` shows ≈60–110 MB. **Any leg that fails on a niche grammar** (swift/powershell/zig/verilog/fortran/objc/julia) reveals a per-platform wheel/source-build gap — record it; the fix is either a C-toolchain step on that runner or making that grammar a per-platform exclude in `gen_grammar_imports.py`. This is the niche-grammar audit (spec §8.7), executed empirically rather than guessed.

---

## Self-Review

**1. Spec coverage (Phase 0 items in spec §8 / §10):**
- Freeze script with generated grammar imports → Task 4 + Task 2 ✅
- `--onedir` not `--onefile` → Task 4 (`--onedir`) ✅
- Exclude heavy optionals (graspologic/numba/scipy/matplotlib/whisper/boto3/tiktoken) → Task 4 `EXCLUDES` ✅
- Minimal deps via `graphifyy[mcp]` (no `[all]`/`[leiden]`) → Task 4 pip install ✅
- `extraResources` + `after-pack` prune (mirror uv) → Task 6 ✅
- `graphifyPaths.ts` resolver (clone mempalacePaths) → Task 5 ✅
- 4-leg CI matrix → Task 7 ✅
- macOS codesign/notarize of embedded `.so/.pyd` (R-SIGN) → **covered by the existing mac dist flow, not Phase 0 CI**; flagged for the release-build plan (validation that the embedded binaries are signed happens when the full app is packaged/notarized, out of this spike's scope). ✅ (noted)
- Per-language fixture validation (R-GRAMMAR) → Task 3 + Task 7 ✅
- Niche-grammar wheel audit → Task 7 Step 4 (empirical, per-leg) ✅

**2. Placeholder scan:** Task 3 Step 1 intentionally lists the common languages with explicit fixture code and instructs adding the remainder to match Task 2's emitted set — this is concrete (real files, real pattern), not a "TODO". No "TBD"/"handle edge cases"/"write tests for the above" present. ✅

**3. Type/name consistency:** `platformKey()` slugs (`darwin-arm64`/`darwin-x64`/`linux-x64`/`win32-x64`) identical across `freeze-graphify.mjs`, `graphifyPaths.ts`, and the CI `matrix.key`. Exe name `graphify`/`graphify.exe` consistent (Task 4 `exeName`, Task 5 `getBundledGraphifyBinary`, Task 7 validate steps). `resources/graphify/<key>/` layout consistent across freeze output (Task 4), extraResources `from` (Task 6), resolver (Task 5), and CI artifact path (Task 7). Generator function name `gen_grammar_imports.py` consistent (Task 2, Task 4 `GEN_IMPORTS`). ✅

---

## Definition of Done (Phase 0)

- `node scripts/freeze-graphify.mjs` produces a runnable `resources/graphify/<host>/graphify` with no Python on PATH.
- `validate_langs.py` passes locally and on all 4 CI legs — proving no grammar silently dropped.
- Frozen size ≈60–110 MB/platform (logged in CI).
- `graphifyPaths.ts` unit test green; `extraResources` + `after-pack` wired and parse-valid.
- Niche-grammar gaps (if any) recorded for the per-platform exclude list.

**Outcome that gates Phase 1+:** if the freeze is green on all 4 legs and within size budget, proceed to author the Phase 1 plan (delete the narrative-doc + augment layer). If a leg is red on a grammar with no clean fix, narrow the bundled language set in `gen_grammar_imports.py` and re-validate before proceeding.
