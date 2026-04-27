import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '@shared/logger';
import type { Project } from '@shared/types';

const logger = createLogger('ProjectScanner');

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '.env',
  '__pycache__',
  'dist',
  'dist-electron',
  'build',
  'out',
  'target',
  '.next',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  'release',
]);

const RUNTIME_MARKERS: Array<{ file: string; runtime: string }> = [
  { file: 'package.json', runtime: 'node' },
  { file: 'pnpm-lock.yaml', runtime: 'pnpm' },
  { file: 'yarn.lock', runtime: 'yarn' },
  { file: 'bun.lockb', runtime: 'bun' },
  { file: 'Cargo.toml', runtime: 'rust' },
  { file: 'go.mod', runtime: 'go' },
  { file: 'pyproject.toml', runtime: 'python' },
  { file: 'requirements.txt', runtime: 'python' },
  { file: 'Pipfile', runtime: 'python' },
  { file: 'Gemfile', runtime: 'ruby' },
  { file: 'composer.json', runtime: 'php' },
  { file: 'pom.xml', runtime: 'java' },
  { file: 'build.gradle', runtime: 'gradle' },
  { file: 'Dockerfile', runtime: 'docker' },
];

function hashPath(absPath: string): string {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 12);
}

async function detectProject(
  absPath: string,
  workspaceId: string,
  options: { forceInclude?: boolean } = {},
): Promise<Project | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(absPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const names = new Set(entries.map((e) => e.name));
  const isGit = names.has('.git');
  const runtimes = RUNTIME_MARKERS.filter((m) => names.has(m.file)).map((m) => m.runtime);

  if (!isGit && runtimes.length === 0 && !options.forceInclude) return null;

  return {
    id: hashPath(absPath),
    name: path.basename(absPath),
    path: absPath,
    workspaceId,
    vcs: isGit ? 'git' : 'none',
    detectedRuntime: runtimes,
  };
}

export async function scanWorkspace(
  workspacePath: string,
  workspaceId: string,
  options: { maxDepth?: number } = {},
): Promise<Project[]> {
  const maxDepth = options.maxDepth ?? 2;
  const projects: Project[] = [];
  const seen = new Set<string>();

  // Monorepo / single-project case: if the workspace root itself has a marker
  // AND it looks like a monorepo (runtime markers present, OR no immediate
  // children are themselves git repos), register the root as a pinned project
  // so the CLI can target it. A container like `~/Code` (many sub-repos, no
  // top-level runtime marker) stays a pure container — we don't add root.
  try {
    const rootProject = await detectProject(workspacePath, workspaceId);
    if (rootProject) {
      const entries = await fs.promises.readdir(workspacePath, { withFileTypes: true });
      let subGitCount = 0;
      await Promise.all(
        entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
          .map(async (d) => {
            try {
              const st = await fs.promises.stat(path.join(workspacePath, d.name, '.git'));
              if (st.isDirectory() || st.isFile()) subGitCount++;
            } catch {
              /* no .git — fine */
            }
          }),
      );
      const isMonorepoRoot = rootProject.detectedRuntime.length > 0 || subGitCount === 0;
      if (isMonorepoRoot) {
        rootProject.isWorkspaceRoot = true;
        projects.push(rootProject);
        seen.add(rootProject.path);
      }
    }
  } catch (err) {
    logger.warn(`root detection failed for ${workspacePath}:`, (err as Error).message);
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    // The workspace root itself is never a "project" — the user chose it as a
    // container of projects. Skipping detection at depth 0 prevents a parent
    // dir with its own `.git` (e.g. `~/Code` tracked as a metarepo) from
    // swallowing every sub-project beneath it.
    if (depth > 0) {
      const project = await detectProject(dir, workspaceId);
      if (project && !seen.has(project.path)) {
        projects.push(project);
        seen.add(project.path);
        // Don't descend into a detected project — avoids treating monorepo
        // packages as standalone projects at the outer level.
        return;
      }
    }

    if (depth === maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirs = entries.filter(
      (e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name),
    );

    // At depth 1 (immediate children of the workspace), treat every remaining
    // folder as a project even without markers. This lets users see empty
    // scaffolds and brand-new folders without having to `git init` first.
    if (depth === 0) {
      await Promise.all(
        subdirs.map(async (d) => {
          const childPath = path.join(dir, d.name);
          if (seen.has(childPath)) return;
          const detected = await detectProject(childPath, workspaceId);
          if (detected) {
            projects.push(detected);
            seen.add(detected.path);
            return;
          }
          const forced = await detectProject(childPath, workspaceId, {
            forceInclude: true,
          });
          if (forced) {
            projects.push(forced);
            seen.add(forced.path);
          }
        }),
      );
      return;
    }

    await Promise.all(subdirs.map((d) => walk(path.join(dir, d.name), depth + 1)));
  }

  try {
    await walk(workspacePath, 0);
  } catch (err) {
    logger.warn(`scan failed for ${workspacePath}:`, (err as Error).message);
  }

  projects.sort((a, b) => {
    // Workspace-root project always sorts first so the sidebar can pin it.
    if (a.isWorkspaceRoot && !b.isWorkspaceRoot) return -1;
    if (!a.isWorkspaceRoot && b.isWorkspaceRoot) return 1;
    return a.name.localeCompare(b.name);
  });
  return projects;
}
