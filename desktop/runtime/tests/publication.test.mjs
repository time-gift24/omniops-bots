import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { test } from 'node:test';
import { initialize } from '../../verification/init.mjs';
import { startVerificationService } from '../../verification/server.mjs';
import { createPlatformClient } from '../platform.ts';
import { createResources } from '../resources.ts';
import { createPublications } from '../publication.ts';
import { RuntimeError } from '../errors.ts';

const data=text=>Buffer.from(text).toString('base64');
async function writable(file){const info=await lstat(file);if(info.isDirectory()&&!info.isSymbolicLink()){await chmod(file,0o700);for(const name of await readdir(file))await writable(path.join(file,name));}}
async function fixture(action){
  const root=await mkdtemp(path.join(tmpdir(),'omniops-publication-')),authorities=getCACertificates('default');
  let server,platform;
  try{
    const paths=await initialize(path.join(root,'peer')),config=JSON.parse(await readFile(paths.configFile,'utf8'));
    setDefaultCACertificates([...authorities,await readFile(paths.trustedCaFile,'utf8')]);
    server=await startVerificationService(paths.configFile);
    let token=(await readFile(config.identities[0].tokenFile,'utf8')).trim();
    platform=createPlatformClient({baseUrl:server.ready.publicOrigin,allowedDownloadOrigins:[server.ready.publicOrigin],getAuthorization:async()=>`Bearer ${token}`});
    await action({root,platform,config,setToken:value=>{token=value;}});
  }finally{
    await platform?.close({deadline:performance.now()+1000});await server?.close();
    setDefaultCACertificates(authorities);await writable(root);await rm(root,{recursive:true,force:true});
  }
}

