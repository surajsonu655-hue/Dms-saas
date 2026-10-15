import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';

/** Object-storage abstraction. Large files never go into PostgreSQL; only key/type/size are stored in `files`. */
export interface StorageProvider { put(key: string, data: Buffer, mime: string): Promise<void>; get(key: string): Promise<Buffer> }

class LocalStorage implements StorageProvider {
  private p(key: string) {
    const full = path.resolve(config.storage.dir, key);
    if (!full.startsWith(path.resolve(config.storage.dir) + path.sep)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid storage key');
    return full;
  }
  async put(key: string, data: Buffer) { const f = this.p(key); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, data); }
  async get(key: string) { return fs.readFile(this.p(key)); }
}
/** Placeholder so STORAGE_PROVIDER=s3 fails loudly instead of silently writing locally. Implement put/get with your SDK of choice. */
class UnconfiguredStorage implements StorageProvider {
  async put(): Promise<void> { throw new AppError(501, 'STORAGE_NOT_CONFIGURED', `Storage provider "${config.storage.provider}" is not implemented in this build`); }
  async get(): Promise<Buffer> { return this.put() as any; }
}
let provider: StorageProvider | null = null;
export const storage = () => provider ??= config.storage.provider === 'local' ? new LocalStorage() : new UnconfiguredStorage();
export const setStorage = (p: StorageProvider) => { provider = p; };

const SIGS: [string, number[]][] = [['image/jpeg', [0xff, 0xd8, 0xff]], ['image/png', [0x89, 0x50, 0x4e, 0x47]], ['application/pdf', [0x25, 0x50, 0x44, 0x46]]];
export function sniffMime(buf: Buffer): string | null {
  for (const [m, sig] of SIGS) if (sig.every((b, i) => buf[i] === b)) return m;
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
export const FILE_KINDS = ['photo', 'signature', 'payment_proof', 'return_photo', 'document', 'logo'];
export const newKey = (businessId: string, ext: string) => `${businessId}/${crypto.randomUUID()}${ext}`;
