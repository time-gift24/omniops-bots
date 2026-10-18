import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (process.env.COGNACTA_RUNTIME_PREPARED !== '1') {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE;
  execFileSync(process.execPath, ['desktop/scripts/prepare.mjs', ...(target ? ['--target', target] : [])], { cwd: root, stdio: 'inherit' });
}
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'web', 'run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
