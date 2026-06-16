import { MemPalaceSettings } from '@renderer/components/Settings/MemPalaceSettings';

/**
 * Memory settings panel (Settings → Memory).
 *
 * Native learning is automatic now; the Sidebar hosts a read-only learnings
 * viewer above the project root (see SidebarLearnings) — there's no manual
 * "Learn from recent work" trigger anymore. This tab hosts the MemPalace
 * installer.
 */
export function MemorySettings() {
  return (
    <div className="h-full overflow-y-auto">
      <MemPalaceSettings />
    </div>
  );
}
