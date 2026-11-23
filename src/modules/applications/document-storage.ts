import { scanDocument } from '../service-center/scanner.js';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HttpError } from '../../shared/errors.js';

export interface PrivateDocumentStorage {
  put(storageKey: string, bytes: Buffer): Promise<void>;
  get(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

export class LocalPrivateDocumentStorage implements PrivateDocumentStorage {
  private readonly root = resolve(process.env.APPLICATION_STORAGE_DIR || '.runtime/application-files');
  private path(storageKey: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(storageKey)) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
    const path = join(this.root, storageKey);
    if (!path.startsWith(this.root + (process.platform === 'win32' ? '\\' : '/'))) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
    return path;
  }
  async put(storageKey: string, bytes: Buffer): Promise<void> {
    await scanDocument(bytes);
    await mkdir(this.root, { recursive: true });
    await writeFile(this.path(storageKey), bytes, { flag: 'wx', mode: 0o600 });
  }
  async get(storageKey: string): Promise<Buffer> {
    try { const bytes=await readFile(this.path(storageKey)); await scanDocument(bytes); return bytes; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new HttpError(404, 'DOCUMENT_MISSING', 'The stored file is unavailable. Upload the document again.');
      throw error;
    }
  }
  async remove(storageKey: string): Promise<void> { await unlink(this.path(storageKey)).catch(() => undefined); }
}
