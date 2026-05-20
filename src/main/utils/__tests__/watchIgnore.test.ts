import { describe, expect, it } from 'vitest';

import { isWatcherIgnored } from '../watchIgnore';

describe('isWatcherIgnored', () => {
  it('ignores dependency / build output trees', () => {
    for (const p of [
      '/p/node_modules',
      '/p/node_modules/.pnpm/foo',
      '/p/.git/HEAD',
      '/p/dist/index.js',
      '/p/ios/Pods/Firebase',
      '/p/android/.gradle/caches',
      '/p/.expo/web',
      '/p/ios/build/DerivedData/x',
      '/p/Carthage/Build',
      '/p/src/__pycache__/m.pyc',
      '/p/.pytest_cache/v',
      '/p/.mypy_cache/3.11',
      '/p/.dart_tool/pkg',
      '/p/web/.svelte-kit/generated',
      '/p/.parcel-cache/x',
      '/p/.angular/cache',
      '/p/.venv/bin',
      '/p/venv/lib',
    ]) {
      expect(isWatcherIgnored(p), p).toBe(true);
    }
  });

  it('NEVER ignores user-navigable project dirs (memory: sidebar must be realtime)', () => {
    for (const p of [
      '/p/src/components/Button.tsx',
      '/p/.claude/codeflow/doc.md',
      '/p/.devspace/design/screen.html',
      '/p/.vscode/settings.json',
      '/p/lib/utils.ts',
      '/p/packages/web/src/app.tsx',
      // Substring traps must not match the whole-segment regex.
      '/p/my-node_modules-helper/x.ts',
      '/p/src/building/wall.ts',
      '/p/distribution/readme.md',
    ]) {
      expect(isWatcherIgnored(p), p).toBe(false);
    }
  });
});
