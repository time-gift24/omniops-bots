import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = join(root, 'desktop');
const hostCrate = join(root, 'crates/omniops-bots-desktop');
const macTarget = 'aarch64-apple-darwin';
const windowsTarget = 'x86_64-pc-windows-msvc';

export function preparationPlan(host, target = host) {
  if (![macTarget, windowsTarget].includes(host) ||
      ![host, ...(host === macTarget ? [windowsTarget] : [])].includes(target)) {
    throw new Error(`Unsupported preparation target: ${host} -> ${target}. Supported: native macOS arm64, native Windows x64, macOS arm64 -> Windows x64.`);
  }
  return { target, windows: target === windowsTarget, cross: target !== host };
}

export function verifyNodeArchive(bytes, checksums, filename) {
  const expected = checksums.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i))
    .find(match => match?.[2] === filename)?.[1].toLowerCase();
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!expected || actual !== expected) throw new Error(`Node archive SHA-256 verification failed: ${filename}`);
  return actual;
}

export async function runtimeSourceFiles(directory) {
  const files = [];
  async function visit(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || /^(?:node_modules|tests?|__tests__|fixtures?|state|credentials|coverage|dist|build)$/.test(entry.name) || entry.isSymbolicLink()) continue;
      const file = join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(?:mjs|ts)$/.test(entry.name)
        && !/(?:^|\.)(?:test|spec)\.(?:mjs|ts)$/.test(entry.name)
        && !/\.browser\.(?:mjs|ts)$/.test(entry.name)
        && entry.name !== 'dev-runtime-bridge.mjs') files.push(file);
    }
  }
  await visit();
  return files.sort();
}

export async function stageRuntimeSources(source, destination) {
  for (const file of [...await runtimeSourceFiles(source), 'package.json', 'package-lock.json']) {
    if (!(await lstat(join(source, file))).isFile()) throw new Error(`Runtime source must be a regular file: ${file}`);
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await cp(join(source, file), join(destination, file));
  }
}

export function verifySqliteAddon(bytes, target) {
  if (target === macTarget) {
    if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) throw new Error('SQLite addon must be Mach-O arm64');
    return 'arm64';
  }
  if (target === windowsTarget) {
    if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('SQLite addon must be PE x64');
    const offset = bytes.readUInt32LE(60);
    if (bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('SQLite addon must be PE x64');
    return 'x64';
  }
  throw new Error(`Unsupported SQLite addon target: ${target}`);
}

export async function prepareSqliteAddon(staged, plan, executable, pinned) {
  const require = createRequire(join(staged, 'package.json'));
  const packagePath = require.resolve('better-sqlite3/package.json');
  const packageDirectory = dirname(packagePath);
  const platform = plan.windows ? 'win32' : 'darwin';
  const arch = plan.windows ? 'x64' : 'arm64';
  // Dependency lifecycle scripts stay disabled; only this pinned installer's download is run.
  execFileSync(process.execPath, [require.resolve('prebuild-install/bin.js'), '--runtime=node', `--target=${pinned}`, `--platform=${platform}`, `--arch=${arch}`], { cwd: packageDirectory, stdio: 'inherit' });
  const addon = join(packageDirectory, 'build/Release/better_sqlite3.node');
  const bytes = await readFile(addon);
  verifySqliteAddon(bytes, plan.target);
  execFileSync(process.execPath, ['--input-type=module', '--eval', "await import('./runtime.mjs'); await import('./browser/browser.mjs'); await import('./browser/script-workspace.mjs');"], { cwd: staged, stdio: 'inherit' });
  let loadValidation = 'not_run: requires Windows x64 host';
  if (!plan.cross) {
    execFileSync(executable, ['--input-type=module', '--eval', `
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import assert from 'node:assert/strict';
      import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
      import { openSqliteCheckpointer } from './execution/sqlite.ts';
      const directory = await mkdtemp(join(tmpdir(), 'omniops-sqlite-package-'));
      try {
        const path = join(directory, 'checkpoints.sqlite');
        const config = { configurable: { thread_id: 'package-probe', checkpoint_ns: '' } };
        const store = await openSqliteCheckpointer(path);
        await store.checkpointer.put(config, emptyCheckpoint(), { source: 'input', step: -1, parents: {} }, {});
        await store.close();
        const reopened = await openSqliteCheckpointer(path);
        try { assert.ok(await reopened.checkpointer.getTuple(config)); }
        finally { await reopened.close(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    `], { cwd: staged, stdio: 'inherit' });
    loadValidation = 'passed';
  }
  return { package: JSON.parse(await readFile(packagePath, 'utf8')).version, nodeABI: process.versions.modules,
    platform, arch, sha256: createHash('sha256').update(bytes).digest('hex'), runtimeImportValidation: 'passed', loadValidation, persistentReopenValidation: loadValidation };
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function windowsNode(pinned) {
  const filename = `node-v${pinned}-win-x64.zip`;
  const base = `https://nodejs.org/dist/v${pinned}/`;
  const cache = join(desktop, '.scratch/windows-cache');
  await mkdir(cache, { recursive: true });
  const archive = join(cache, filename);
  const checksums = (await download(`${base}SHASUMS256.txt`)).toString('utf8');
  let bytes;
  try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes) {
    verifyNodeArchive(bytes, checksums, filename);
  } else {
    bytes = await download(`${base}${filename}`);
    verifyNodeArchive(bytes, checksums, filename);
    await writeFile(archive, bytes);
  }
  const extracted = join(cache, `node-v${pinned}-win-x64`);
  await rm(extracted, { recursive: true, force: true });
  if (process.platform === 'win32') {
    execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe'), ['-xf', archive, '-C', cache]);
  } else {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archive, cache]);
  }
  return { executable: join(extracted, 'node.exe'), license: await readFile(join(extracted, 'LICENSE'), 'utf8') };
}

