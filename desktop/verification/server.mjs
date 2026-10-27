import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat, realpath, rename, rm, open } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, isolatedRoot } from './config.mjs';
import { requireRuntime, RECEIPT, BINDING, sha256, canonical, packageDigest, resultDigest, isTerminal, safePath, fail } from './protocol.mjs';
const { WebSocketServer, WebSocket } = requireRuntime('ws');
const Database = requireRuntime('better-sqlite3');
const yazl = requireRuntime('yazl'), yauzl = requireRuntime('yauzl');
const { AgentCard, SendMessageRequest } = requireRuntime('@a2a-js/sdk');
const { McpServer } = requireRuntime('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = requireRuntime('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = requireRuntime('zod');
const MAX=100*1024*1024;
const resourceId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u),digestId=z.string().regex(/^[a-f0-9]{64}$/u),label=z.string().trim().min(1).max(256);
const formalAgent=z.object({schemaVersion:z.literal(1),name:label,description:z.string().max(4096),promptFile:z.literal('prompt.md'),toolIds:z.array(label).max(256),mcpServers:z.array(z.object({id:label,name:label,description:z.string().max(4096),url:z.string().max(8192).refine(value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}}),credentialEnv:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).optional()}).strict()).max(256),skills:z.array(z.object({skillId:resourceId,contentId:digestId,mountPath:z.string().max(1024)}).strict()).max(256)}).strict();
function checkAgent(files){try{const configuration=formalAgent.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(files.find(f=>f.path==='agent.json').data))),prompt=new TextDecoder('utf8',{fatal:true}).decode(files.find(f=>f.path==='prompt.md').data);if(!prompt.trim()||prompt.length>65536||new Set(configuration.toolIds).size!==configuration.toolIds.length||new Set(configuration.mcpServers.map(m=>m.id)).size!==configuration.mcpServers.length||new Set(configuration.skills.map(s=>s.skillId)).size!==configuration.skills.length)throw new Error();const mounts=configuration.skills.map(skill=>{if(!skill.mountPath.startsWith('/skills/')||!skill.mountPath.endsWith('/'))throw new Error();safePath(skill.mountPath.slice(1,-1));return skill.mountPath;});for(let i=0;i<mounts.length;i++)for(let j=i+1;j<mounts.length;j++)if(mounts[i].startsWith(mounts[j])||mounts[j].startsWith(mounts[i]))throw new Error();return configuration;}catch{throw fail(422,'invalid-package');}}

async function storageSize(directory){let total=0;for(const name of await readdir(directory)){const file=join(directory,name),info=await lstat(file);if(info.isSymbolicLink())throw fail(400,'unsafe-data-root');total+=info.isDirectory()?await storageSize(file):info.size;}return total;}
const cleanId = value => { if(typeof value!=='string'||!value.trim()||value.length>256||/[\x00-\x1f\x7f]/u.test(value))throw fail(400,'invalid-request');return value; };
const hashId = value => {if(!/^[a-f0-9]{64}$/u.test(value))throw fail(400,'invalid-request');return value;};
const tag = value => {if(typeof value!=='string'||!/^v\.\d+\.\d+\.\d+$/u.test(value))throw fail(422,'invalid-tag');return value;};
const same = (a,b) => {const x=Buffer.from(a??''),y=Buffer.from(b??'');return x.length===y.length&&timingSafeEqual(x,y);};
const json = (response,status,value) => {response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
async function bytes(request,limit=MAX){const chunks=[];let length=0;for await(const chunk of request){length+=chunk.length;if(length>limit)throw fail(413,'payload-too-large');chunks.push(chunk);}return Buffer.concat(chunks);}
async function body(request,limit=256*1024){let value;try{value=JSON.parse(await bytes(request,limit));}catch(error){if(error.status)throw error;throw fail(400,'invalid-request');}if(!value||typeof value!=='object'||Array.isArray(value))throw fail(400,'invalid-request');return value;}
async function syncFile(file,data){const h=await open(file,'wx',0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}}
async function zip(files){const file=new yazl.ZipFile();for(const item of files){if(item.kind==='folder')file.addEmptyDirectory(item.path,{mtime:new Date('2020-01-01T00:00:00Z')});else file.addBuffer(item.data,item.path,{mtime:new Date('2020-01-01T00:00:00Z')});}const chunks=[];let size=0;const done=new Promise((yes,no)=>{file.outputStream.on('data',chunk=>{size+=chunk.length;if(size>MAX){file.outputStream.destroy(fail(413,'payload-too-large'));return;}chunks.push(chunk);});file.outputStream.once('error',no);file.outputStream.once('end',()=>yes(Buffer.concat(chunks)));});file.end();return done;}
async function unzip(buffer){
  const archive=await new Promise((yes,no)=>yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true},(error,value)=>error?no(fail(422,'invalid-package')):yes(value)));
  const files=[],seen=new Set();let size=0;
  return new Promise((yes,no)=>{let settled=false;const bad=error=>{if(settled)return;settled=true;archive.close();no(error.status?error:fail(422,'invalid-package'));};archive.on('error',bad);archive.on('end',()=>{if(!settled){settled=true;yes(files);}});archive.on('entry',entry=>{
    try{if(files.length>=1000)throw fail(413,'payload-too-large');const directory=entry.fileName.endsWith('/'),path=safePath(directory?entry.fileName.slice(0,-1):entry.fileName),mode=(entry.externalFileAttributes>>>16)&0xffff,type=mode&0xf000;if(type&&type!==(directory?0x4000:0x8000))throw fail(422,'invalid-package');if(seen.has(path.toLowerCase()))throw fail(422,'invalid-package');seen.add(path.toLowerCase());if(entry.uncompressedSize>20*1024*1024||size+entry.uncompressedSize>MAX)throw fail(413,'payload-too-large');if(directory){files.push({path,kind:'folder'});archive.readEntry();return;}
      archive.openReadStream(entry,(error,stream)=>{if(error)return bad(error);const chunks=[];let n=0;stream.on('error',bad);stream.on('data',chunk=>{n+=chunk.length;size+=chunk.length;if(n>20*1024*1024||size>MAX)stream.destroy(fail(413,'payload-too-large'));else chunks.push(chunk);});stream.on('end',()=>{if(settled)return;files.push({path,kind:'file',data:Buffer.concat(chunks)});archive.readEntry();});});
    }catch(error){bad(error);}
  });archive.readEntry();});
}

