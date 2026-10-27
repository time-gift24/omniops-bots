import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yazl from 'yazl';
import { packageContentId, readPackageZip, writePackageZip, packagePath } from '../package.ts';
import { createPlatformClient } from '../platform.ts';
import { createResources } from '../resources.ts';
import { createRunFingerprint } from '../fingerprint.ts';
import { RuntimeError } from '../errors.ts';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(action){
  const root=await mkdtemp(path.join(tmpdir(),'omniops-platform-'));
  const writable=async file=>{const info=await lstat(file);if(info.isDirectory()&&!info.isSymbolicLink()){await chmod(file,0o700);for(const child of await readdir(file))await writable(path.join(file,child));}};
  try{return await action(root);}finally{await writable(root);await rm(root,{recursive:true,force:true});}
}
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const session={schemaVersion:1,organizationId:'org',callerId:'caller',installationId:'install',expiresAt:'2099-01-01T00:00:00Z',permissions:['official-read','task-call']};
const client=()=>createPlatformClient({baseUrl:'https://fixture.test',allowedDownloadOrigins:['https://fixture.test'],getAuthorization:async()=> 'Bearer fake-fixture-token'});

test('package golden identity preserves bytes, folders and UTF-16 ordering; ZIP rejects links and invalid paths',async()=>fixture(async root=>{
  const entries=[{path:'empty',kind:'folder'},{path:'prompt.md',kind:'file',bytes:Buffer.from('A\r\n')},{path:'agent.json',kind:'file',bytes:Buffer.from('{}\n')}];
  const canonical='[{"bytes":3,"kind":"file","path":"agent.json","sha256":"'+hash('{}\n')+'"},{"kind":"folder","path":"empty"},{"bytes":3,"kind":"file","path":"prompt.md","sha256":"'+hash('A\r\n')+'"}]';
  assert.equal(packageContentId(entries),hash(canonical));
  assert.equal(packageContentId(entries.toReversed()),hash(canonical));
  const unicode=[{path:'\ue000',kind:'file',bytes:Buffer.from('b')},{path:'😀',kind:'file',bytes:Buffer.from('a')}];
  assert.equal(packageContentId(unicode),hash('[{\"bytes\":1,\"kind\":\"file\",\"path\":\"😀\",\"sha256\":\"'+hash('a')+'\"},{\"bytes\":1,\"kind\":\"file\",\"path\":\"\ue000\",\"sha256\":\"'+hash('b')+'\"}]'));
  assert.notEqual(packageContentId(entries.filter(entry=>entry.path!=='empty')),hash(canonical));
  const archive=path.join(root,'roundtrip.zip');
  const transfer=await writePackageZip(entries,archive);
  assert.equal(transfer.sha256,hash(await readFile(archive)));
  assert.notEqual(transfer.sha256,packageContentId(entries));
  assert.equal(packageContentId(await readPackageZip(await readFile(archive))),packageContentId(entries));
  for(const name of ['../outside','C:/root','a\\b','a/../b','nul.txt','a/'.repeat(32)+'b','e\u0301'])assert.throws(()=>packagePath(name));
  const bad=new yazl.ZipFile();
  const chunks=[];bad.outputStream.on('data',chunk=>chunks.push(chunk));
  const ended=new Promise(resolve=>bad.outputStream.on('end',resolve));
  bad.addBuffer(Buffer.from('target'),'link',{mode:0o120777});bad.end();await ended;
  await assert.rejects(readPackageZip(Buffer.concat(chunks)),error=>error.kind==='invalid-request');
  await assert.rejects(readPackageZip(await readFile(archive),{limits:{maxExpandedBytes:1}}),error=>error.kind==='resource-limit');
}));

test('platform credentials use one verified header snapshot and close stops later calls',async()=>{
  const old=globalThis.fetch;
  const headers=[];let reads=0;
  globalThis.fetch=async(_url,init)=>{headers.push(new Headers(init.headers).get('authorization'));return json(session);};
  const platform=createPlatformClient({baseUrl:'https://fixture.test',allowedDownloadOrigins:[],getAuthorization:async()=>`Bearer fixture-${++reads}`});
  try{
    const verified=await platform.credentials();
    assert.equal(reads,1);assert.equal(verified.authorization,'Bearer fixture-1');assert.deepEqual(headers,['Bearer fixture-1']);
    assert.deepEqual(verified.session,session);
    await platform.close({deadline:performance.now()+100});
    await assert.rejects(platform.session(),error=>error.kind==='unavailable');
  }finally{globalThis.fetch=old;}
});

