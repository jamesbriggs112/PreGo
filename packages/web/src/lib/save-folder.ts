import { exportFileUrl, type ExportSummary } from '@/lib/api';

// Saving an export where the person chooses. Chromium-based browsers and the desktop app can ask for a
// folder and write into it; other browsers can't, so there the export stays in Prego's data folder and
// the download links save copies.

interface WritableFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  createWritable(): Promise<WritableFile>;
}
export interface FolderHandle {
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FolderHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
}
type Picker = (options?: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<FolderHandle>;

function picker(): Picker | null {
  const pick = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;
  return typeof pick === 'function' ? pick.bind(window) : null;
}

export const canChooseFolder = () => picker() !== null;

/** Ask where to save. Null when the person cancels. Call it straight from the click, before anything else waits. */
export async function chooseFolder(): Promise<FolderHandle | null> {
  const pick = picker();
  if (!pick) return null;
  try {
    return await pick({ id: 'prego-exports', mode: 'readwrite', startIn: 'documents' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/** Copy an export's files into a new folder inside `parent`, named after the export. Returns that folder's name. */
export async function saveExportTo(parent: FolderHandle, summary: ExportSummary): Promise<string> {
  let name = summary.name;
  for (let n = 2; await exists(parent, name); n++) name = `${summary.name}-${n}`;
  const folder = await parent.getDirectoryHandle(name, { create: true });
  for (const file of summary.files) {
    const response = await fetch(exportFileUrl(summary.id, file));
    if (!response.ok) throw new Error(`Couldn’t read ${file} from the export`);
    const writable = await (await folder.getFileHandle(file, { create: true })).createWritable();
    await writable.write(await response.blob());
    await writable.close();
  }
  return `${parent.name}/${name}`;
}

async function exists(parent: FolderHandle, name: string): Promise<boolean> {
  try {
    await parent.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}