/** Independent HTTPS/WSS fixture process. Only its public control plane sends business calls. */
export async function startVerificationService(configFile){
  const config=await readConfig(configFile,'server');await isolatedRoot(config.dataRoot);let previousPorts;try{previousPorts=JSON.parse(await readFile(join(config.dataRoot,'ports.json'),'utf8'));for(const name of ['public','control','fixtures'])if(!Number.isInteger(previousPorts[name])||previousPorts[name]<1||previousPorts[name]>65535)throw fail(400,'invalid-data');}catch(error){if(error.code!=='ENOENT')throw error;}if(previousPorts&&config.listen.port===0&&new URL(config.publicOrigin).port==='0'){config.listen.port=previousPorts.public;config.publicOrigin=`https://localhost:${previousPorts.public}`;}if(previousPorts&&config.control.port===0)config.control.port=previousPorts.control;
  const secret=async file=>{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw fail(400,'invalid-config');const value=(await readFile(file,'utf8')).trim();if(!value||/[\x00-\x20\x7f]/u.test(value))throw fail(400,'invalid-config');return value;};
  const identities=await Promise.all(config.identities.map(async identity=>({...identity,authorization:`Bearer ${await secret(identity.tokenFile)}`})));
  const controlSecret=await secret(config.control.secretFile);if(!controlSecret||controlSecret.length>8192)throw fail(400,'invalid-config');
  const fixtureText=await readFile(join(config.fixtureRoot,'manifest.json'),'utf8'),fixture=JSON.parse(fixtureText);if(fixture.schemaVersion!==1||!Array.isArray(fixture.agents)||!Array.isArray(fixture.skills))throw fail(400,'invalid-fixture');
  const owned=[];
  try {
  const db=new Database(join(config.dataRoot,'verification.sqlite'));owned.push(async()=>{if(db.open)db.close();});db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');db.pragma('busy_timeout = 1000');
  db.exec(`CREATE TABLE IF NOT EXISTS resources(kind TEXT,id TEXT,name TEXT,head TEXT,current TEXT,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS versions(kind TEXT,id TEXT,content TEXT,tag TEXT,directory TEXT,files TEXT,PRIMARY KEY(kind,id,content),UNIQUE(kind,id,tag));
    CREATE TABLE IF NOT EXISTS revisions(kind TEXT,id TEXT,revision TEXT,content TEXT,directory TEXT,files TEXT,saved_at TEXT,PRIMARY KEY(kind,id,revision));
    CREATE TABLE IF NOT EXISTS idempotency(owner TEXT,operation TEXT,key TEXT,fingerprint TEXT,response TEXT,PRIMARY KEY(owner,operation,key));
    CREATE TABLE IF NOT EXISTS calls(owner TEXT,message_id TEXT,tenant TEXT,installation TEXT,request TEXT,task_id TEXT,PRIMARY KEY(owner,message_id));
    CREATE TABLE IF NOT EXISTS results(owner TEXT,tenant TEXT,task_id TEXT,digest TEXT,task TEXT,received_at TEXT,confirmed INTEGER DEFAULT 0,consumed INTEGER DEFAULT 1,PRIMARY KEY(owner,tenant,task_id));
    CREATE TABLE IF NOT EXISTS diagnostics(owner TEXT,upload_id TEXT,digest TEXT,thread_id TEXT,diagnostic_id TEXT,received_at TEXT,package_file TEXT,manifest TEXT,PRIMARY KEY(owner,upload_id));`);
  let storageBytes=await storageSize(config.dataRoot);const reserveBytes=bytes=>{const count=Math.ceil(bytes/4096)*4096+8192;if(storageBytes+count>1024*1024*1024)throw fail(429,'resource-limit');storageBytes+=count;return ()=>{storageBytes-=count;};};
  const ownerOf=principal=>canonical([principal.organizationId,principal.callerId,principal.installationId]);
  for(const kind of ['agents','skills'])for(const item of fixture[kind]){
    cleanId(item.id);hashId(item.contentId);tag(item.releaseTag);const dir=resolve(config.fixtureRoot,item.directory);if(relative(config.fixtureRoot,dir).startsWith('..'))throw fail(400,'invalid-fixture');
    const files=[];for(const f of item.files){safePath(f.path);const data=f.kind==='file'?await readFile(join(dir,f.path)):undefined;if(data&&(data.length!==f.bytes||sha256(data)!==f.sha256))throw fail(400,'invalid-fixture');files.push({...f,data});}if(packageDigest(files)!==item.contentId)throw fail(400,'invalid-fixture');
    db.prepare('INSERT OR IGNORE INTO resources VALUES(?,?,?,NULL,NULL)').run(kind,item.id,item.id);
    const old=db.prepare('SELECT files FROM versions WHERE kind=? AND id=? AND content=?').get(kind,item.id,item.contentId);if(old&&old.files!==JSON.stringify(item.files))throw fail(409,'immutable-conflict');
    db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?)').run(kind,item.id,item.contentId,item.releaseTag,dir,JSON.stringify(item.files));
    db.prepare('UPDATE resources SET current=? WHERE kind=? AND id=? AND current IS NULL').run(item.contentId,kind,item.id);
  }
  let origin=config.publicOrigin,closing=false,activeHttp=0;
  const clients=new Map(),sessions=new Map(),faults=new Map(),sockets=new Set();
  const counts={modelRequests:0,mcpCalls:0,pageEffects:0,downloads:0,connections:0,upgradeAttempts:0,pendingHandshakes:0};
  const modelInputs=[];
  const takeFault=name=>{const f=faults.get(name);if(!f||Date.now()>f.until){faults.delete(name);return false;}if(--f.remaining<=0)faults.delete(name);return true;};
  const auth=request=>{const identity=identities.find(i=>same(i.authorization,request.headers.authorization));if(!identity||Date.parse(identity.expiresAt)<=Date.now())throw fail(401,'unauthenticated');return identity;};
  const permit=(identity,permission)=>{if(!identity.permissions.includes(permission)||['official-read','official-maintain','task-call'].includes(permission)&&identity.principal.organizationId!==identities[0].principal.organizationId)throw fail(403,'forbidden');};
  const version=(kind,id,content)=>{const v=db.prepare('SELECT * FROM versions WHERE kind=? AND id=? AND content=?').get(kind,id,content);if(!v)throw fail(404,'not-found');return v;};
  async function filesFor(record){const items=JSON.parse(record.files);return Promise.all(items.map(async f=>({...f,...(f.kind==='file'?{data:await readFile(join(record.directory,f.path))}:{})})));}
  async function storePackage(kind,id,files){
    if(kind==='agents'&&(files.length!==2||!files.some(f=>f.path==='agent.json'&&f.kind==='file')||!files.some(f=>f.path==='prompt.md'&&f.kind==='file')))throw fail(422,'invalid-package');
    if(kind==='agents')checkAgent(files);if(kind==='skills'&&!files.some(f=>f.path==='SKILL.md'&&f.kind==='file'))throw fail(422,'invalid-package');
    const content=packageDigest(files),base=join(config.dataRoot,'content',kind,id),directory=join(base,content),temp=join(base,`.tmp-${randomUUID()}`);let undo;try{const existing=await lstat(directory);if(!existing.isDirectory()||existing.isSymbolicLink())throw fail(409,'immutable-conflict');return {content,directory,files:JSON.stringify(files.map(f=>f.kind==='folder'?{path:f.path,kind:'folder'}:{path:f.path,kind:'file',bytes:f.data.length,sha256:sha256(f.data)}))};}catch(error){if(error.code!=='ENOENT')throw error;undo=reserveBytes(files.reduce((n,f)=>n+(f.data?.length??0),0));}await mkdir(temp,{recursive:true,mode:0o700});
    try{for(const f of files){const target=join(temp,safePath(f.path));if(f.kind==='folder')await mkdir(target,{recursive:true});else{await mkdir(resolve(target,'..'),{recursive:true});await syncFile(target,f.data);}}
      try{await rename(temp,directory);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;await rm(temp,{recursive:true,force:true});undo?.();undo=undefined;}
    }catch(error){await rm(temp,{recursive:true,force:true});undo?.();throw error;}
    return {content,directory,files:JSON.stringify(files.map(f=>f.kind==='folder'?{path:f.path,kind:'folder'}:{path:f.path,kind:'file',bytes:f.data.length,sha256:sha256(f.data)}))};
  }
  function cardFor(record){return AgentCard.toJSON(AgentCard.fromJSON({name:record.id,description:'Independent verification Agent.',version:record.content,supportedInterfaces:[{url:origin.replace('https:','wss:')+'/api/clients/connect',protocolBinding:BINDING,protocolVersion:'1.0',tenant:`agent/${record.id}/${record.content}`}],capabilities:{streaming:true,pushNotifications:false,extendedAgentCard:false,extensions:[{uri:RECEIPT,required:true}]},defaultInputModes:['application/json'],defaultOutputModes:['application/json'],skills:[]}));}
  async function manifestFor(record,kind,draft=false){const items=JSON.parse(record.files),base=`${origin}/api/${kind}/${encodeURIComponent(record.id)}/${draft?'drafts/'+record.revision:'versions/'+record.content}`;const packed=await zip(await filesFor(record));return {schemaVersion:1,id:record.id,contentId:record.content,releaseTag:record.tag,files:items.map(f=>({...f,...(f.kind==='file'?{url:`${base}/files/${encodeURIComponent(f.path)}`}:{})})),package:{url:`${base}/package`,bytes:packed.length,sha256:sha256(packed)},...(kind==='agents'?{agentCard:cardFor(record)}:{})};}
  function page(rows,url){const limit=Number(url.searchParams.get('limit')??50);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail(400,'invalid-request');const revision=sha256(canonical(rows));let offset=0;const cursor=url.searchParams.get('cursor');if(cursor){try{if(cursor.length>1024)throw new Error();const value=JSON.parse(Buffer.from(cursor,'base64url'));if(value.revision!==revision)throw fail(409,'cursor-expired');if(!Number.isSafeInteger(value.offset)||value.offset<0)throw new Error();offset=value.offset;}catch(error){if(error.status)throw error;throw fail(400,'invalid-cursor');}}return {schemaVersion:1,items:rows.slice(offset,offset+limit),nextCursor:offset+limit<rows.length?Buffer.from(JSON.stringify({revision,offset:offset+limit})).toString('base64url'):null};}
  function writeIdempotent(request,identity,operation,payload,action){const key=cleanId(request.headers['idempotency-key']),fingerprint=sha256(canonical(payload)),owner=ownerOf(identity.principal);return db.transaction(()=>{const previous=db.prepare('SELECT * FROM idempotency WHERE owner=? AND operation=? AND key=?').get(owner,operation,key);if(previous){if(previous.fingerprint!==fingerprint)throw fail(409,'idempotency-conflict');return JSON.parse(previous.response);}const value=action();db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(owner,operation,key,fingerprint,JSON.stringify(value));return value;})();}
  async function preview(skillId,draftRevisionId){const revision=db.prepare('SELECT * FROM revisions WHERE kind=? AND id=? AND revision=?').get('skills',skillId,draftRevisionId);if(!revision)throw fail(404,'not-found');const affected=[];for(const a of db.prepare("SELECT * FROM resources WHERE kind='agents' AND current IS NOT NULL ORDER BY id").all()){const v=version('agents',a.id,a.current),configuration=JSON.parse(await readFile(join(v.directory,'agent.json'),'utf8'));if(configuration.skills?.some(s=>s.skillId===skillId))affected.push({agentId:a.id,expectedContentId:a.current});}return {schemaVersion:1,contentId:revision.content,baseline:sha256(canonical([revision.content,affected])),affectedAgents:affected};}
  function rpc(socket,method,params,{timeoutMs=120000}={}){
    if(closing||socket.readyState!==WebSocket.OPEN) return Promise.reject(fail(503,'not-connected'));
    if(socket.pending.size>=32||(['SendStreamingMessage','SubscribeToTask'].includes(method)&&[...socket.pending.values()].filter(p=>['SendStreamingMessage','SubscribeToTask'].includes(p.method)).length>=16))return Promise.reject(fail(429,'resource-limit'));
    const id=randomUUID(),wire=JSON.stringify({jsonrpc:'2.0',id,method,params});if(Buffer.byteLength(wire)>256*1024)return Promise.reject(fail(413,'payload-too-large'));if(socket.bufferedAmount+Buffer.byteLength(wire)>8*1024*1024)return Promise.reject(fail(429,'resource-limit'));
    return new Promise((yes,no)=>{const timer=setTimeout(()=>{socket.pending.delete(id);no(fail(504,'rpc-timeout'));},timeoutMs);socket.pending.set(id,{yes,no,timer,method,events:[],bytes:0});socket.send(wire,error=>{if(error){clearTimeout(timer);socket.pending.delete(id);no(fail(503,'send-failed'));}});});
  }
  function chooseClient(installationId){const found=[...clients.values()].filter(s=>s.identity.principal.installationId===installationId&&s.readyState===WebSocket.OPEN);if(found.length!==1)throw fail(503,'not-connected');return found[0];}
  async function captureResult(socket,tenant,task){
    if(!isTerminal(task))return;
    const raw=JSON.stringify(task);if(Buffer.byteLength(raw)>1024*1024)throw fail(413,'payload-too-large');
    const digest=resultDigest(task),owner=ownerOf(socket.identity.principal),receivedAt=new Date().toISOString();
    if(takeFault('result-storage'))throw fail(503,'storage');
    db.transaction(()=>{const previous=db.prepare('SELECT digest FROM results WHERE owner=? AND tenant=? AND task_id=?').get(owner,tenant,task.id);if(previous&&previous.digest!==digest)throw fail(409,'immutable-conflict');if(!previous){const undo=reserveBytes(Buffer.byteLength(raw));try{db.prepare('INSERT INTO results(owner,tenant,task_id,digest,task,received_at) VALUES(?,?,?,?,?,?)').run(owner,tenant,task.id,digest,raw,receivedAt);}catch(error){undo();throw error;}}})();
    if(takeFault('drop-receipt'))return;
    const row=db.prepare('SELECT * FROM results WHERE owner=? AND tenant=? AND task_id=?').get(owner,tenant,task.id);
    await rpc(socket,'omniops/ConfirmTaskDelivery',{tenant,taskId:task.id,resultSha256:digest,receivedAt:row.received_at});
    db.prepare('UPDATE results SET confirmed=1 WHERE owner=? AND tenant=? AND task_id=?').run(owner,tenant,task.id);
  }
  async function call(command){
    const socket=chooseClient(cleanId(command.installationId)),method=cleanId(command.method),params=command.params;
    if(!params||typeof params!=='object'||Array.isArray(params))throw fail(400,'invalid-request');cleanId(params.tenant);
    const allowed=['SendMessage','SendStreamingMessage','GetTask','ListTasks','SubscribeToTask','CancelTask','GetExtendedAgentCard','CreateTaskPushNotificationConfig','omniops/ConfirmTaskDelivery'];if(!allowed.includes(method))throw fail(400,'invalid-request');
    let messageId;
    if(['SendMessage','SendStreamingMessage'].includes(method)){
      const normalized=SendMessageRequest.toJSON(SendMessageRequest.fromJSON(params));if(!params.message?.messageId||canonical(normalized.message)!==canonical(params.message))throw fail(400,'invalid-request');messageId=cleanId(params.message.messageId);
      const owner=ownerOf(socket.identity.principal),serialized=canonical({method,params});
      db.transaction(()=>{const previous=db.prepare('SELECT * FROM calls WHERE owner=? AND message_id=?').get(owner,messageId);if(previous){const prior=JSON.parse(previous.request);if(canonical({tenant:prior.params.tenant,message:prior.params.message})!==canonical({tenant:params.tenant,message:params.message}))throw fail(409,'idempotency-conflict');}else{if(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n>=4096)throw fail(429,'resource-limit');const undo=reserveBytes(Buffer.byteLength(serialized));try{db.prepare('INSERT INTO calls VALUES(?,?,?,?,?,NULL)').run(owner,messageId,params.tenant,command.installationId,serialized);}catch(error){undo();throw error;}}})();
    }
    const value=await rpc(socket,method,params);let task=value?.task??(value?.id&&value?.status?value:undefined);
    if(Array.isArray(value)){const first=value.find(x=>x.task)?.task;if(first){task=await rpc(socket,'GetTask',{tenant:params.tenant,id:first.id});}}
    if(task&&messageId)db.prepare('UPDATE calls SET task_id=? WHERE owner=? AND message_id=?').run(task.id,ownerOf(socket.identity.principal),messageId);
    if(task)await captureResult(socket,params.tenant,task);
    return value;
  }
  async function handleMcp(request,response){
        const input=request.method==='POST'?await body(request):undefined;let session=sessions.get(request.headers['mcp-session-id']);
        if(!session&&input?.method==='initialize'){
          if(sessions.size>=64)throw fail(429,'resource-limit');
          const server=new McpServer({name:'verification-mcp',version:'1.0.0'});server.registerTool('lookup',{description:'Return isolated fixture data.',inputSchema:{value:z.string()}},async({value})=>{counts.mcpCalls++;return {content:[{type:'text',text:JSON.stringify({value})}]};});
          server.registerResource('reference','fixture://reference',{mimeType:'text/plain'},async uri=>({contents:[{uri:uri.href,text:'Fixture reference'}]}));server.registerPrompt('reference',{argsSchema:{}},()=>({messages:[{role:'user',content:{type:'text',text:'Fixture prompt'}}]}));
          const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true,onsessioninitialized:id=>sessions.set(id,{server,transport}),onsessionclosed:id=>sessions.delete(id)});await server.connect(transport);session={server,transport};
        }
        if(!session)throw fail(404,'not-found');await session.transport.handleRequest(request,response,input);return;
  }
  const handleFixture=async(request,response)=>{
    try{
      const url=new URL(request.url,'http://fixture');
      if(url.pathname==='/site'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><title>Verification fixture</title><label>Fixture value<input aria-label="Fixture value"></label><button onclick="fetch(\'/effect\',{method:\'POST\'}).then(()=>document.querySelector(\'output\').textContent=\'saved\')">Save fixture</button><output></output>');return;}
      if(url.pathname==='/effect'&&request.method==='POST'){counts.pageEffects++;json(response,200,{saved:true});return;}
      if(url.pathname==='/v1/chat/completions'&&request.method==='POST'){
        const input=await body(request,4*1024*1024);counts.modelRequests++;if(modelInputs.length<128)modelInputs.push({model:input.model,temperature:input.temperature,max_tokens:input.max_tokens,parallel_tool_calls:input.parallel_tool_calls,thinking:input.thinking,tools:(input.tools??[]).map(tool=>tool.function?.name).filter(Boolean)});
        const text=input.messages?.findLast(m=>m.role==='user')?.content;let task;try{task=JSON.parse(typeof text==='string'?text:'{}');}catch{task={};}
        response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});response.flushHeaders();
        if(task.hold)return;
        const last=input.messages?.findLast(m=>m.role==='tool'),calls=input.messages?.flatMap(m=>m.tool_calls??[])??[],lastCall=calls.find(c=>c.id===last?.tool_call_id);let result;try{result=JSON.parse(last?.content);}catch{}
        let action;
        if(task.mcp&&!last)action={name:'mcp_verification_lookup',args:{value:'verification'}};
        else if(task.browser&&(!last||lastCall?.function?.name==='mcp_verification_lookup'))action={name:'inspect_browser',args:{url:siteURL}};
        else if(task.browser&&lastCall?.function?.name==='inspect_browser')action={name:'write_playwright_script',args:{name:'verification.mjs',code:`export default async({page,assert})=>{await page.goto(${JSON.stringify(siteURL)});await page.getByLabel('Fixture value').fill('verification');await page.getByRole('button',{name:'Save fixture'}).click();await page.waitForFunction(()=>document.querySelector('output').textContent==='saved');assert.equal(await page.getByLabel('Fixture value').inputValue(),'verification');return {saved:true};}`}};
        else if(task.browser&&lastCall?.function?.name==='write_playwright_script')action={name:'run_playwright_script',args:{name:result.name,sha256:result.sha256}};
        const id=`fixture-${counts.modelRequests}`,chunk=(delta,finish_reason=null)=>response.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created:1,model:'verification-model',choices:[{index:0,delta,finish_reason}]})}\n\n`);
        chunk({role:'assistant'});if(action)chunk({tool_calls:[{index:0,id,type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}}]});else chunk({content:task.invalid?'not-json':JSON.stringify(Object.hasOwn(task,'value')?task.value:{ok:true})});chunk({},action?'tool_calls':'stop');response.end('data: [DONE]\n\n');return;
      }
      if(url.pathname==='/mcp'){await handleMcp(request,response);return;}
      throw fail(404,'not-found');
    }catch(error){if(!response.headersSent)json(response,error.status??500,{error:{code:error.code??'fixture-failed',message:'Fixture request failed.'}});else response.end();}
  };
  const fixtures=httpServer(handleFixture);
  owned.push(async()=>{fixtures.closeAllConnections();await new Promise(yes=>fixtures.close(()=>yes()));});
  await new Promise((yes,no)=>{fixtures.once('error',no);fixtures.listen(previousPorts?.fixtures??0,'127.0.0.1',yes);});const fixtureOrigin=`http://127.0.0.1:${fixtures.address().port}`,siteURL=['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)?fixtureOrigin+'/site':origin+'/site';
  const business=httpsServer({cert:await readFile(config.tls.certFile),key:await readFile(config.tls.keyFile),maxHeaderSize:16384},async(request,response)=>{
    if(++activeHttp>32){activeHttp--;json(response,429,{error:{code:'resource-limit',message:'Too many requests.'}});return;}
    response.once('close',()=>activeHttp--);
    try{
      const u=new URL(request.url,origin);if(['/mcp','/site','/effect','/v1/chat/completions'].includes(u.pathname)){await handleFixture(request,response);return;}const parts=u.pathname.split('/').filter(Boolean).map(decodeURIComponent);if(parts[0]==='updates'){
        const base=resolve(config.fixtureRoot,'updates'),target=resolve(base,...parts.slice(1));if(relative(base,target).startsWith('..'))throw fail(403,'forbidden');let info,canonicalBase,canonicalTarget;try{info=await lstat(target);canonicalBase=await realpath(base);canonicalTarget=await realpath(target);}catch{throw fail(404,'not-found');}if(!info.isFile()||info.isSymbolicLink()||relative(canonicalBase,canonicalTarget).startsWith('..'))throw fail(404,'not-found');response.writeHead(200,{'Content-Type':target.endsWith('.json')?'application/json':'application/octet-stream'});response.end(await readFile(target));return;
      }
      const identity=auth(request),owner=ownerOf(identity.principal);
      if(parts.join('/')==='api/session'){json(response,200,{schemaVersion:1,...identity.principal,permissions:identity.permissions,expiresAt:identity.expiresAt});return;}
      if(parts[0]!=='api')throw fail(404,'not-found');
      if(['agents','skills'].includes(parts[1])){
        const kind=parts[1];permit(identity,request.method==='GET'?'official-read':'official-maintain');
        if(parts.length===2){
          if(request.method==='GET'){const rows=db.prepare('SELECT id,name,current FROM resources WHERE kind=? ORDER BY id').all(kind);json(response,200,page(rows.map(r=>({id:r.id,name:r.name,contentId:r.current})),u));return;}
          if(request.method==='POST'){const input=await body(request);if(input.schemaVersion!==1||typeof input.name!=='string'||!input.name.trim()||input.name.length>256)throw fail(400,'invalid-request');const value=writeIdempotent(request,identity,`create:${kind}`,input,()=>{if(db.prepare('SELECT COUNT(*) AS n FROM resources').get().n>=1000)throw fail(429,'resource-limit');const id=randomUUID();db.prepare('INSERT INTO resources VALUES(?,?,?,NULL,NULL)').run(kind,id,input.name);return {schemaVersion:1,kind:kind==='agents'?'agent':'skill',id};});json(response,201,value);return;}
        }
        const id=cleanId(parts[2]);
        if(parts[3]==='versions'){
          if(parts.length===4){const rows=db.prepare('SELECT content,tag FROM versions WHERE kind=? AND id=? ORDER BY tag').all(kind,id);json(response,200,page(rows.map(v=>({contentId:v.content,releaseTag:v.tag})),u));return;}
          const record=version(kind,id,hashId(parts[4]));
          if(parts.length===5){json(response,200,await manifestFor(record,kind));return;}
          if(parts[5]==='package'){
            let packed=await zip(await filesFor(record));counts.downloads++;if(takeFault('bad-package'))packed=Buffer.from('invalid-zip');if(takeFault('half-package')){response.writeHead(200,{'Content-Length':packed.length});response.write(packed.subarray(0,Math.max(1,packed.length>>1)));response.destroy();return;}response.writeHead(200,{'Content-Type':'application/zip','Content-Length':packed.length});response.end(packed);return;
          }
          if(parts[5]==='files'&&parts.length===7){const name=safePath(parts[6]),entry=JSON.parse(record.files).find(f=>f.path===name&&f.kind==='file');if(!entry)throw fail(404,'not-found');counts.downloads++;let data=await readFile(join(record.directory,name));if(takeFault('bad-package'))data=Buffer.from('corrupt');response.writeHead(200,{'Content-Type':'application/octet-stream'});response.end(data);return;}
        }
        if(parts[3]==='drafts'){
          permit(identity,'official-maintain');
          if(request.method==='GET'){
            if(parts[4]){const record=db.prepare('SELECT * FROM revisions WHERE kind=? AND id=? AND revision=?').get(kind,id,parts[4]);if(!record)throw fail(404,'not-found');if(parts[5]==='package'){const packed=await zip(await filesFor(record));response.writeHead(200,{'Content-Type':'application/zip'});response.end(packed);return;}if(parts[5]==='files'&&parts.length===7){const name=safePath(parts[6]);if(!JSON.parse(record.files).some(f=>f.path===name&&f.kind==='file'))throw fail(404,'not-found');response.writeHead(200,{'Content-Type':'application/octet-stream'});response.end(await readFile(join(record.directory,name)));return;}if(parts.length!==5)throw fail(404,'not-found');json(response,200,{...await manifestFor(record,kind,true),draftRevisionId:record.revision,savedAt:record.saved_at});}
            else{const rows=db.prepare('SELECT revision,content,saved_at FROM revisions WHERE kind=? AND id=? ORDER BY saved_at').all(kind,id);json(response,200,{...page(rows.map(r=>({draftRevisionId:r.revision,contentId:r.content,savedAt:r.saved_at})),u),head:db.prepare('SELECT head FROM resources WHERE kind=? AND id=?').get(kind,id)?.head??null});}return;
          }
          if(request.method==='POST'){
            const data=await bytes(request,MAX+2*1024*1024);let form,manifest;try{form=await new Response(data,{headers:{'Content-Type':request.headers['content-type']??''}}).formData();const raw=form.get('manifest');if(typeof raw!=='string'||Buffer.byteLength(raw)>2*1024*1024)throw fail(400,'invalid-request');manifest=JSON.parse(raw);}catch{throw fail(400,'invalid-request');}const file=form.get('package');if(manifest.schemaVersion!==1||!file||typeof file.arrayBuffer!=='function')throw fail(400,'invalid-request');const packed=Buffer.from(await file.arrayBuffer());if(packed.length>MAX)throw fail(413,'payload-too-large');const files=await unzip(packed),stored=await storePackage(kind,id,files);if(stored.content!==manifest.contentId||canonical(JSON.parse(stored.files))!==canonical(manifest.files))throw fail(422,'invalid-package');
            const value=writeIdempotent(request,identity,`draft:${kind}:${id}`,manifest,()=>{const resource=db.prepare('SELECT head FROM resources WHERE kind=? AND id=?').get(kind,id);if(!resource)throw fail(404,'not-found');if(resource.head!==manifest.expectedRevision)throw fail(409,'revision-conflict');if(db.prepare('SELECT COUNT(*) AS n FROM revisions').get().n>=4096)throw fail(429,'resource-limit');const revision=randomUUID(),savedAt=new Date().toISOString();db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)').run(kind,id,revision,stored.content,stored.directory,stored.files,savedAt);db.prepare('UPDATE resources SET head=? WHERE kind=? AND id=?').run(revision,kind,id);return {schemaVersion:1,draftRevisionId:revision,contentId:stored.content,savedAt,revision};});json(response,201,value);return;
          }
        }
        if(parts[3]==='publish-preview'&&kind==='skills'&&request.method==='POST'){const input=await body(request);json(response,200,await preview(id,cleanId(input.draftRevisionId)));return;}
        if(parts[3]==='releases'&&request.method==='POST'){
          const input=await body(request);const priorKey=cleanId(request.headers['idempotency-key']),prior=db.prepare('SELECT * FROM idempotency WHERE owner=? AND operation=? AND key=?').get(owner,`release:${kind}:${id}`,priorKey);if(prior){if(prior.fingerprint!==sha256(canonical(input)))throw fail(409,'idempotency-conflict');json(response,200,JSON.parse(prior.response));return;}const revision=db.prepare('SELECT * FROM revisions WHERE kind=? AND id=? AND revision=?').get(kind,id,cleanId(input.draftRevisionId));if(!revision)throw fail(404,'not-found');tag(input.releaseTag);const changes=[{kind,id,content:revision.content,directory:revision.directory,files:revision.files,tag:input.releaseTag}],expected=[];
          if(kind==='skills'){
            const p=await preview(id,input.draftRevisionId);if(p.baseline!==input.baseline||!Array.isArray(input.affectedAgents)||canonical(input.affectedAgents.map(a=>({agentId:a.agentId,expectedContentId:a.expectedContentId})).sort((a,b)=>a.agentId.localeCompare(b.agentId)))!==canonical(p.affectedAgents))throw fail(409,'revision-conflict');
            for(const affected of input.affectedAgents){tag(affected.releaseTag);const prior=version('agents',affected.agentId,affected.expectedContentId),files=await filesFor(prior),configuration=JSON.parse(files.find(f=>f.path==='agent.json').data);configuration.skills=configuration.skills.map(s=>s.skillId===id?{...s,contentId:revision.content}:s);files.find(f=>f.path==='agent.json').data=Buffer.from(JSON.stringify(configuration,null,2)+'\n');const stored=await storePackage('agents',affected.agentId,files);changes.push({kind:'agents',id:affected.agentId,...stored,tag:affected.releaseTag});expected.push(affected);}
          }else{const resource=db.prepare('SELECT current FROM resources WHERE kind=? AND id=?').get(kind,id);if(!resource||resource.current!==input.expectedContentId)throw fail(409,'revision-conflict');expected.push({agentId:id,expectedContentId:input.expectedContentId});const configuration=JSON.parse(await readFile(join(revision.directory,'agent.json'),'utf8'));for(const skill of configuration.skills??[])version('skills',skill.skillId,skill.contentId);}
          const value=writeIdempotent(request,identity,`release:${kind}:${id}`,input,()=>{for(const e of expected)if(db.prepare("SELECT current FROM resources WHERE kind='agents' AND id=?").get(e.agentId)?.current!==e.expectedContentId)throw fail(409,'revision-conflict');for(const c of changes)if(db.prepare('SELECT 1 FROM versions WHERE kind=? AND id=? AND tag=?').get(c.kind,c.id,c.tag))throw fail(409,'tag-conflict');if(db.prepare('SELECT COUNT(*) AS n FROM versions').get().n+changes.length>4096)throw fail(429,'resource-limit');if(takeFault('release-storage'))throw fail(503,'storage');for(const c of changes){db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?)').run(c.kind,c.id,c.content,c.tag,c.directory,c.files);db.prepare('UPDATE resources SET current=? WHERE kind=? AND id=?').run(c.content,c.kind,c.id);}return {schemaVersion:1,releaseId:randomUUID(),versions:changes.map(c=>({kind:c.kind==='agents'?'agent':'skill',id:c.id,contentId:c.content,releaseTag:c.tag}))};});json(response,201,value);return;
        }
      }
      if(parts[1]==='diagnostics'){
        if(parts[2]==='limits'){permit(identity,'diagnostic-own');json(response,200,{schemaVersion:1,formatVersions:[1],maxPackageBytes:MAX,maxExpandedBytes:MAX,maxFiles:1000});return;}
        if(parts[2]==='thread-uploads'){
          permit(identity,'diagnostic-own');const uploadId=cleanId(parts[3]),old=db.prepare('SELECT * FROM diagnostics WHERE owner=? AND upload_id=?').get(owner,uploadId);
          const receipt=row=>({schemaVersion:1,state:'received',diagnosticId:row.diagnostic_id,uploadId:row.upload_id,threadId:row.thread_id,bundleSha256:row.digest,receivedAt:row.received_at,incomplete:Boolean(JSON.parse(row.manifest).missing?.length),missing:(JSON.parse(row.manifest).missing??[]).map(item=>typeof item==='string'?item:typeof item?.reason==='string'?item.reason:'material-unavailable')});
          if(request.method==='GET'){if(!old)throw fail(404,'not-found');json(response,200,receipt(old));return;}
          if(request.method==='PUT'){const data=await bytes(request),digest=sha256(data),claimed=request.headers['x-bundle-sha256']??request.headers['x-content-sha256'];if(claimed!==digest)throw fail(422,'invalid-package');if(old){if(old.digest!==digest)throw fail(409,'idempotency-conflict');json(response,200,receipt(old));return;}
            const files=await unzip(data),manifestFile=files.find(f=>f.path==='manifest.json');if(!manifestFile)throw fail(422,'invalid-package');const manifest=JSON.parse(manifestFile.data);if(manifest.schemaVersion!==1||manifest.uploadId!==uploadId||!Number.isFinite(Date.parse(manifest.cutoff))||manifest.redactionPolicy!=='omniops-diagnostics:1'||typeof manifest.engine!=='string'||!Array.isArray(manifest.runs)||manifest.runs.length>1000||!Array.isArray(manifest.files)||manifest.files.length>1000||!Array.isArray(manifest.missing))throw fail(422,'invalid-package');cleanId(manifest.threadId);const declared=new Set();for(const entry of manifest.files){safePath(entry.path);if(entry.path==='manifest.json'||declared.has(entry.path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!/^[a-f0-9]{64}$/u.test(entry.sha256))throw fail(422,'invalid-package');declared.add(entry.path);}if(files.some(f=>f.kind==='file'&&f.path!=='manifest.json'&&!declared.has(f.path)))throw fail(422,'invalid-package');for(const run of manifest.runs){cleanId(run.runId);if(run.graphThreadId!==null&&run.graphThreadId!==undefined)cleanId(run.graphThreadId);}for(const f of manifest.files??[]){const actual=files.find(x=>x.path===f.path&&x.kind==='file');if(!actual||actual.data.length!==f.bytes||sha256(actual.data)!==f.sha256)throw fail(422,'invalid-package');}
            const file=join(config.dataRoot,`${randomUUID()}.zip`),undo=reserveBytes(data.length);try{await syncFile(file,data);if(takeFault('diagnostic-storage'))throw fail(503,'storage');}catch(error){await rm(file,{force:true});undo();throw error;}const row={owner,upload_id:uploadId,digest,thread_id:manifest.threadId,diagnostic_id:randomUUID(),received_at:new Date().toISOString(),package_file:file,manifest:JSON.stringify(manifest)};db.prepare('INSERT INTO diagnostics VALUES(@owner,@upload_id,@digest,@thread_id,@diagnostic_id,@received_at,@package_file,@manifest)').run(row);if(takeFault('diagnostic-response-loss')){response.destroy();return;}if(takeFault('diagnostic-wrong-receipt')){json(response,201,{...receipt(row),bundleSha256:'0'.repeat(64)});return;}if(takeFault('diagnostic-pending')){json(response,202,{schemaVersion:1,state:'pending',uploadId});return;}json(response,201,receipt(row));return;
          }
        }
        permit(identity,'diagnostic-read');const rows=db.prepare('SELECT * FROM diagnostics WHERE owner=?').all(owner);if(parts.length===2){json(response,200,page(rows.map(r=>({diagnosticId:r.diagnostic_id,threadId:r.thread_id,receivedAt:r.received_at})),u));return;}const row=rows.find(r=>r.diagnostic_id===parts[2]);if(!row)throw fail(404,'not-found');if(parts[3]==='attachments'){const files=await unzip(await readFile(row.package_file)),entry=files.find(f=>sha256(f.path)===parts[4]&&f.kind==='file');if(!entry)throw fail(404,'not-found');response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment'});response.end(entry.data);return;}const files=JSON.parse(row.manifest).files??[];json(response,200,{schemaVersion:1,diagnosticId:row.diagnostic_id,threadId:row.thread_id,manifest:JSON.parse(row.manifest),attachments:files.map(f=>({attachmentId:sha256(f.path),path:f.path}))});return;
      }
      throw fail(404,'not-found');
    }catch(error){if(!response.headersSent)json(response,error.status??500,{error:{code:error.code??'temporarily-unavailable',message:'Verification request could not be completed.',requestId:randomUUID()}});else response.end();}
  });
  owned.push(async()=>{for(const socket of sockets)socket.destroy();business.closeAllConnections();await new Promise(yes=>business.close(()=>yes()));});
  business.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  const wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024,perMessageDeflate:false});owned.push(async()=>{for(const socket of wss.clients)socket.terminate();await new Promise(yes=>wss.close(()=>yes()));});
  business.on('upgrade',async(request,socket,head)=>{
    try{if(closing||request.url!=='/api/clients/connect')throw fail(404,'not-found');const identity=auth(request);permit(identity,'task-call');if(request.headers['a2a-version']!=='1.0'||!String(request.headers['a2a-extensions']??'').split(',').map(s=>s.trim()).includes(RECEIPT))throw fail(400,'protocol');
      counts.upgradeAttempts++;const delayed=faults.get('delay-handshake');if(takeFault('delay-handshake')){counts.pendingHandshakes++;try{await new Promise(yes=>{let timer;const done=()=>{clearTimeout(timer);socket.off('close',done);yes();};timer=setTimeout(done,delayed.durationMs);socket.once('close',done);});}finally{counts.pendingHandshakes--;}}if(closing||socket.destroyed)return;
      request.identity=identity;wss.handleUpgrade(request,socket,head,ws=>wss.emit('connection',ws,request));
    }catch(error){socket.end(`HTTP/1.1 ${error.status??400} Rejected\r\nConnection: close\r\n\r\n`);}
  });
  wss.on('headers',headers=>{if(!takeFault('missing-version'))headers.push(`A2A-Version: ${takeFault('wrong-version')?'9.0':'1.0'}`);if(!takeFault('missing-extension'))headers.push(`A2A-Extensions: ${RECEIPT}`);});
  wss.on('connection',(socket,request)=>{
    socket.identity=request.identity;socket.pending=new Map();const owner=ownerOf(socket.identity.principal);clients.get(owner)?.close(1000);clients.set(owner,socket);counts.connections++;
    socket.on('error',()=>{});socket.on('close',()=>{if(clients.get(owner)===socket)clients.delete(owner);for(const p of socket.pending.values()){clearTimeout(p.timer);p.no(fail(503,'connection-closed'));}socket.pending.clear();});
    socket.on('message',(buffer,binary)=>{try{if(binary||buffer.length>2*1024*1024)throw fail(400,'protocol');const message=JSON.parse(buffer);const p=socket.pending.get(message.id);if(!p)return;if(message.error){clearTimeout(p.timer);socket.pending.delete(message.id);p.no(Object.assign(fail(422,'rpc-error'),{rpcError:message.error}));return;}if(!Object.hasOwn(message,'result'))throw fail(400,'protocol');
      const result=message.result;if(['SendStreamingMessage','SubscribeToTask'].includes(p.method)){p.bytes+=buffer.length;if(p.events.length>=4||p.bytes>4*1024*1024)throw fail(429,'resource-limit');p.events.push(result);const terminal=isTerminal(result.task)||['TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED'].includes(result.statusUpdate?.status?.state);if(!terminal)return;}
      clearTimeout(p.timer);socket.pending.delete(message.id);if(takeFault('drop-response')){socket.terminate();p.no(fail(503,'dropped-response'));return;}p.yes(p.events.length?p.events:result);
    }catch{socket.close(1002);}});
  });
  const controller=httpServer(async(request,response)=>{try{
    if(!same(request.headers.authorization,`Bearer ${controlSecret}`))throw fail(401,'unauthenticated');const path=new URL(request.url,'http://control').pathname;
    if(path==='/stats'){json(response,200,{schemaVersion:1,ready,clients:[...clients.values()].map(c=>c.identity.principal),activeConnections:wss.clients.size,counts,modelInputs,calls:db.prepare('SELECT message_id,tenant,task_id FROM calls').all(),results:db.prepare('SELECT task_id,digest,confirmed,consumed FROM results').all(),diagnostics:db.prepare('SELECT upload_id,digest,thread_id,diagnostic_id FROM diagnostics').all()});return;}
    if(path==='/call'&&request.method==='POST'){json(response,200,{schemaVersion:1,value:await call(await body(request))});return;}
    if(path==='/recover'&&request.method==='POST'){let recovered=0;for(const row of db.prepare('SELECT * FROM calls').all()){const original=JSON.parse(row.request);await call({installationId:row.installation,method:row.task_id?'GetTask':original.method,params:row.task_id?{tenant:row.tenant,id:row.task_id}:original.params});recovered++;}json(response,200,{schemaVersion:1,recovered});return;}
    if(path==='/fault'&&request.method==='POST'){
      const command=await body(request),allowed=['missing-version','wrong-version','missing-extension','delay-handshake','bad-package','half-package','drop-response','drop-receipt','result-storage','release-storage','diagnostic-storage','diagnostic-pending','diagnostic-response-loss','diagnostic-wrong-receipt','disconnect','pause-read','invalid-json','binary','notification'];if(!allowed.includes(command.name))throw fail(400,'invalid-fault');
      const durationMs=command.durationMs??5000,count=command.count??1;if(!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>30000||!Number.isSafeInteger(count)||count<1||count>16)throw fail(400,'invalid-fault');
      if(['disconnect','pause-read','invalid-json','binary','notification'].includes(command.name)){for(const socket of clients.values()){if(command.name==='disconnect')socket.terminate();if(command.name==='pause-read'){socket.pause();setTimeout(()=>socket.resume(),durationMs).unref();}if(command.name==='invalid-json')socket.send('{');if(command.name==='binary')socket.send(Buffer.from([0,1]));if(command.name==='notification')socket.send(JSON.stringify({jsonrpc:'2.0',method:'GetTask',params:{}}));}}
      else faults.set(command.name,{remaining:count,until:Date.now()+(command.name==='delay-handshake'?30000:durationMs),durationMs});json(response,200,{schemaVersion:1,injected:command.name});return;
    }
    throw fail(404,'not-found');
  }catch(error){json(response,error.status??500,{error:{code:error.code??'temporarily-unavailable',message:'Control request failed.',...(error.rpcError?{rpcError:error.rpcError}:{})}});}});
  owned.push(async()=>{controller.closeAllConnections();await new Promise(yes=>controller.close(()=>yes()));});
  await new Promise((yes,no)=>{business.once('error',no);business.listen(config.listen.port,config.listen.host,yes);});if(new URL(origin).port==='0')origin=`https://localhost:${business.address().port}`;
  await new Promise((yes,no)=>{controller.once('error',no);controller.listen(config.control.port,config.control.host,yes);});
  const ready={schemaVersion:1,publicOrigin:origin,controlOrigin:`http://${config.control.host==='::1'?'[::1]':config.control.host}:${controller.address().port}`,fixtureSetId:fixture.fixtureSetId,fixtureManifestSha256:sha256(fixtureText),defaultTenant:`agent/${fixture.agents[0].id}/${fixture.agents[0].contentId}`,modelBaseURL:['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)?fixtureOrigin+'/v1':origin+'/v1',model:'verification-model',mcpURL:origin+'/mcp',siteURL};
  const portsFile=join(config.dataRoot,'ports.json'),temporaryPorts=join(config.dataRoot,`.ports-${randomUUID()}`);await syncFile(temporaryPorts,JSON.stringify({public:business.address().port,control:controller.address().port,fixtures:fixtures.address().port}));await rename(temporaryPorts,portsFile);
  let closeWork;
  async function close(){return closeWork??=(async()=>{closing=true;for(const socket of clients.values())socket.terminate();for(const socket of sockets)socket.destroy();await Promise.allSettled([...sessions.values()].map(s=>s.server.close()));for(const server of [business,controller,fixtures]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await new Promise(resolve=>wss.close(resolve));db.close();})();}
  return {ready,close};
  } catch(error) { await Promise.allSettled(owned.reverse().map(cleanup=>cleanup())); throw error; }
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  try{const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw fail(400,'invalid-config');const service=await startVerificationService(args[1]);console.log(JSON.stringify({event:'ready',...service.ready}));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{const timer=setTimeout(()=>process.exit(1),3000);timer.unref();void service.close().then(()=>{clearTimeout(timer);process.exitCode=0;},()=>{clearTimeout(timer);process.exitCode=1;});});}
  catch(error){process.stderr.write(JSON.stringify({error:{code:error.code??'startup-failed',message:'Verification service could not start.'}})+'\n');process.exitCode=2;}
}