test('real HTTPS publication preserves frozen bytes and original keys after unknown replies; history produces independent copies',{timeout:20000},async()=>fixture(async({root,platform,config,setToken})=>{
  const catalog=new Map([['probe',{id:'probe',name:'Probe',description:'Fixed MCP',url:'https://mcp.example.test/original',credentialEnv:'TEST_MCP_TOKEN'}]]);
  const mcpCatalog={list:()=>[...catalog.values()],get:id=>catalog.get(id),save:async server=>{catalog.set(server.id,server);},remove:async id=>{catalog.delete(id);}};
  const resources=createResources({homeDir:root,platform,mcpCatalog}),directory=path.join(root,'publications');
  let loseCreate=true,loseUpload=true,losePublish=true;
  const transport={...platform,async createResource(...args){const result=await platform.createResource(...args);if(loseCreate){loseCreate=false;throw new RuntimeError('network','Fixture reply lost after commit.');}return result;},async uploadDraft(...args){const result=await platform.uploadDraft(...args);if(loseUpload){loseUpload=false;throw new RuntimeError('network','Fixture reply lost after commit.');}return result;},async publish(...args){const result=await platform.publish(...args);if(losePublish){losePublish=false;throw new RuntimeError('network','Fixture reply lost after commit.');}return result;}};
  let publications=createPublications({directory,resources,platform:transport});
  const call=(method,params)=>publications.handle(method,params);
  const original='---\nname: frozen-skill\ndescription: Frozen package.\n---\nOriginal bytes.\r\n';
  const skill=await resources.handle('skill_library_create',{name:'frozen-skill',content:original,entries:[{path:'empty',kind:'folder'},{path:'assets',kind:'folder'}]});
  await resources.handle('skill_library_write',{id:skill.id,path:'assets/probe.bin',data:data(Buffer.from([0,255,1]))});
  await assert.rejects(call('resource_prepare',{kind:'skill',id:skill.id,createOfficial:true}),{kind:'network'});
  let prepared=(await call('resource_publication_operations',{kind:'skill',localId:skill.id})).items[0];
  assert.equal(prepared.expectedRevision,null);assert.equal(prepared.phase,'prepared');assert.equal(prepared.officialId,null);
  await resources.handle('skill_library_write',{id:skill.id,path:'SKILL.md',data:data(original.replace('Original','Changed locally')),replace:true});
  await assert.rejects(call('resource_upload_draft',{operationId:prepared.operationId}),{kind:'network'});
  await publications.close({deadline:performance.now()+1000});
  publications=createPublications({directory,resources,platform:transport});
  const restored=(await call('resource_publication_operations',{kind:'skill',localId:skill.id})).items[0];
  prepared=restored;assert.ok(prepared.officialId);assert.equal((await platform.catalog({kind:'skill'})).items.length,2);
  assert.equal(restored.contentId,prepared.contentId);assert.equal(restored.phase,'prepared');
  const uploaded=await call('resource_upload_draft',{operationId:restored.operationId});
  assert.equal(uploaded.phase,'uploaded');assert.equal(uploaded.contentId,prepared.contentId);
  const drafts=await platform.drafts({kind:'skill',id:prepared.officialId});
  assert.equal(drafts.items.length,1);assert.equal(drafts.head,uploaded.revision);
  const preview=await call('resource_publish_preview',{operationId:prepared.operationId});assert.deepEqual(preview.affectedAgents,[]);
  await assert.rejects(call('resource_publish',{operationId:prepared.operationId,releaseTag:'v.1.0.0'}),{kind:'network'});
  await publications.close({deadline:performance.now()+1000});
  publications=createPublications({directory,resources,platform:transport});
  const retry=(await call('resource_publication_operations',{})).items[0];
  assert.deepEqual(retry.publication,{releaseTag:'v.1.0.0',affectedAgents:[]});
  await assert.rejects(call('resource_publish',{operationId:retry.operationId,releaseTag:'v.1.0.1'}),{kind:'idempotency-conflict'});
  const published=await call('resource_publish',{operationId:retry.operationId,...retry.publication});
  assert.equal(published.phase,'published');assert.equal((await call('resource_versions',{kind:'skill',id:prepared.officialId})).items.length,1);
  const selected=await call('resource_select_history',{kind:'skill',id:prepared.officialId,contentId:prepared.contentId});
  assert.equal(selected.skill.readOnly,true);
  assert.equal(Buffer.from((await resources.handle('skill_library_read',{id:selected.skill.id,path:'SKILL.md'})).data,'base64').toString(),original);
  assert.deepEqual(Buffer.from((await resources.handle('skill_library_read',{id:selected.skill.id,path:'assets/probe.bin'})).data,'base64'),Buffer.from([0,255,1]));
  assert.ok(selected.skill.entries.some(entry=>entry.path==='empty'&&entry.kind==='folder'));
  const copy=await call('resource_select_history',{kind:'skill',id:prepared.officialId,contentId:prepared.contentId,editable:true});
  assert.equal(copy.skill.readOnly,false);assert.notEqual(copy.localId,skill.id);
  await resources.handle('skill_library_write',{id:copy.localId,path:'SKILL.md',data:data('Independent local edit.'),replace:true});
  assert.equal(Buffer.from((await resources.handle('skill_library_read',{id:selected.skill.id,path:'SKILL.md'})).data,'base64').toString(),original);
  const agent=await resources.handle('agent_create',{configuration:{name:'Published operator',description:'Frozen dependencies',instructions:'Exact prompt.\r\n',toolIds:[],skillIds:[selected.skill.id],mcpServerIds:['probe']}});
  await resources.handle('agent_save',{id:agent.id,configuration:agent.configuration});
  const agentDraft=await call('resource_prepare',{kind:'agent',id:agent.id,createOfficial:true});
  assert.deepEqual(agentDraft.files.map(file=>file.path).sort(),['agent.json','prompt.md']);
  await call('resource_upload_draft',{operationId:agentDraft.operationId});
  assert.equal((await call('resource_publish_preview',{operationId:agentDraft.operationId})).expectedContentId,null);
  await call('resource_publish',{operationId:agentDraft.operationId,releaseTag:'v.1.0.0'});
  catalog.set('probe',{...catalog.get('probe'),url:'https://mcp.example.test/changed'});
  const formal=await call('resource_select_history',{kind:'agent',id:agentDraft.officialId,contentId:agentDraft.contentId});
  assert.equal(formal.agent.configuration.instructions,'Exact prompt.\r\n');assert.equal(formal.agent.source,'official');
  const working=await call('resource_select_history',{kind:'agent',id:agentDraft.officialId,contentId:agentDraft.contentId,editable:true});
  assert.equal(working.agent.source,'local');assert.notEqual(working.agent.configuration.mcpServerIds[0],'probe');
  assert.equal(catalog.get(working.agent.configuration.mcpServerIds[0]).url,'https://mcp.example.test/original');
  const session=await resources.prepareSession({sessionId:'explicit-history',agentId:agentDraft.officialId,contentId:agentDraft.contentId});
  assert.equal(session.agent.contentId,agentDraft.contentId);assert.equal(session.mcpServers[0].url,'https://mcp.example.test/original');
  // An ordinary reader cannot recover or mutate another principal's prepared operation.
  setToken((await readFile(config.identities[1].tokenFile,'utf8')).trim());
  await assert.rejects(call('resource_publication_operations',{}),{kind:'forbidden'});
  assert.equal((await call('resource_versions',{kind:'agent',id:agentDraft.officialId})).items.length,1);
  await assert.rejects(call('resource_select_history',{kind:'agent',id:agentDraft.officialId,contentId:agentDraft.contentId,editable:true}),{kind:'forbidden'});
  await publications.close({deadline:performance.now()+1000});
}));