test('empty cache downloads exact original formal packages, fixed MCP and mount; later sessions reuse cache',async()=>fixture(async root=>{
  const skillEntries=[{path:'SKILL.md',kind:'file',bytes:Buffer.from('---\nname: formal-skill\ndescription: Fixed package\n---\nRead the original.\n')},{path:'empty',kind:'folder'},{path:'binary.dat',kind:'file',bytes:Buffer.from([0,255,1])}];
  const skillId=packageContentId(skillEntries),zipFile=path.join(root,'skill.zip');
  const zip=await writePackageZip(skillEntries,zipFile),zipBytes=await readFile(zipFile);
  const prompt=Buffer.from('Original instructions.\r\n');
  const config=Buffer.from(JSON.stringify({schemaVersion:1,name:'Formal operator',description:'Exact fixed version',promptFile:'prompt.md',toolIds:[],skills:[{skillId:'ops',contentId:skillId,mountPath:'/skills/custom/'}],mcpServers:[{id:'mcp',name:'Fixed MCP',description:'Fixed configuration',url:'https://mcp.test/original'}]},null,2)+'\n');
  const agentEntries=[{path:'agent.json',kind:'file',bytes:config},{path:'prompt.md',kind:'file',bytes:prompt}];
  const agentId=packageContentId(agentEntries);
  const files=entries=>entries.map(entry=>entry.kind==='folder'?{path:entry.path,kind:'folder'}:{path:entry.path,kind:'file',bytes:entry.bytes.length,sha256:hash(entry.bytes),url:'https://fixture.test/files/'+entry.path});
  const old=globalThis.fetch,seen=[];
  globalThis.fetch=async(input,init)=>{
    const url=new URL(input);seen.push(url.pathname);
    assert.equal(new Headers(init.headers).get('Authorization'),'Bearer fake-fixture-token');
    if(url.pathname===`/api/agents/inspect/versions/${agentId}`)return json({schemaVersion:1,id:'inspect',contentId:agentId,files:files(agentEntries)});
    if(url.pathname===`/api/skills/ops/versions/${skillId}`)return json({schemaVersion:1,id:'ops',contentId:skillId,files:files(skillEntries).map(({url,...item})=>item),package:{url:'https://fixture.test/skill.zip',bytes:zip.bytes,sha256:zip.sha256}});
    if(url.pathname==='/files/agent.json')return new Response(config);
    if(url.pathname==='/files/prompt.md')return new Response(prompt);
    if(url.pathname==='/skill.zip')return new Response(zipBytes);
    return new Response('',{status:404});
  };
  const platform=client();
  try{
    const resources=createResources({homeDir:root,platform,mcpCatalog:{list:()=>[],get:()=>({id:'mcp',url:'https://mcp.test/changed'})}});
    const first=await resources.prepareSession({sessionId:'first',agentId:'inspect',contentId:agentId});
    assert.equal(first.agent.contentId,agentId);assert.equal(first.agent.packageFormat,1);
    assert.equal(first.agent.configuration.instructions,prompt.toString());
    assert.equal(first.mcpServers[0].url,'https://mcp.test/original');
    assert.equal(first.skills[0].mountPath,'/skills/custom/');
    assert.deepEqual(await readFile(path.join(root,'.omnimind-ops/agents/releases/inspect',agentId,'agent.json')),config);
    assert.deepEqual(await readFile(path.join(first.directory,'skills/custom/binary.dat')),Buffer.from([0,255,1]));
    const count=seen.length;
    const next=await resources.prepareSession({sessionId:'next',agentId:'inspect',contentId:agentId});
    assert.equal(next.agent.contentId,agentId);assert.equal(seen.length,count);
    const cached=path.join(root,'.omnimind-ops/agents/releases/inspect',agentId,'prompt.md');
    await writeFile(cached,'tampered');
    await assert.rejects(resources.prepareSession({sessionId:'tampered',agentId:'inspect',contentId:agentId}),error=>error.kind==='integrity');
    assert.equal(seen.length,count);
    assert.deepEqual((await resources.prepareSession({sessionId:'first',agentId:'inspect',contentId:agentId})).agent,first.agent);
  }finally{globalThis.fetch=old;await platform.close({deadline:performance.now()+100});}
}));

