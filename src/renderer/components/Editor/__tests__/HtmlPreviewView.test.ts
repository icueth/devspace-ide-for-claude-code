import { describe, expect, it } from 'vitest';

import {
  derivePreviewName,
  pickLatestPreview,
} from '@renderer/components/Editor/HtmlPreviewView';
import type { PreviewFileInfo } from '@shared/preview';

// `derivePreviewName` powers the toolbar/title label; `pickLatestPreview`
// powers the "Open latest HTML preview" Spotlight command. Both are pure so
// we pin their rules without standing up the iframe or IPC.

function file(path: string, mtime: number): PreviewFileInfo {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, mtime };
}

describe('derivePreviewName — toolbar/title label from a path', () => {
  it('returns the basename of a POSIX path', () => {
    expect(derivePreviewName('/proj/.devspace/preview/landing.html')).toBe(
      'landing.html',
    );
  });

  it('returns the basename of a Windows-style path', () => {
    expect(derivePreviewName('C:\\proj\\.devspace\\preview\\hero.html')).toBe(
      'hero.html',
    );
  });

  it('returns the input unchanged when there is no separator', () => {
    expect(derivePreviewName('page.html')).toBe('page.html');
  });

  it('falls back to a stable default for an empty path', () => {
    expect(derivePreviewName('')).toBe('preview.html');
  });

  it('falls back to the default when the path ends in a separator', () => {
    expect(derivePreviewName('/proj/preview/')).toBe('preview.html');
  });
});

describe('pickLatestPreview — most-recently-modified file selection', () => {
  it('returns null for an empty list', () => {
    expect(pickLatestPreview([])).toBeNull();
  });

  it('returns the only file when the list has one entry', () => {
    const f = file('/p/a.html', 100);
    expect(pickLatestPreview([f])).toBe(f);
  });

  it('picks the file with the greatest mtime regardless of order', () => {
    const older = file('/p/old.html', 100);
    const newer = file('/p/new.html', 500);
    const mid = file('/p/mid.html', 300);
    expect(pickLatestPreview([older, newer, mid])).toBe(newer);
  });

  it('breaks mtime ties deterministically by path (ascending)', () => {
    const b = file('/p/b.html', 200);
    const a = file('/p/a.html', 200);
    // Same mtime → lexicographically smaller path wins, independent of order.
    expect(pickLatestPreview([b, a])?.path).toBe('/p/a.html');
    expect(pickLatestPreview([a, b])?.path).toBe('/p/a.html');
  });
});