test('publication rejects arbitrary paths, stale revisions and incomplete linked releases without replacing saved sources',{timeout:15000},async()=>fixture(async({root,platform})=>{
  const resources=createResources({homeDir:root,platform}),directory=path.join(root,'publications'),publications=createPublications({directory,resources,platform});
  try{
    const versions=await platform.versions({kind:'skill',id:'verification-skill'}),contentId=versions.items[0].contentId;
    const local=await publications.handle('resource_select_history',{kind:'skill',id:'verification-skill',contentId,editable:true});
    const write='---\nname: verification\ndescription: Updated fixture.\n---\nNew fixed bytes.\n';
    await resources.handle('skill_library_write',{id:local.localId,path:'SKILL.md',data:data(write),replace:true});
    await assert.rejects(publications.handle('resource_prepare',{kind:'skill',id:local.localId,directory:'/tmp/other'}),{kind:'invalid-request'});
    const first=await publications.handle('resource_prepare',{kind:'skill',id:local.localId,expectedRevision:null});
    const stale=await publications.handle('resource_prepare',{kind:'skill',id:local.localId,expectedRevision:null});
    await publications.handle('resource_upload_draft',{operationId:first.operationId});
    await assert.rejects(publications.handle('resource_upload_draft',{operationId:stale.operationId}),{kind:'revision-conflict'});
    const preview=await publications.handle('resource_publish_preview',{operationId:first.operationId});assert.equal(preview.affectedAgents.length,1);
    await assert.rejects(publications.handle('resource_publish',{operationId:first.operationId,releaseTag:'v.2.0.0',affectedAgents:[]}),{kind:'invalid-request'});
    const release=await publications.handle('resource_publish',{operationId:first.operationId,releaseTag:'v.2.0.0',affectedAgents:preview.affectedAgents.map(item=>({...item,releaseTag:'v.2.0.0'}))});
    assert.equal(release.release.versions.length,2);
    assert.equal(Buffer.from((await resources.handle('skill_library_read',{id:local.localId,path:'SKILL.md'})).data,'base64').toString(),write);
    await assert.rejects(resources.selectResourceVersion({kind:'skill',id:'verification-skill',contentId:'x'+contentId+'x'}),{kind:'invalid-request'});
  }finally{await publications.close({deadline:performance.now()+1000});}
}));
