import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hostCrate = join(root, 'crates/cognacta-desktop');
const target = 'x86_64-pc-windows-msvc';
const targetDir = join(root, 'desktop/.scratch/native-windows-target');
const release = join(targetDir, target, 'release');
const resources = join(root, 'crates/cognacta-desktop/resources');
const cefVersion = '154.0.34+g14c5a08+chromium-154.0.8037.98';
const archiveName = `cef_binary_${cefVersion}_windows64_minimal.tar.bz2`;
const archiveSHA1 = 'be54bbaf3222191dec59ffd9c9ec7e8a7f44a26d';
const archiveURL = `https://cef-builds.spotifycdn.com/${archiveName}`;
const cache = join(root, 'desktop/.scratch/windows-cache/cef');
const cefPath = join(cache, '154.0.34/cef_windows_x86_64');
const configPath = join(root, 'crates/cognacta-desktop/tauri.windows.conf.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const installerPath = join(release, 'bundle/nsis', `cognacta-desktop_${config.version}_native_x64-setup.exe`);
const env = { ...process.env, CEF_PATH: cefPath, CARGO_TARGET_DIR: targetDir, TAURI_FRONTEND_PATH: join(root, 'web') };
env.NODE_USE_ENV_PROXY ||= '1';
env.XWIN_ARCH ||= 'x86_64';
env.XWIN_CACHE_DIR ||= join(root, 'desktop/.scratch/windows-cache/xwin');

async function digest(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function coffMachine(header) {
  assert.equal(header.readUInt32LE(0), 0x00004550, 'Invalid PE signature');
  return header.readUInt16LE(4);
}

async function peMachine(path) {
  const file = await open(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    assert.equal((await file.read(dos, 0, dos.length, 0)).bytesRead, dos.length, 'Truncated DOS header');
    assert.equal(dos.readUInt16LE(0), 0x5a4d, `Invalid DOS signature: ${path}`);
    const coff = Buffer.alloc(6);
    assert.equal((await file.read(coff, 0, coff.length, dos.readUInt32LE(60))).bytesRead, coff.length, 'Truncated PE header');
    return `0x${coffMachine(coff).toString(16).padStart(4, '0')}`;
  } finally { await file.close(); }
}

async function prepareCEF() {
  await mkdir(cache, { recursive: true });
  const curl = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32/curl.exe') : '/usr/bin/curl';
  const upstreamSHA1 = execFileSync(curl, ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '60', `${archiveURL}.sha1`], { encoding: 'utf8', env }).trim().split(/\s/)[0];
  assert.equal(upstreamSHA1, archiveSHA1, 'The upstream CEF checksum changed; review the pinned SDK before rebuilding');
  const archive = join(cache, archiveName);
  const partial = `${archive}.part`;
  if (!existsSync(archive)) {
    if (!existsSync(partial) || await digest(partial, 'sha1') !== archiveSHA1) {
      execFileSync(curl, ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '600', archiveURL, '--output', partial], { stdio: 'inherit', env });
    }
    assert.equal(await digest(partial, 'sha1'), archiveSHA1, 'CEF archive SHA-1 verification failed');
    await rename(partial, archive);
  }
  assert.equal(await digest(archive, 'sha1'), archiveSHA1, 'Cached CEF archive SHA-1 verification failed');

  let cached;
  try { cached = JSON.parse(await readFile(join(cefPath, 'archive.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const sdkFiles = ['bootstrap.exe', 'libcef.dll', 'libcef.lib', 'CMakeLists.txt', 'cmake/cef_variables.cmake', 'include/cef_api_versions.h', 'libcef_dll/wrapper', 'LICENSE.txt', 'CREDITS.html', 'locales/en-US.pak'];
  const reuseSDK = cached?.name === archiveName && cached.sha1 === archiveSHA1 && sdkFiles.every(name => existsSync(join(cefPath, name)));
  if (!reuseSDK) {
    const extracted = join(cache, archiveName.replace(/\.tar\.bz2$/, ''));
    await rm(extracted, { recursive: true, force: true });
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe') : '/usr/bin/tar';
    execFileSync(tar, ['-xjf', archive, '-C', cache], { stdio: 'inherit', env });
    await rm(cefPath, { recursive: true, force: true });
    await mkdir(cefPath, { recursive: true });
    for (const dir of ['Release', 'Resources']) {
      for (const name of await readdir(join(extracted, dir))) {
        await cp(join(extracted, dir, name), join(cefPath, name), { recursive: true });
      }
    }
    for (const name of ['CMakeLists.txt', 'cmake', 'include', 'libcef_dll', 'LICENSE.txt', 'CREDITS.html', 'README.txt']) {
      await cp(join(extracted, name), join(cefPath, name), { recursive: true });
    }
    await writeFile(join(cefPath, 'archive.json'), JSON.stringify({ type: 'minimal', name: archiveName, sha1: archiveSHA1 }, null, 2) + '\n');
    await rm(extracted, { recursive: true, force: true });
  } else {
    console.log('Reusing the verified CEF SDK without touching its C++ source timestamps.');
  }
  for (const name of ['bootstrap.exe', 'libcef.dll', 'chrome_elf.dll']) assert.equal(await peMachine(join(cefPath, name)), '0x8664', `CEF ${name} must be x64`);

  const stagedCEF = join(resources, 'cef');
  await rm(stagedCEF, { recursive: true, force: true });
  await mkdir(stagedCEF, { recursive: true });
  for (const name of await readdir(cefPath)) {
    if (/\.(dll|bin|pak|dat|json)$/.test(name) && name !== 'archive.json') await cp(join(cefPath, name), join(stagedCEF, name));
  }
  await cp(join(cefPath, 'locales'), join(stagedCEF, 'locales'), { recursive: true });
  await cp(join(cefPath, 'LICENSE.txt'), join(stagedCEF, 'CEF-LICENSE.txt'));
  await cp(join(cefPath, 'CREDITS.html'), join(stagedCEF, 'CEF-CREDITS.html'));
  const manifestPath = join(resources, 'runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.chromium = { cef: '154.0.34', version: '154.0.8037.98', archiveURL, archiveSHA1, archiveSHA256: await digest(archive) };
  manifest.sandbox = { enabled: true, launcher: 'CEF bootstrap.exe', applicationDLL: 'cognacta-desktop.dll', sameExecutableForSubprocesses: true, windowsTokenValidation: 'not_run: requires Windows host or VM' };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Verified and staged CEF ${cefVersion} with its sandbox bootstrap, DLLs, resources and locales.`);
}

function configureTools() {
  if (process.platform === 'darwin') {
    const prefixes = ['llvm', 'lld', 'nsis', 'cmake', 'ninja'].map(formula => execFileSync('brew', ['--prefix', formula], { encoding: 'utf8' }).trim());
    const privateTools = join(root, 'desktop/.scratch/windows-tools/bin');
    env.PATH = [...prefixes.map(prefix => join(prefix, 'bin')), ...(existsSync(privateTools) ? [privateTools] : []), env.PATH].join(delimiter);
  }
}

async function verifyPackage() {
  const executable = join(release, 'cognacta-desktop.exe');
  const applicationDLL = join(resources, 'cef/cognacta-desktop.dll');
  const node = join(root, 'crates/cognacta-desktop/binaries', `cognacta-node-${target}.exe`);
  const manifest = JSON.parse(await readFile(join(resources, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.browserMode, 'embedded');
  assert.equal(manifest.target, target);
  assert.equal(manifest.nodeSha256, await digest(node));
  assert.equal(await digest(executable), await digest(join(cefPath, 'bootstrap.exe')), 'The launch EXE must remain the unmodified sandbox bootstrap');
  const applicationExports = execFileSync('llvm-readobj', ['--coff-exports', applicationDLL], { encoding: 'utf8', env });
  assert.match(applicationExports, /Name: RunWinMain\s/);
  for (const path of [executable, applicationDLL]) {
    const headers = execFileSync('llvm-readobj', ['--file-headers', path], { encoding: 'utf8', env });
    assert.match(headers, /CertificateTableSize: 0x0\s/, 'The bootstrap and client must both be unsigned, or code-signed by the same signer');
  }
  const coffImports = execFileSync('llvm-readobj', ['--coff-imports', applicationDLL], { encoding: 'utf8', env });
  const imports = [...coffImports.matchAll(/(DelayImport|Import) \{\s+Name: (.+)/g)].map(match => ({ type: match[1], name: match[2].trim() }));
  assert.ok(imports.length, 'The application DLL import table is missing');
  const ordinaryImports = imports.filter(entry => entry.type === 'Import').map(entry => entry.name);
  const delayedImports = imports.filter(entry => entry.type === 'DelayImport').map(entry => entry.name);
  const cefLinkerFlags = await readFile(join(cefPath, 'cmake/cef_variables.cmake'), 'utf8');
  const requiresDelay = new Set([...cefLinkerFlags.matchAll(/\/DELAYLOAD:([^\s]+)/g)].map(match => match[1].toLowerCase()));
  for (const name of ['combase.dll', 'shcore.dll', 'runtimeobject.dll']) requiresDelay.add(name);
  assert.ok(delayedImports.some(name => name.toLowerCase() === 'libcef.dll'), 'The sandbox client must delay-load libcef.dll');
  assert.deepEqual(ordinaryImports.filter(name => requiresDelay.has(name.toLowerCase())), [], 'CEF or UI libraries loaded before entering the renderer sandbox');
  const runtimeImports = imports.filter(entry => /^(?:vcruntime|msvcp|msvcr\d|concrt|vcomp).*\.dll$/i.test(entry.name)).map(entry => entry.name);
  const stagedDLLs = new Set((await readdir(join(resources, 'cef'))).map(name => name.toLowerCase()));
  const missingRedistributableRuntimeDLLs = [...new Set(runtimeImports)].filter(name => !stagedDLLs.has(name.toLowerCase()));
  assert.deepEqual(missingRedistributableRuntimeDLLs, [], 'Bundle the non-system Visual C++ runtime DLLs required by the application');
  const machines = {};
  for (const [name, path] of Object.entries({ launcher: executable, applicationDLL, node, cef: join(resources, 'cef/libcef.dll') })) {
    machines[name] = await peMachine(path);
    assert.equal(machines[name], '0x8664', `${name} must be x64`);
  }
  for (const name of await readdir(join(resources, 'cef'))) {
    if (name.endsWith('.dll')) assert.equal(await peMachine(join(resources, 'cef', name)), '0x8664', `${name} must be x64`);
  }
  const nsis = await readFile(join(release, 'nsis/x64/installer.nsi'), 'utf8');
  const bundledFiles = [...nsis.matchAll(/File \/a "\/oname=([^"]+)" "([^"]+)"/g)].map(match => ({ target: match[1], source: match[2] }));
  assert.ok(bundledFiles.length > 1_000, 'NSIS resource file manifest is missing');
  for (const name of ['libcef.dll', 'cognacta-desktop.dll', 'icudtl.dat', 'CEF-LICENSE.txt', 'CEF-CREDITS.html']) assert.ok(bundledFiles.some(file => file.target === name), `NSIS must put ${name} beside the launch EXE`);
  assert.ok(bundledFiles.some(file => file.target === 'locales\\en-US.pak'));
  assert.ok(bundledFiles.some(file => file.target === 'runtime\\main.mjs'));
  assert.ok(bundledFiles.every(file => !/^browsers[\\/]/.test(file.target) && !/\.framework[\\/]|resources[\\/]windows[\\/]/.test(file.source)), 'Native installer contains an external Chromium or macOS payload');
  assert.ok(bundledFiles.every(file => !/(^|[\\/])(model\.env|[^\\/]*\.sqlite(?:-wal|-shm)?|dev-runtime-bridge\.mjs|test\.mjs)$/.test(file.target)), 'Native installer contains a local credential, database or development bridge');
  assert.match(nsis, /!define INSTALLWEBVIEW2MODE "offlineInstaller"/);
  assert.match(nsis, /MicrosoftEdgeWebView2RuntimeInstallerX64\.exe/);
  const runtimeSourceMatchesStagedFiles = (await Promise.all((await readdir(join(resources, 'runtime'))).filter(name => name.endsWith('.mjs')).map(async name => await digest(join(root, 'desktop/runtime', name)) === await digest(join(resources, 'runtime', name))))).every(Boolean);
  assert.ok(runtimeSourceMatchesStagedFiles, 'Re-prepare changed runtime source before packaging');
  const summary = {
    version: config.version, target, browserMode: 'embedded', builtOn: process.platform === 'win32' ? 'Windows x64' : 'macOS arm64 (cross compiled)',
    installer: installerPath, installerBytes: (await stat(installerPath)).size, installerSha256: await digest(installerPath), installerMachine: await peMachine(installerPath),
    componentMachines: machines, nodeSha256MatchesManifest: true, runtimeSourceMatchesStagedFiles,
    cef: manifest.chromium, sandbox: { ...manifest.sandbox, windowsTokenValidation: 'not_run: requires Windows host or VM' }, launchExecutableMatchesUpstreamBootstrap: true, exportsRunWinMain: true,
    compatibleUnsignedBootstrapClientPair: true,
    ordinaryImports, delayedImports, cefAndUILibrariesDelayLoaded: true, missingRedistributableRuntimeDLLs,
    resourceSourceFiles: bundledFiles.length, cefResourcesBesideExecutable: true, localesSubdirectory: true,
    containsNoDuplicateExternalChromium: true, containsNoMacPayload: true, containsNoLocalModelConfigurationOrUserDatabases: true,
    offlineWebView2Installer: true, signed: false, windowsRuntimeValidation: 'not_run: requires Windows host or VM',
  };
  await mkdir(join(root, 'desktop/.scratch/artifacts'), { recursive: true });
  await writeFile(join(root, 'desktop/.scratch/artifacts/windows-native-package-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && !['--prepare-only', '--verify-only', '--self-check'].includes(mode))) throw new Error('Usage: node scripts/build-native-windows.mjs [--prepare-only|--verify-only|--self-check]');
  if (mode === '--self-check') {
    const header = Buffer.from([0x50, 0x45, 0, 0, 0x64, 0x86]);
    assert.equal(coffMachine(header), 0x8664);
    assert.throws(() => coffMachine(Buffer.alloc(6)), /Invalid PE signature/);
    assert.throws(() => coffMachine(header.subarray(0, 4)), RangeError);
    assert.equal(config.version, '0.1.0');
    assert.equal(config.bundle.resources['resources/browsers/'], undefined);
    assert.equal(config.bundle.resources['resources/cef/'], '');
    assert.equal(config.bundle.windows.webviewInstallMode.type, 'offlineInstaller');
    console.log('Native Windows resource layout, offline WebView2 and PE validation checks passed.');
    return;
  }
  assert.ok((process.platform === 'darwin' && process.arch === 'arm64') || (process.platform === 'win32' && process.arch === 'x64'), 'Native Windows builds require Windows x64 or macOS arm64');
  process.chdir(root);
  configureTools();
  if (mode === '--verify-only') { await verifyPackage(); return; }
  execFileSync(process.execPath, ['desktop/scripts/prepare.mjs', '--embedded', '--target', target], { stdio: 'inherit', env });
  await prepareCEF();
  env.COGNACTA_RUNTIME_PREPARED = '1';
  if (mode === '--prepare-only') return;

  const cli = [join(root, 'web/node_modules/@tauri-apps/cli/tauri.js')];
  const common = ['--target', target, '--features', 'native-browser', '--config', configPath];
  // CEF's sandbox bootstrap loads the application's RunWinMain DLL. Cargo still builds a bin for Tauri metadata.
  execFileSync(process.execPath, [...cli, 'build', ...common, '--no-bundle', ...(process.platform === 'win32' ? [] : ['--runner', 'cargo-xwin']), '--', '--lib', '--bin', 'cognacta-desktop'], { stdio: 'inherit', env, cwd: hostCrate });
  await cp(join(release, 'cognacta_desktop_native.dll'), join(resources, 'cef/cognacta-desktop.dll'));
  await cp(join(release, 'cognacta_desktop_native.dll'), join(release, 'cognacta-desktop.dll'));
  await cp(join(cefPath, 'bootstrap.exe'), join(release, 'cognacta-desktop.exe'));
  execFileSync(process.execPath, [...cli, 'bundle', ...common, '--no-binary-patching'], { stdio: 'inherit', env, cwd: hostCrate });
  const generated = join(release, 'bundle/nsis', `Cognacta_${config.version}_x64-setup.exe`);
  await rename(generated, installerPath);
  await verifyPackage();
}

await main();
