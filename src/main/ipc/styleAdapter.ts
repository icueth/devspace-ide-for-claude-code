// IPC handlers for source-aware write-back. Same validation pattern as
// `devserver.ts` — projectPath must be absolute, no traversal segments,
// no follow-on assumptions about renderer trust.

import { ipcMain } from 'electron';
import * as path from 'node:path';

import {
  detectAdapter,
  writeBack,
} from '@main/services/style-adapters/StyleAdapterService';
import { IPC } from '@shared/ipc-channels';
import type {
  DesignAdapterDetectInput,
  DesignWriteBackInput,
} from '@shared/design';

// All IPC handlers validate `projectPath` against this shape before
// touching the service. The renderer is on the other side of an IPC
// boundary — even though it's "ours", the boundary is the only place
// to enforce policy.
function assertProjectPath(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error('projectPath is required');
  }
  if (!path.isAbsolute(value)) {
    throw new Error('projectPath must be absolute');
  }
  // Reject path traversal segments. `path.resolve` would silently fix
  // them, but if a `..` shows up here it indicates renderer-side
  // confusion (or worse) — fail loud so we notice.
  if (value.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error('projectPath must not contain ..');
  }
  return path.resolve(value);
}

export function registerStyleAdapterIpc(): void {
  ipcMain.handle(
    IPC.DESIGN_DETECT_ADAPTER,
    (_event, input: DesignAdapterDetectInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('DESIGN_DETECT_ADAPTER requires an input object');
      }
      const safe: DesignAdapterDetectInput = {
        projectPath: assertProjectPath(input.projectPath),
      };
      return detectAdapter(safe);
    },
  );

  ipcMain.handle(
    IPC.DESIGN_WRITE_BACK,
    (_event, input: DesignWriteBackInput) => {
      if (!input || typeof input !== 'object') {
        throw new Error('DESIGN_WRITE_BACK requires an input object');
      }
      if (!Array.isArray(input.edits)) {
        throw new Error('input.edits must be an array');
      }
      if (input.edits.length === 0) {
        throw new Error('input.edits must not be empty');
      }
      if (input.edits.length > 200) {
        throw new Error('input.edits[] too large (max 200)');
      }
      for (const e of input.edits as unknown[]) {
        if (!e || typeof e !== 'object') {
          throw new Error('every edit must be an object');
        }
        const edit = e as Record<string, unknown>;
        if (typeof edit.property !== 'string' || edit.property.length > 64) {
          throw new Error('edit.property must be a string ≤64 chars');
        }
        if (typeof edit.value !== 'string' || edit.value.length > 256) {
          throw new Error('edit.value must be a string ≤256 chars');
        }
        if (
          edit.tailwindClass !== undefined &&
          (typeof edit.tailwindClass !== 'string' ||
            edit.tailwindClass.length > 64)
        ) {
          throw new Error('edit.tailwindClass must be a string ≤64 chars');
        }
        const src = edit.source as Record<string, unknown> | undefined;
        if (!src || typeof src !== 'object') {
          throw new Error('edit.source is required');
        }
        if (typeof src.ref !== 'string' || src.ref.length > 1024) {
          throw new Error('edit.source.ref must be a string ≤1024 chars');
        }
      }
      const safe: DesignWriteBackInput = {
        ...input,
        projectPath: assertProjectPath(input.projectPath),
      };
      return writeBack(safe);
    },
  );
}
