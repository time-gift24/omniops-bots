import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, isIP } from 'node:net';
import { mkdir, writeFile, readdir, realpath } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageDigest, sha256 } from './protocol.mjs';

/** Generate isolated test data and a two-day localhost certificate; no key is checked into Git. */
export async function initialize(directory, { publicOrigin } = {}) {
  if (!isAbsolute(directory)) throw new Error('The verification directory must be absolute.');
  await mkdir(directory,{recursive:true,mode:0o700});
  directory=await realpath(directory);
  if((await readdir(directory)).length)throw new Error('The verification directory must be empty.');
  let configuredOrigin;if(publicOrigin!==undefined){const value=new URL(publicOrigin);if(value.protocol!=='https:'||value.username||value.password||value.pathname!=='/'||value.search||value.hash||value.port==='0')throw new Error('Public origin must be an HTTPS origin with a fixed port.');configuredOrigin=value;}
  const certFile=join(directory,'localhost.pem'),keyFile=join(directory,'localhost-key.pem'),certificateHost=configuredOrigin?.hostname.replace(/^\[|\]$/gu,'');
  await new Promise((done,reject)=>{
    const p=spawn('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','2','-subj',`/CN=${configuredOrigin?.hostname??'localhost'}`,'-addext',configuredOrigin?`subjectAltName=${isIP(certificateHost)?'IP':'DNS'}:${certificateHost}`:'subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:['ignore','ignore','ignore']});
    p.once('error',reject);p.once('exit',code=>code===0?done():reject(new Error('Cannot create the test TLS certificate.')));
  });
  const reservation=createServer();await new Promise((yes,no)=>{reservation.once('error',no);reservation.listen(0,'127.0.0.1',yes);});const publicPort=configuredOrigin?Number(configuredOrigin.port||443):reservation.address().port;await new Promise(yes=>reservation.close(yes));
  // Fixed fixture origin is part of the immutable Agent; a port collision fails startup explicitly.
  const fixtureRoot=join(directory,'fixtures');await mkdir(fixtureRoot,{mode:0o700});
  const skillFiles=[{path:'SKILL.md',kind:'file',data:Buffer.from('---\nname: verification\ndescription: Isolated verification skill.\n---\nUse only the configured test site.\n')},{path:'references',kind:'folder'},{path:'references/reference.bin',kind:'file',data:Buffer.from([0,1,2,255])},{path:'empty',kind:'folder'}];
  const skillId='verification-skill', skillHash=packageDigest(skillFiles);
  const manifest={schemaVersion:1,fixtureSetId:'desktop-verification-v1',agents:[],skills:[],files:[]};
  async function store(kind,id,files,tag){
    const contentId=packageDigest(files),relative=`${kind}/${id}/${contentId}`,directory=join(fixtureRoot,relative);await mkdir(directory,{recursive:true,mode:0o700});
    const list=[];
    for(const item of files){const file=join(directory,item.path);if(item.kind==='folder'){await mkdir(file,{recursive:true});list.push({path:item.path,kind:'folder'});}else{await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,item.data);list.push({path:item.path,kind:'file',bytes:item.data.length,sha256:sha256(item.data)});}}
    const entry={id,contentId,releaseTag:tag,directory:relative,files:list};manifest[kind].push(entry);return entry;
  }
  await store('skills',skillId,skillFiles,'v.1.0.0');
  for(let version=1;version<=2;version++){
    const config={schemaVersion:1,name:`Verification Agent ${version}`,description:'Only uses isolated deterministic fixture data.',promptFile:'prompt.md',toolIds:['inspect_browser','write_playwright_script','read_playwright_script','run_playwright_script','list_playwright_scripts'],mcpServers:[{id:'verification',name:'Verification MCP',description:'Deterministic local verification tools.',url:`${configuredOrigin?.origin??`https://localhost:${publicPort}`}/mcp`}],skills:[{skillId,contentId:skillHash,mountPath:'/skills/verification/'}]};
    await store('agents','verification-agent',[{path:'agent.json',kind:'file',data:Buffer.from(JSON.stringify(config,null,2)+'\n')},{path:'prompt.md',kind:'file',data:Buffer.from(`You are an isolated test Agent, revision ${version}. Return exactly one JSON value; use tools only for fixture browser tasks.\n`)}],`v.1.0.${version-1}`);
  }
  const fixtureManifest=join(fixtureRoot,'manifest.json');await writeFile(fixtureManifest,JSON.stringify(manifest,null,2)+'\n');
  const tokenFile=join(directory,'token.txt'),secretFile=join(directory,'control-token.txt');await writeFile(tokenFile,randomBytes(24).toString('hex')+'\n',{mode:0o600});await writeFile(secretFile,randomBytes(24).toString('hex')+'\n',{mode:0o600});
  const readerTokenFile=join(directory,'reader-token.txt'),expiredTokenFile=join(directory,'expired-token.txt');for(const file of [readerTokenFile,expiredTokenFile])await writeFile(file,randomBytes(24).toString('hex')+'\n',{mode:0o600});
  const config={schemaVersion:1,listen:{host:configuredOrigin?.hostname.includes(':')?'::':configuredOrigin?'0.0.0.0':'127.0.0.1',port:publicPort},publicOrigin:configuredOrigin?.origin??`https://localhost:${publicPort}`,tls:{certFile,keyFile},dataRoot:join(directory,'service-data'),fixtureRoot,identities:[{tokenFile,principal:{organizationId:'verification-org',callerId:'verification-caller',installationId:'verification-installation'},permissions:['official-read','official-maintain','task-call','diagnostic-own','diagnostic-read'],expiresAt:new Date(Date.now()+86400000).toISOString()},{tokenFile:readerTokenFile,principal:{organizationId:'verification-org',callerId:'verification-reader',installationId:'verification-reader-installation'},permissions:['official-read'],expiresAt:new Date(Date.now()+86400000).toISOString()},{tokenFile:expiredTokenFile,principal:{organizationId:'verification-org',callerId:'verification-expired',installationId:'verification-expired-installation'},permissions:['official-read','task-call'],expiresAt:new Date(Date.now()-1000).toISOString()}],control:{host:'127.0.0.1',port:0,secretFile}};
  const configFile=join(directory,'service.json');await writeFile(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  const verify={schemaVersion:1,target:process.platform==='win32'?'windows-x86_64':'darwin-aarch64',peer:{mode:'managed',configFile},fixtureManifest,fixtureTokenFile:tokenFile,trustedCaFile:certFile,runtime:{nodeExecutable:process.execPath,directory:resolve(import.meta.dirname,'../runtime')},isolatedRoot:join(directory,'runs'),reportRoot:join(directory,'reports')};
  const verifyFile=join(directory,'verify.json');await writeFile(verifyFile,JSON.stringify(verify,null,2)+'\n',{mode:0o600});
  return {configFile,verifyFile,fixtureManifest,trustedCaFile:certFile};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  try{const args=process.argv.slice(2);if(args.length%2||args.some((value,index)=>index%2===0&&!['--directory','--public-origin'].includes(value))||args[0]!=='--directory')throw new Error('Usage: node init.mjs --directory /absolute/empty-directory [--public-origin https://fixture-host:port]');console.log(JSON.stringify(await initialize(args[1],{publicOrigin:args.includes('--public-origin')?args[args.indexOf('--public-origin')+1]:undefined})));}
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=2;}
}
