import { MemPalaceSettings } from '@renderer/components/Settings/MemPalaceSettings';

/**
 * Memory settings panel (Settings → Memory).
 *
 * The sub-project 3 "Learn from recent work" (native learning) trigger now
 * lives in the Sidebar, above the project root (see SidebarLearnButton). This
 * tab hosts the MemPalace installer.
 */
export function MemorySettings() {
  return (
    <div className="h-full overflow-y-auto">
      <MemPalaceSettings />
    </div>
  );
}
