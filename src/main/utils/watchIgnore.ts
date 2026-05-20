/**
 * Directories the file watcher must never descend into.
 *
 * Two rules govern this list (see the "sidebar must be realtime" feedback):
 *  1. NEVER add a directory the user navigates to in the sidebar (`.claude/`,
 *     `.devspace/`, `.vscode/`, source dirs). Hiding those from the watcher
 *     breaks realtime refresh. Bound the cost elsewhere (debounce + entry cap),
 *     don't hide.
 *  2. ONLY ignore truly noisy / never-hand-edited dependency & build output:
 *     these can each hold tens of thousands of files and, when watched across a
 *     broad project root, exhaust macOS fs.watch handles and stall the app.
 *
 * Ignoring here only stops *auto-refresh* of these dirs — they remain browsable
 * in the tree (FS_READ_DIR lists them, capped). They don't change during normal
 * dev, and a manual Refresh still re-lists them.
 */
export const WATCH_IGNORED: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.DS_Store$/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])dist-electron([\\/]|$)/,
  /(^|[\\/])out([\\/]|$)/,
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])target([\\/]|$)/,
  /(^|[\\/])\.next([\\/]|$)/,
  /(^|[\\/])\.turbo([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
  /(^|[\\/])coverage([\\/]|$)/,
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  // Heavy native / mobile / framework build & dependency trees. Added in
  // 0.26.1 after a report of the app hanging on large projects: these (esp.
  // CocoaPods `Pods/`, Gradle `.gradle/`, Expo `.expo/`, Xcode `DerivedData/`)
  // are NOT under node_modules so the existing ignore missed them, and each can
  // open thousands of watch handles across a broad workspace root.
  /(^|[\\/])Pods([\\/]|$)/,
  /(^|[\\/])\.gradle([\\/]|$)/,
  /(^|[\\/])\.expo([\\/]|$)/,
  /(^|[\\/])DerivedData([\\/]|$)/,
  /(^|[\\/])Carthage([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.tox([\\/]|$)/,
  /(^|[\\/])\.dart_tool([\\/]|$)/,
  /(^|[\\/])\.svelte-kit([\\/]|$)/,
  /(^|[\\/])\.parcel-cache([\\/]|$)/,
  /(^|[\\/])\.angular([\\/]|$)/,
];

/** True when `p` lies in / is one of the ignored directories above. */
export function isWatcherIgnored(p: string): boolean {
  return WATCH_IGNORED.some((re) => re.test(p));
}
