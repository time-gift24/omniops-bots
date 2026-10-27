import { readFile, lstat, realpath, mkdir, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { fail } from './protocol.mjs';
const own = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw fail(400,'invalid-config'); };
const absolute = value => { if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw fail(400,'invalid-config'); return resolve(value); };
const origin = (value, protocol) => { const u = new URL(value); if (u.protocol !== protocol || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw fail(400,'invalid-config'); return u.origin; };
const port = value => { if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw fail(400,'invalid-config'); };
const id = value => { if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value)) throw fail(400,'invalid-config'); };
export async function readConfig(file, kind) {
  absolute(file);
  const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024*1024) throw fail(400,'invalid-config');
  const c = JSON.parse(await readFile(file,'utf8'));
  if (c.schemaVersion !== 1) throw fail(400,'invalid-config');
  if (kind === 'server') {
    own(c,['schemaVersion','listen','publicOrigin','tls','dataRoot','fixtureRoot','identities','control']);
    own(c.listen,['host','port']); own(c.tls,['certFile','keyFile']); own(c.control,['host','port','secretFile']);
    if (typeof c.listen.host !== 'string' || !['127.0.0.1','::1'].includes(c.control.host)) throw fail(400,'invalid-config');
    port(c.listen.port); port(c.control.port); origin(c.publicOrigin,'https:');
    for (const p of [c.dataRoot,c.fixtureRoot,c.tls.certFile,c.tls.keyFile,c.control.secretFile]) absolute(p);
    if (!Array.isArray(c.identities) || !c.identities.length || c.identities.length>16) throw fail(400,'invalid-config');
    for (const identity of c.identities) {
      own(identity,['tokenFile','principal','permissions','expiresAt']); own(identity.principal,['organizationId','callerId','installationId']);
      Object.values(identity.principal).forEach(id); absolute(identity.tokenFile);
      if (!Array.isArray(identity.permissions) || identity.permissions.some(p=>!['official-read','official-maintain','task-call','diagnostic-own','diagnostic-read'].includes(p)) || !Number.isFinite(Date.parse(identity.expiresAt))) throw fail(400,'invalid-config');
    }
  } else {
    own(c,['schemaVersion','target','peer','fixtureManifest','fixtureTokenFile','trustedCaFile','runtime','isolatedRoot','reportRoot','installation']);
    if (!['darwin-aarch64','windows-x86_64'].includes(c.target)) throw fail(400,'invalid-config');
    own(c.runtime,['nodeExecutable','directory']); absolute(c.runtime.nodeExecutable); absolute(c.runtime.directory);
    for (const p of [c.fixtureManifest,c.fixtureTokenFile,c.isolatedRoot,c.reportRoot]) absolute(p);
    if (c.trustedCaFile) absolute(c.trustedCaFile);
    if (c.peer?.mode === 'managed') { own(c.peer,['mode','configFile']); absolute(c.peer.configFile); }
    else if(c.peer?.mode === 'external') { own(c.peer,['mode','publicOrigin','controlOrigin','controlSecretFile']); origin(c.peer.publicOrigin,'https:'); const u=new URL(c.peer.controlOrigin); if(u.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(u.hostname) || u.username || u.password || u.pathname!=='/' || u.search || u.hash)throw fail(400,'invalid-config');absolute(c.peer.controlSecretFile); }
    else throw fail(400,'invalid-config');
    if (c.installation) {
      own(c.installation,['version','executable','packageFile','packageSha256','previousVersion','previousPackageFile','sourceCommit','sourceTreeSha256']);
      for (const p of [c.installation.executable,c.installation.packageFile,c.installation.previousPackageFile]) absolute(p);
      for(const k of ['packageSha256','sourceTreeSha256'])if(!/^[a-f0-9]{64}$/u.test(c.installation[k]))throw fail(400,'invalid-config');
    }
    if (resolve(c.reportRoot)===resolve(c.isolatedRoot) || !relative(c.isolatedRoot,c.reportRoot).startsWith('..')) throw fail(400,'invalid-config');
  }
  return c;
}
export async function isolatedRoot(directory) {
  absolute(directory);
  for(const bad of [homedir(),resolve(homedir(),'.omnimind-ops'),resolve(homedir(),'Library/Application Support/omniops-bots')])if(resolve(directory)===bad)throw fail(400,'unsafe-data-root');
  await mkdir(directory,{recursive:true,mode:0o700});
  const info=await lstat(directory);if(info.isSymbolicLink() || !info.isDirectory() || await realpath(directory)!==resolve(directory))throw fail(400,'unsafe-data-root');
  const entries=await readdir(directory);
  const marker=resolve(directory,'.omniops-verification');
  if(entries.length && !entries.includes('.omniops-verification'))throw fail(400,'unsafe-data-root');
  if(entries.includes('.omniops-verification') && (await readFile(marker,'utf8'))!=='verification-v1\n')throw fail(400,'unsafe-data-root');
  await writeFile(marker,'verification-v1\n',{mode:0o600});
  return directory;
}
