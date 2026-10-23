import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';

export const storageId = (value: string) => createHash('sha256').update(value).digest('hex');

export async function writeJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
