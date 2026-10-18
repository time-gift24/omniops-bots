import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
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
  // Explicit production files keep tests, local model configuration, and checkpoint data out of both platform bundles.
  for (const file of ['main.mjs', 'runtime.mjs', 'agent.mjs', 'browser.mjs', 'browser-target.mjs', 'input.mjs', 'chat-events.mjs', 'errors.mjs', 'script-workspace.mjs', 'script-runner.mjs', 'resources.mjs', 'package.json', 'package-lock.json']) {
    await cp(join(desktop, 'runtime', file), join(staged, file), { recursive: true, dereference: true });
  }
  const installArgs = ['ci', '--omit=dev', '--prefix', staged, '--ignore-scripts'];
  if (process.platform === 'win32') {
    const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    execFileSync(process.execPath, [npmCli, ...installArgs], { stdio: 'inherit' });
  } else {
    execFileSync('npm', installArgs, { stdio: 'inherit' });
  }
  const playwrightLicense = await readFile(join(staged, 'node_modules/playwright-core/LICENSE'), 'utf8');
  await writeFile(join(resources, 'THIRD_PARTY_NOTICES.txt'), `Bundled Node.js ${pinned}\n\n${nodeLicense}\n\nPlaywright\n\n${playwrightLicense}\n\n${plan.windows ? 'CEF-LICENSE.txt and CEF-CREDITS.html accompany the native CEF DLLs beside the application executable.' : 'CEF and Chromium licenses accompany the framework in Contents/Frameworks/.'}\n`);
  const manifest = {
    node: pinned,
    nodeSha256: createHash('sha256').update(await readFile(sidecar)).digest('hex'),
    playwright: JSON.parse(await readFile(join(staged, 'node_modules/playwright-core/package.json'), 'utf8')).version,
    deepagents: JSON.parse(await readFile('desktop/runtime/package.json', 'utf8')).dependencies.deepagents,
    browserMode: 'embedded',
    chromium: { cef: '154.0.34', version: '154.0.8037.98' },
    target: plan.target,
  };
  await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Prepared private Node ${pinned}, Playwright ${manifest.playwright}, native CEF for ${plan.target}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
