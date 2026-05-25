import { describe, expect, it } from 'vitest';

import { deriveProjectIdFromTab } from '../workspace';

describe('deriveProjectIdFromTab', () => {
  const projects = [
    { id: 'a', path: '/Users/x/Code/projA' },
    { id: 'b', path: '/Users/x/Code/projB' },
    // Nested workspace: projC contains projD as a sub-folder. Longest-prefix
    // match must pick projD, not the enclosing projC, so the sidebar follows
    // the deepest enclosing project.
    { id: 'c', path: '/Users/x/Code/projC' },
    { id: 'd', path: '/Users/x/Code/projC/packages/projD' },
  ];

  it('returns null for empty tab path', () => {
    expect(deriveProjectIdFromTab(null, projects)).toBeNull();
    expect(deriveProjectIdFromTab('', projects)).toBeNull();
    expect(deriveProjectIdFromTab(undefined, projects)).toBeNull();
  });

  it('returns null when no project encloses the tab path', () => {
    expect(deriveProjectIdFromTab('/Users/x/Other/file.ts', projects)).toBeNull();
  });

  it('matches plain absolute file paths via longest-prefix', () => {
    expect(
      deriveProjectIdFromTab('/Users/x/Code/projA/src/index.ts', projects),
    ).toBe('a');
    // Deepest enclosing project wins — projD beats projC even though projC
    // also encloses the path.
    expect(
      deriveProjectIdFromTab(
        '/Users/x/Code/projC/packages/projD/src/x.ts',
        projects,
      ),
    ).toBe('d');
    // File at exactly the project root resolves to that project.
    expect(
      deriveProjectIdFromTab('/Users/x/Code/projA', projects),
    ).toBe('a');
  });

  it('handles synthetic kinds: design / codeflow / devlog / live-preview', () => {
    expect(
      deriveProjectIdFromTab('design:/Users/x/Code/projA', projects),
    ).toBe('a');
    expect(
      deriveProjectIdFromTab('codeflow:/Users/x/Code/projB', projects),
    ).toBe('b');
    expect(
      deriveProjectIdFromTab('devlog:/Users/x/Code/projC', projects),
    ).toBe('c');
    expect(
      deriveProjectIdFromTab(
        'live-preview:/Users/x/Code/projC/packages/projD',
        projects,
      ),
    ).toBe('d');
  });

  it('synthetic match is exact equality, NOT prefix', () => {
    // A design tab whose embedded path doesn't equal any project root must
    // resolve to null — guards against the (theoretical) case where a
    // synthetic key points at a subfolder of a project; falling back to
    // prefix match would route the sidebar to the wrong project.
    expect(
      deriveProjectIdFromTab('design:/Users/x/Code/projA/extra', projects),
    ).toBeNull();
  });

  it('handles git diff prefix: diff:<absPath>', () => {
    expect(
      deriveProjectIdFromTab(
        'diff:/Users/x/Code/projA/src/index.ts',
        projects,
      ),
    ).toBe('a');
    // diff outside any project root returns null.
    expect(
      deriveProjectIdFromTab('diff:/Users/x/Other/file.ts', projects),
    ).toBeNull();
  });

  it('does not falsely match a path that happens to share a prefix with a project name', () => {
    // Project path is /Users/x/Code/projA — the file path below has projA
    // as a literal substring of a different directory name (projAlpha).
    // Without the trailing-slash check the naive `startsWith(p.path)` would
    // match projA. The implementation guards with `${p.path}/`.
    expect(
      deriveProjectIdFromTab(
        '/Users/x/Code/projAlpha/src/index.ts',
        projects,
      ),
    ).toBeNull();
  });

  it('returns null when projects list is empty', () => {
    expect(
      deriveProjectIdFromTab('/Users/x/Code/projA/index.ts', []),
    ).toBeNull();
    expect(
      deriveProjectIdFromTab('design:/Users/x/Code/projA', []),
    ).toBeNull();
  });
});
