// electron-builder `afterPack` hook.
//
// Strips the wrong-architecture bundled `uv` binary from the packaged app's
// Resources. An arm64 dmg was shipping the 34MB darwin-x64 `uv` (and vice
// versa) — pure dead weight, since the runtime resolves uv by `process.arch`
// (see src/main/utils/mempalacePaths.ts). Universal builds keep both arches.
//
// This runs once per packed arch, after electron-builder has copied
// extraResources into <App>.app/Contents/Resources.
const { rm } = require('node:fs/promises');
const path = require('node:path');

// electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const archName = ARCH_NAMES[context.arch];
  // Universal merges both x64+arm64 — it must keep both uv binaries.
  if (!archName || archName === 'universal') return;

  const wrongArch = archName === 'arm64' ? 'darwin-x64' : 'darwin-arm64';
  const productFilename = context.packager.appInfo.productFilename;
  const target = path.join(
    context.appOutDir,
    `${productFilename}.app`,
    'Contents',
    'Resources',
    'mempalace-uv',
    wrongArch,
  );

  try {
    await rm(target, { recursive: true, force: true });
    console.log(`[after-pack] pruned wrong-arch uv (${wrongArch}) for ${archName} build`);
  } catch (err) {
    console.warn(`[after-pack] uv prune skipped: ${err.message}`);
  }
};
