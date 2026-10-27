import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, isolatedRoot } from './config.mjs';
import { initialize } from './init.mjs';
import { mergeReports } from './verify.mjs';
import { resolveCefEnvironment } from './checks.mjs';

test('CEF discovery honors explicit SDK selection and reports missing local SDK without downloading',async t=>{
 const root=await mkdtemp(join(tmpdir(),'omniops-cef-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'Cargo.lock'),'[[package]]\nname = "cef-dll-sys"\nversion = "154.5.0+154.0.34"\n');
 const sdk=join(root,'Library/Caches/tauri-cef/154.0.34/cef_macos_aarch64');await mkdir(join(sdk,'include'),{recursive:true});await writeFile(join(sdk,'include/cef_api_versions.h'),'fixture');await writeFile(join(sdk,'CMakeLists.txt'),'fixture');await writeFile(join(sdk,'archive.json'),JSON.stringify({name:'cef_binary_154.0.34+fixture_macosarm64_minimal.tar.bz2',sha1:'0'.repeat(40)}));
 const options={platform:'darwin',arch:'arm64',home:root,workspace:root};
 assert.deepEqual(await resolveCefEnvironment({...options,environment:{}}),{environment:{CEF_PATH:sdk},source:'cache'});
 assert.deepEqual(await resolveCefEnvironment({...options,environment:{CEF_PATH:sdk}}),{environment:{CEF_PATH:sdk},source:'environment'});
 assert.equal(await resolveCefEnvironment({...options,environment:{CEF_PATH:join(root,'missing')}}),null);
 await rm(sdk,{recursive:true});assert.equal(await resolveCefEnvironment({...options,environment:{}}),null);
});

test('configuration rejects unknown fields, unsafe roots and non-loopback controller',{timeout:5000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'omniops-config-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const paths=await initialize(root),config=JSON.parse(await readFile(paths.verifyFile,'utf8'));
 const file=join(root,'bad.json');await writeFile(file,JSON.stringify({...config,unknown:true}));await assert.rejects(readConfig(file,'verify'));
 await writeFile(file,JSON.stringify({...config,peer:{mode:'external',publicOrigin:'https://fixture.example.invalid',controlOrigin:'http://192.0.2.1:1234',controlSecretFile:join(root,'secret')}}));await assert.rejects(readConfig(file,'verify'));
 await assert.rejects(isolatedRoot(root),/Verification request/);
 assert.equal((await readConfig(paths.verifyFile,'verify')).schemaVersion,1);
});

test('merge refuses partial, mismatched and contract-only evidence',{timeout:5000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'omniops-merge-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const a=join(root,'mac.json'),b=join(root,'windows.json');
 const report={schemaVersion:1,profile:'contract',target:'darwin-aarch64',result:'scoped-contract-pass',cases:[{id:'WS-01',status:'passed'}],fixtureManifestSha256:'0'.repeat(64)};await writeFile(a,JSON.stringify(report));await writeFile(b,JSON.stringify({...report,target:'windows-x86_64'}));
 const result=await mergeReports([a,b],join(root,'summary'));assert.equal(result.result,'not-run');assert.equal(result.exitCode,2);await assert.rejects(mergeReports([a],join(root,'missing')));
});

test('merge requires verified package and actual matching source identities, even when every scenario says passed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'omniops-candidate-merge-'));t.after(()=>rm(root,{recursive:true,force:true}));const files=[join(root,'mac.json'),join(root,'windows.json')];
 const ids=['RES-01','RES-02','RES-03','REL-01','REL-02','SYNC-01','ASM-01','ASM-02','MCP-01','PRV-01','PRV-02','PRV-03','FP-01','FP-02',...Array.from({length:12},(_,i)=>`WS-${String(i+1).padStart(2,'0')}`),...Array.from({length:4},(_,i)=>`EXT-0${i+1}`),...Array.from({length:3},(_,i)=>`UI-0${i+1}`),...Array.from({length:3},(_,i)=>`UPD-0${i+1}`),...Array.from({length:4},(_,i)=>`DIA-0${i+1}`),...Array.from({length:3},(_,i)=>`NATIVE-0${i+1}`),'PKG-01','PKG-02'];
 const source={commit:'1'.repeat(40),dirtySha256:'2'.repeat(64)},candidate={version:'1.0.0',sourceCommit:source.commit,sourceTreeSha256:source.dirtySha256,packageSha256:'3'.repeat(64)};
 const evidence={status:'passed',packageSha256:candidate.packageSha256};
 const report={schemaVersion:1,profile:'full',result:'passed',source,candidate,candidateEvidence:evidence,cases:ids.map(id=>({id,status:'passed'})),fixtureManifestSha256:'4'.repeat(64)};
 const run=async modify=>{await writeFile(files[0],JSON.stringify({...report,target:'darwin-aarch64',runtime:{version:'v26.11.1',platform:'darwin',arch:'arm64'}}));await writeFile(files[1],JSON.stringify({...report,target:'windows-x86_64',runtime:{version:'v26.11.1',platform:'win32',arch:'x64'},...modify}));return mergeReports(files,join(root,'summary'));};
 assert.equal((await run({})).result,'passed');
 assert.equal((await run({candidateEvidence:undefined})).exitCode,2);
 assert.equal((await run({source:{...source,dirtySha256:'5'.repeat(64)}})).exitCode,2);
 assert.equal((await run({candidateEvidence:{...evidence,packageSha256:'6'.repeat(64)}})).exitCode,2);
 assert.equal((await run({runtime:{version:'v26.11.1',platform:'darwin',arch:'arm64'}})).exitCode,2);
});