async function main() {
  process.chdir(root);
  const args = process.argv.slice(2);
  if (args[0] === '--embedded') args.shift();
  if (args.length && (args.length !== 2 || args[0] !== '--target')) throw new Error('Usage: node desktop/scripts/prepare.mjs [--embedded] [--target x86_64-pc-windows-msvc]');
  const host = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
  const plan = preparationPlan(host, args[1]);
  const pinned = '26.11.1';
  if (process.versions.node !== pinned) throw new Error(`Use Node ${pinned} (current: ${process.versions.node}) before preparing the private runtime.`);
  let executable = process.execPath;
  let nodeLicense;
  if (plan.cross) {
    ({ executable, license: nodeLicense } = await windowsNode(pinned));
  } else {
    const licensePath = plan.windows ? join(dirname(process.execPath), 'LICENSE') : join(dirname(dirname(process.execPath)), 'LICENSE');
    try { nodeLicense = await readFile(licensePath, 'utf8'); } catch (error) {
      if (!plan.windows || error.code !== 'ENOENT') throw error;
      ({ license: nodeLicense } = await windowsNode(pinned));
    }
  }

  const resources = join(hostCrate, 'resources');
  const binaries = join(hostCrate, 'binaries');
  await mkdir(binaries, { recursive: true });
  await mkdir(resources, { recursive: true });
  const sidecar = join(binaries, `omniops-bots-node-${plan.target}${plan.windows ? '.exe' : ''}`);
  await cp(executable, sidecar);

  const staged = join(resources, 'runtime');
  await rm(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });
  await stageRuntimeSources(join(desktop, 'runtime'), staged);
  const installArgs = ['ci', '--omit=dev', '--prefix', staged, '--ignore-scripts'];
  if (process.platform === 'win32') {
    const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    execFileSync(process.execPath, [npmCli, ...installArgs], { stdio: 'inherit' });
  } else {
    execFileSync('npm', installArgs, { stdio: 'inherit' });
  }
  const sqlite = await prepareSqliteAddon(staged, plan, executable, pinned);
  const playwrightLicense = await readFile(join(staged, 'node_modules/playwright-core/LICENSE'), 'utf8');
  const sqliteLicense = await readFile(join(staged, 'node_modules/better-sqlite3/LICENSE'), 'utf8');
  const saverLicense = await readFile(join(staged, 'node_modules/@langchain/langgraph-checkpoint-sqlite/LICENSE'), 'utf8');
  await writeFile(join(resources, 'THIRD_PARTY_NOTICES.txt'), `Bundled Node.js ${pinned}\n\n${nodeLicense}\n\nPlaywright\n\n${playwrightLicense}\n\nbetter-sqlite3\n\n${sqliteLicense}\n\nLangGraph SQLite checkpoint saver\n\n${saverLicense}\n\n${plan.windows ? 'CEF-LICENSE.txt and CEF-CREDITS.html accompany the native CEF DLLs beside the application executable.' : 'CEF and Chromium licenses accompany the framework in Contents/Frameworks/.'}\n`);
  const manifest = {
    node: pinned,
    nodeSha256: createHash('sha256').update(await readFile(sidecar)).digest('hex'),
    playwright: JSON.parse(await readFile(join(staged, 'node_modules/playwright-core/package.json'), 'utf8')).version,
    deepagents: JSON.parse(await readFile('desktop/runtime/package.json', 'utf8')).dependencies.deepagents,
    sqlite,
    browserMode: 'embedded',
    chromium: { cef: '154.0.34', version: '154.0.8037.98' },
    target: plan.target,
  };
  await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Prepared private Node ${pinned}, Playwright ${manifest.playwright}, native CEF for ${plan.target}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
