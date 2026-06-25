import * as fs from 'node:fs';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import type { Task } from '@shared/types';

export interface TasksFile {
  tasks: Task[];
}

export async function loadTasks(filePath: string): Promise<TasksFile> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TasksFile>;
    if (Array.isArray(parsed.tasks)) return { tasks: parsed.tasks };
  } catch {
    /* missing or corrupt — fall through to empty */
  }
  return { tasks: [] };
}

export async function saveTasks(
  filePath: string,
  data: TasksFile,
): Promise<void> {
  // atomicWriteAsync mkdir's parent dirs recursively, so ~/.devspace need not exist.
  await atomicWriteAsync(filePath, JSON.stringify(data, null, 2));
}