test('platform-backed production cannot fall back to a legacy official identity, and abort releases preparation',async()=>fixture(async root=>{
  const settings={name:'Legacy',description:'Legacy only',instructions:'Legacy',toolIds:[],skillIds:[],mcpServerIds:[]};
  const stable=JSON.stringify(settings,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
  const contentId=hash(stable),agents=path.join(root,'.omnimind-ops/agents');
  await mkdir(agents,{recursive:true});
  await writeFile(path.join(agents,'legacy.json'),JSON.stringify({id:'legacy',source:'official',contentId,configuration:settings}));
  const resources=createResources({homeDir:root,platform:{fetchPackage:async()=>{throw new RuntimeError('unavailable','Fixture offline.');}}});
  await assert.rejects(resources.prepareSession({sessionId:'official',agentId:'legacy',contentId}),error=>error.kind==='unavailable');
  const controller=new AbortController();controller.abort();
  await assert.rejects(resources.prepareSession({sessionId:'aborted',agentId:'legacy',contentId,signal:controller.signal}),error=>error.name==='AbortError');
}));

test('bad manifest paths are rejected before material download',async()=>fixture(async root=>{
  const old=globalThis.fetch;
  const platform=client(),contentId='1'.repeat(64);
  globalThis.fetch=async()=>json({schemaVersion:1,id:'ops',contentId,files:[{path:'../escape',kind:'file',bytes:1,sha256:'2'.repeat(64),url:'https://attacker.test/file'}]});
  try{await assert.rejects(platform.fetchPackage({kind:'skill',id:'ops',contentId}),error=>error.kind==='invalid-request');}
  finally{globalThis.fetch=old;await platform.close({deadline:performance.now()+100});}
}));

test('fingerprints identify actual non-secret compositions independent of enumeration order',()=>{
  const a={id:'agent',contentId:'1'.repeat(64)},b={id:'ops',contentId:'2'.repeat(64),mountPath:'/skills/ops/'},c={id:'extra',contentId:'3'.repeat(64),mountPath:'/skills/extra/'};
  const base={agent:a,skills:[b,c],provider:{protocol:'openai-chat-completions',baseURL:'https://model.test/v1'},modelId:'model',parameters:{temperature:0,parallel_tool_calls:false,thinking:{type:'disabled'}}};
  const first=createRunFingerprint(base);
  assert.equal(first.fingerprint,createRunFingerprint({...base,skills:[c,b],parameters:{thinking:{type:'disabled'},parallel_tool_calls:false,temperature:0}}).fingerprint);
  assert.notEqual(first.fingerprint,createRunFingerprint({...base,modelId:'different'}).fingerprint);
  assert.notEqual(first.fingerprint,createRunFingerprint({...base,parameters:{...base.parameters,temperature:1}}).fingerprint);
  assert.equal(first.composition.provider.baseUrl,'https://model.test/v1');
  assert.deepEqual(first.composition.parameters,base.parameters);
  assert.throws(()=>createRunFingerprint({...base,parameters:{apiKey:'secret'}}));
});

test('foreign download grants never forward platform authorization, and ungranted origins fail',async()=>{
  const old=globalThis.fetch;
  const bytes=Buffer.from('fixture bytes'),entries=[{path:'file.txt',kind:'file',bytes}],contentId=packageContentId(entries),seen=[];
  const manifest={schemaVersion:1,id:'ops',contentId,files:[{path:'file.txt',kind:'file',bytes:bytes.length,sha256:hash(bytes),url:'https://cdn.test/file'}]};
  globalThis.fetch=async(input,init)=>{const url=new URL(input);seen.push({host:url.host,authorization:new Headers(init.headers).get('authorization')});return url.host==='cdn.test'?new Response(bytes):json(manifest);};
  const platform=createPlatformClient({baseUrl:'https://fixture.test',allowedDownloadOrigins:['https://cdn.test'],getAuthorization:async()=> 'Bearer private-fixture'}),denied=client();
  let downloaded;
  try{
    downloaded=await platform.fetchPackage({kind:'skill',id:'ops',contentId});
    assert.deepEqual(seen,[{host:'fixture.test',authorization:'Bearer private-fixture'},{host:'cdn.test',authorization:null}]);
    const count=seen.length;
    await assert.rejects(denied.fetchPackage({kind:'skill',id:'ops',contentId}),error=>error.kind==='forbidden');
    assert.equal(seen.length,count+1);
  }finally{await downloaded?.discard();globalThis.fetch=old;await platform.close({deadline:performance.now()+100});await denied.close({deadline:performance.now()+100});}
});

test('caller cancellation releases bounded download slots without corrupting another waiter',async()=>{
  const old=globalThis.fetch,bytes=Buffer.from('x'),contentId=packageContentId([{path:'x',kind:'file',bytes}]);
  const manifest={schemaVersion:1,id:'ops',contentId,files:[{path:'x',kind:'file',bytes:1,sha256:hash(bytes),url:'https://fixture.test/file'}]};
  let active=0,maximum=0;const starts=[];
  globalThis.fetch=async(input,init)=>{
    if(new URL(input).pathname!=='/file')return json(manifest);
    active++;maximum=Math.max(maximum,active);
    return await new Promise((resolve,reject)=>{
      const abort=()=>{active--;reject(init.signal.reason);};
      init.signal.addEventListener('abort',abort,{once:true});
      starts.push(()=>{init.signal.removeEventListener('abort',abort);active--;resolve(new Response(bytes));});
    });
  };
  const platform=client(),controller=new AbortController();
  const first=platform.fetchPackage({kind:'skill',id:'ops',contentId},{signal:controller.signal});
  const rejected=assert.rejects(first,error=>error.kind==='aborted');
  const second=platform.fetchPackage({kind:'skill',id:'ops',contentId});
  const third=platform.fetchPackage({kind:'skill',id:'ops',contentId});
  const wait=async condition=>{const end=Date.now()+1000;while(!condition()){assert.ok(Date.now()<end,'fixture condition timed out');await new Promise(resolve=>setImmediate(resolve));}};
  let a,b;
  try{
    await wait(()=>starts.length===2);assert.equal(maximum,2);controller.abort();await rejected;
    await wait(()=>starts.length===3);starts[1]();starts[2]();[a,b]=await Promise.all([second,third]);assert.equal(maximum,2);
  }finally{controller.abort();await platform.close({deadline:performance.now()+100});await a?.discard();await b?.discard();globalThis.fetch=old;}
});

test('diagnostic upload rejects processing replies that pretend to confirm reception and preserves safe conflict codes',async()=>fixture(async root=>{
  const file=path.join(root,'diagnostic.zip');
  const transfer=await writePackageZip([{path:'manifest.json',kind:'file',bytes:Buffer.from(JSON.stringify({uploadId:'upload',threadId:'thread',schemaVersion:1}))}],file);
  const old=globalThis.fetch,platform=client();
  globalThis.fetch=async()=>new Response(JSON.stringify({schemaVersion:1,state:'received',diagnosticId:'diagnostic',uploadId:'upload',threadId:'thread',bundleSha256:transfer.sha256,receivedAt:'2026-10-26T00:00:00Z',incomplete:false,missing:[]}),{status:202});
  try{
    await assert.rejects(platform.uploadDiagnostic({uploadId:'upload',packageFile:file,bundleSha256:transfer.sha256}),error=>error.kind==='integrity');
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'idempotency-conflict',message:'synthetic-secret-must-not-escape'}}),{status:409});
    await assert.rejects(platform.createResource({kind:'skill',name:'ops',idempotencyKey:'same'}),error=>error.kind==='idempotency-conflict'&&!error.message.includes('synthetic-secret'));
  }finally{globalThis.fetch=old;await platform.close({deadline:performance.now()+100});}
}));
