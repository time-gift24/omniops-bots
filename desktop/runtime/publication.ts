import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { canonicalize } from 'json-canonicalize';
import { RuntimeError, invalid } from './errors.ts';
import { writeJson } from './json-store.ts';
import { packageContentId, readPackage, writePackageFiles, type PackageEntry } from './package.ts';
import type { PlatformClient, SkillRelease, AgentRelease } from './platform.ts';
import type { createResources } from './resources.ts';

const stableId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u).refine(value=>!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(value));
const text=z.string().min(1).max(4096).refine(value=>!/[\x00-\x1f\x7f]/u.test(value));
const digest=z.string().regex(/^[a-f0-9]{64}$/u);
const kind=z.enum(['agent','skill']);
const label=z.string().regex(/^v\.\d+\.\d+\.\d+$/u);
const affectedSchema=z.object({agentId:stableId,expectedContentId:digest,releaseTag:label}).strict();
const previewSchema=z.object({kind,contentId:digest,baseline:text.optional(),expectedContentId:digest.nullable(),affectedAgents:z.array(z.object({agentId:stableId,expectedContentId:digest}).strict()).max(256)}).strict();
const releaseSchema=z.object({schemaVersion:z.literal(1),releaseId:stableId,versions:z.array(z.object({kind,id:stableId,contentId:digest,releaseTag:label}).strict()).max(257)}).strict();
const operationSchema=z.object({
  schemaVersion:z.literal(1),operationId:z.string().uuid(),owner:digest,kind,localId:text,name:text,
  officialId:stableId.nullable(),createOfficial:z.boolean(),createKey:z.string().uuid(),uploadKey:z.string().uuid(),publishKey:z.string().uuid(),
  contentId:digest,expectedRevision:text.nullable(),discoverRevision:z.boolean(),phase:z.enum(['prepared','uploaded','published']),
  files:z.array(z.object({path:text,kind:z.enum(['file','folder']),bytes:z.number().int().nonnegative().optional(),sha256:digest.optional()}).strict()).max(1000),
  packageBytes:z.number().int().nonnegative().max(100*1024*1024),createdAt:z.string().datetime({offset:true}),
  draftRevisionId:stableId.optional(),revision:text.optional(),preview:previewSchema.optional(),
  publication:z.object({releaseTag:label,affectedAgents:z.array(affectedSchema).max(256)}).strict().optional(),
  release:releaseSchema.optional(),
}).strict();
type Operation=z.infer<typeof operationSchema>;
export type PreparedPublication=Pick<Operation,'operationId'|'kind'|'localId'|'officialId'|'contentId'|'phase'|'files'|'createdAt'|'expectedRevision'|'draftRevisionId'|'revision'|'preview'|'publication'|'release'>;
type ResourceAccess=Pick<ReturnType<typeof createResources>,'captureResource'|'selectResourceVersion'>;
type PlatformAccess=Pick<PlatformClient,'session'|'createResource'|'uploadDraft'|'previewSkillRelease'|'publish'|'versions'|'catalog'|'drafts'>;
type CallOptions={signal?:AbortSignal};
const METHODS=new Set(['resource_prepare','resource_upload_draft','resource_publish_preview','resource_publish','resource_versions','resource_select_history','resource_publication_operations']);
const bindingSchema=z.object({schemaVersion:z.literal(1),items:z.array(z.object({owner:digest,kind,localId:text,officialId:stableId}).strict()).max(1000)}).strict();
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const parsed=schema.safeParse(value);if(!parsed.success)throw invalid('资源发布参数或保存记录无效。');return parsed.data;}
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const filesFor=(entries:PackageEntry[])=>entries.map(entry=>entry.kind==='folder'?{path:entry.path,kind:entry.kind}:{path:entry.path,kind:entry.kind,bytes:entry.bytes!.byteLength,sha256:sha(entry.bytes!)});
function summary(value:Operation):PreparedPublication {
  const {operationId,kind,localId,officialId,contentId,phase,files,createdAt,expectedRevision,draftRevisionId,revision,preview,publication,release}=value;
  return structuredClone({operationId,kind,localId,officialId,contentId,phase,files,createdAt,expectedRevision,...(draftRevisionId?{draftRevisionId}:{}),...(revision?{revision}:{}),...(preview?{preview}:{}),...(publication?{publication}:{}),...(release?{release}:{})});
}
async function readJson(file:string):Promise<unknown>{
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>2*1024*1024)throw invalid('发布记录文件无效。');
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const buffer=Buffer.alloc(info.size+1);let count=0;
    while(count<buffer.length){const next=await handle.read(buffer,count,buffer.length-count,count);if(!next.bytesRead)break;count+=next.bytesRead;}
    if(count!==info.size)throw invalid('发布记录在读取期间改变。');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count)));
  }finally{await handle.close();}
}
async function writable(folder:string):Promise<void>{
  const info=await lstat(folder);
  if(!info.isDirectory()||info.isSymbolicLink())return;
  await chmod(folder,0o700);
  for(const child of await readdir(folder))await writable(path.join(folder,child));
}
async function readonly(folder:string):Promise<void>{
  for(const child of await readdir(folder,{withFileTypes:true})){
    const file=path.join(folder,child.name);
    if(child.isDirectory())await readonly(file);else await chmod(file,0o400);
  }
  await chmod(folder,0o500);
}

/** Durable publication boundary; captures only saved resources, never accepts arbitrary filesystem paths over IPC.
 * const publications=createPublications({directory:path.join(localRoot,'publications'),resources,platform});
 * const draft=await publications.handle('resource_prepare',{kind:'skill',id:localId,createOfficial:true});
 * await publications.handle('resource_upload_draft',{operationId:draft.operationId});
 * Commands: resource_prepare({kind,id,officialId?,createOfficial?,expectedRevision?:string|null}) freezes saved
 * bytes and returns PreparedPublication; omitted expectedRevision reads the server draft head, null asserts none.
 * resource_upload_draft({operationId}) returns the same operation with its immutable draft revision.
 * resource_publish_preview({operationId}) returns {kind,contentId,baseline?,expectedContentId,affectedAgents}.
 * resource_publish({operationId,releaseTag,affectedAgents?:[{agentId,expectedContentId,releaseTag}]}) returns
 * PreparedPublication with its receipt. The complete baseline and tags are fixed before the first submission.
 * resource_publication_operations({kind?,localId?}) returns {items:PreparedPublication[]} for restart recovery.
 * resource_versions({kind,id,cursor?,limit?}) returns a bounded platform versions page.
 * resource_select_history({kind,id,contentId,editable?}) returns an exact read-only Agent/Skill DTO, or an
 * independent local editable copy with localId. Copies retain an owner-scoped official-resource association.
 * handle(method,params,{signal}?) rejects RuntimeError (invalid-request/forbidden/storage/conflict/aborted).
 * Every write serializes within this module; directory must have one native data-root owner. close aborts owned
 * network waits within its shared deadline and never closes borrowed resources/platform.
 */
export function createPublications({directory,resources,platform}:{directory:string;resources:ResourceAccess;platform:PlatformAccess}) {
  if(typeof directory!=='string'||!path.isAbsolute(directory)||!resources||typeof resources.captureResource!=='function'||typeof resources.selectResourceVersion!=='function'||!platform||(['session','createResource','uploadDraft','previewSkillRelease','publish','versions','catalog','drafts'] as const).some(method=>typeof platform[method]!=='function'))throw invalid('资源发布入口配置无效。');
  const closing=new AbortController();let tail=Promise.resolve<unknown>(undefined),queued=0;
  async function root():Promise<string>{
    await mkdir(directory,{recursive:true,mode:0o700});
    if((await lstat(directory)).isSymbolicLink())throw invalid('发布数据目录不能是链接。');
    return realpath(directory);
  }
  async function owner(signal:AbortSignal,maintain:boolean):Promise<string>{
    const session=await platform.session({signal});
    if(!session.permissions.includes(maintain?'official-maintain':'official-read'))throw new RuntimeError('forbidden','当前账号没有相应官方资源权限。');
    return sha(canonicalize([session.organizationId,session.callerId,session.installationId]));
  }
  async function bindings(root:string){
    try{return parse(bindingSchema,await readJson(path.join(root,'bindings.json')));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {schemaVersion:1 as const,items:[] as z.infer<typeof bindingSchema>['items']};throw error;}
  }
  async function bind(root:string,scope:string,kind:'agent'|'skill',localId:string,officialId:string){
    const value=await bindings(root),items=value.items.filter(item=>!(item.owner===scope&&item.kind===kind&&item.localId===localId));
    if(items.length>=1000)throw new RuntimeError('resource-limit','本地发布关联已达上限。');
    await writeJson(path.join(root,'bindings.json'),{schemaVersion:1,items:[...items,{owner:scope,kind,localId,officialId}]});
  }
  async function load(root:string,operationId:string,scope:string){
    parse(z.string().uuid(),operationId);
    const folder=path.join(root,operationId);
    if((await lstat(folder)).isSymbolicLink())throw invalid('发布操作目录不能是链接。');
    const value=parse(operationSchema,await readJson(path.join(folder,'operation.json')));
    if(value.operationId!==operationId||value.owner!==scope)throw new RuntimeError('forbidden','当前账号不能访问此发布操作。');
    return value;
  }
  const save=(root:string,value:Operation)=>writeJson(path.join(root,value.operationId,'operation.json'),value);
  async function ensureIdentity(root:string,value:Operation,signal:AbortSignal){
    if(!value.officialId){
      if(!value.createOfficial)throw invalid('请先明确创建官方资源，或填写已有官方资源身份。');
      const identity=await platform.createResource({kind:value.kind,name:value.name,idempotencyKey:value.createKey},{signal});
      value.officialId=identity.id;
      await save(root,value);
    }
    await bind(root,value.owner,value.kind,value.localId,value.officialId);
    if(value.discoverRevision){value.expectedRevision=(await platform.drafts({kind:value.kind,id:value.officialId,limit:1},{signal})).head;value.discoverRevision=false;await save(root,value);}
    return value.officialId;
  }
  async function currentContent(kind:'agent'|'skill',id:string,signal:AbortSignal):Promise<string|null>{
    let cursor:string|undefined;const cursors=new Set<string>();
    for(let count=0;count<10;count++){
      const page=await platform.catalog({kind,limit:100,...(cursor?{cursor}:{})},{signal});
      const found=page.items.find(item=>item.id===id);if(found)return found.contentId;
      if(!page.nextCursor)break;
      if(cursors.has(page.nextCursor))throw invalid('官方目录分页游标重复。');cursors.add(page.nextCursor);cursor=page.nextCursor;
    }
    throw new RuntimeError('not-found','官方资源不存在或没有读取权限。');
  }
  async function perform(method:string,params:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
    if(method==='resource_versions'){
      const input=parse(z.object({kind,id:stableId,cursor:text.optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),params);
      await owner(signal,false);return platform.versions(input,{signal});
    }
    if(method==='resource_select_history'){
      const input=parse(z.object({kind,id:stableId,contentId:digest,editable:z.boolean().optional()}).strict(),params);
      const scope=await owner(signal,Boolean(input.editable));
      const selected=await resources.selectResourceVersion(input,{signal});
      if(selected.localId)await bind(await root(),scope,input.kind,selected.localId,input.id);
      return selected;
    }
    const scope=await owner(signal,true),base=await root();
    if(method==='resource_publication_operations'){
      const input=parse(z.object({kind:kind.optional(),localId:text.optional()}).strict(),params),items:PreparedPublication[]=[];
      for(const name of await readdir(base))if(z.string().uuid().safeParse(name).success){
        const value=parse(operationSchema,await readJson(path.join(base,name,'operation.json')));
        if(value.operationId!==name)throw invalid('发布操作记录身份不匹配。');
        if(value.owner===scope&&(!input.kind||value.kind===input.kind)&&(!input.localId||value.localId===input.localId))items.push(summary(value));
      }
      return {items:items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100)};
    }
    if(method==='resource_prepare'){
      const input=parse(z.object({kind,id:text,officialId:stableId.optional(),createOfficial:z.boolean().optional(),expectedRevision:text.nullable().optional()}).strict(),params);
      if(input.createOfficial&&input.officialId)throw invalid('新建官方身份与已有官方身份不能同时选择。');
      const linked=await bindings(base),binding=linked.items.find(item=>item.owner===scope&&item.kind===input.kind&&item.localId===input.id);
      const officialSkills=Object.fromEntries(linked.items.filter(item=>item.owner===scope&&item.kind==='skill').map(item=>[item.localId,item.officialId]));
      const captured=await resources.captureResource({kind:input.kind,id:input.id},{signal,officialSkills});
      const records=[];for(const name of await readdir(base))if(z.string().uuid().safeParse(name).success)records.push(parse(operationSchema,await readJson(path.join(base,name,'operation.json'))));
      const packageBytes=captured.entries.reduce((total,item)=>total+(item.bytes?.byteLength??0),0);
      if(records.length>=1000||records.reduce((total,item)=>total+item.packageBytes,0)+packageBytes>1024*1024*1024)throw new RuntimeError('resource-limit','发布快照容量已达上限，请保留材料并清理已完成历史。');
      const value:Operation={schemaVersion:1,operationId:randomUUID(),owner:scope,kind:input.kind,localId:input.id,name:captured.name,officialId:input.officialId??(!input.createOfficial?binding?.officialId:null)??null,createOfficial:Boolean(input.createOfficial),createKey:randomUUID(),uploadKey:randomUUID(),publishKey:randomUUID(),contentId:captured.contentId,expectedRevision:input.expectedRevision??null,discoverRevision:input.expectedRevision===undefined,phase:'prepared',files:filesFor(captured.entries),packageBytes,createdAt:new Date().toISOString()};
      const staging=await mkdtemp(path.join(base,'.pending-'));
      try{
        const packageDir=path.join(staging,'package');await mkdir(packageDir,{mode:0o700});
        await writePackageFiles(captured.entries,packageDir,{signal});await readonly(packageDir);
        await writeJson(path.join(staging,'operation.json'),value);
        signal.throwIfAborted();await rename(staging,path.join(base,value.operationId));
      }finally{try{await writable(staging);await rm(staging,{recursive:true,force:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      if(value.createOfficial||value.officialId)await ensureIdentity(base,value,signal);
      return summary(value);
    }
    const operationId=parse(z.string().uuid(),params.operationId),value=await load(base,operationId,scope);
    if(method==='resource_upload_draft'){
      parse(z.object({operationId:z.string().uuid()}).strict(),params);
      if(value.phase!=='prepared')return summary(value);
      const officialId=await ensureIdentity(base,value,signal),directory=path.join(base,value.operationId,'package');
      if(packageContentId(await readPackage(directory,{signal}))!==value.contentId)throw new RuntimeError('integrity','冻结的发布材料已改变。');
      const revision=await platform.uploadDraft({kind:value.kind,id:officialId,directory,contentId:value.contentId,expectedRevision:value.expectedRevision,idempotencyKey:value.uploadKey},{signal});
      if(revision.contentId!==value.contentId)throw new RuntimeError('integrity','草稿接收摘要不匹配。');
      value.draftRevisionId=revision.draftRevisionId;value.revision=revision.revision;value.phase='uploaded';await save(base,value);return summary(value);
    }
    if(method==='resource_publish_preview'){
      parse(z.object({operationId:z.string().uuid()}).strict(),params);
      if(!value.draftRevisionId||!value.officialId)throw invalid('请先上传这份确定的草稿修订。');
      if(value.publication&&value.preview)return value.preview;
      if(value.kind==='skill'){
        const preview=await platform.previewSkillRelease({skillId:value.officialId,draftRevisionId:value.draftRevisionId},{signal});
        if(preview.contentId!==value.contentId)throw new RuntimeError('integrity','发布预览摘要不匹配。');
        value.preview={kind:'skill',contentId:value.contentId,baseline:preview.baseline,expectedContentId:null,affectedAgents:preview.affectedAgents};
      }else value.preview={kind:'agent',contentId:value.contentId,expectedContentId:await currentContent('agent',value.officialId,signal),affectedAgents:[]};
      await save(base,value);return value.preview;
    }
    if(method==='resource_publish'){
      const input=parse(z.object({operationId:z.string().uuid(),releaseTag:label,affectedAgents:z.array(affectedSchema).max(256).optional()}).strict(),params);
      if(!value.draftRevisionId||!value.officialId||!value.preview)throw invalid('请先上传草稿并读取发布预览。');
      const publication={releaseTag:input.releaseTag,affectedAgents:input.affectedAgents??[]};
      if(value.publication&&canonicalize(value.publication)!==canonicalize(publication))throw new RuntimeError('idempotency-conflict','此操作已固定发布内容，请重试原提交或重新准备。');
      const submitted=publication.affectedAgents.map(({agentId,expectedContentId})=>({agentId,expectedContentId})).sort((a,b)=>a.agentId<b.agentId?-1:a.agentId>b.agentId?1:0);
      const expected=[...value.preview.affectedAgents].sort((a,b)=>a.agentId<b.agentId?-1:a.agentId>b.agentId?1:0);
      if(canonicalize(submitted)!==canonicalize(expected))throw invalid('必须填写全部受影响 Agent 的原基线和新标签。');
      if(value.phase==='published')return summary(value);
      value.publication=publication;await save(base,value);
      const common={id:value.officialId,draftRevisionId:value.draftRevisionId,releaseTag:publication.releaseTag,idempotencyKey:value.publishKey};
      const request:SkillRelease|AgentRelease=value.kind==='skill'?{...common,kind:'skill',baseline:value.preview.baseline!,affectedAgents:publication.affectedAgents}:{...common,kind:'agent',expectedContentId:value.preview.expectedContentId};
      const release=await platform.publish(request,{signal});
      if(release.versions.length!==1+publication.affectedAgents.length||new Set(release.versions.map(released=>`${released.kind}/${released.id}`)).size!==release.versions.length)throw new RuntimeError('integrity','发布接收结果的资源集合不匹配。');
      if(!release.versions.some(released=>released.kind===value.kind&&released.id===value.officialId&&released.contentId===value.contentId&&released.releaseTag===publication.releaseTag))throw new RuntimeError('integrity','发布接收结果与提交不匹配。');
      for(const affected of publication.affectedAgents)if(!release.versions.some(released=>released.kind==='agent'&&released.id===affected.agentId&&released.releaseTag===affected.releaseTag))throw new RuntimeError('integrity','联动发布结果不完整。');
      value.release=release;value.phase='published';await save(base,value);return summary(value);
    }
    throw invalid('不支持此资源发布操作。');
  }
  return {
    hasMethod:(method:string)=>METHODS.has(method),
    handle(method:string,params:Record<string,unknown>={},options:CallOptions={}):Promise<unknown>{
      if(!METHODS.has(method))return Promise.reject(invalid('不支持此资源发布操作。'));
      if(!params||typeof params!=='object'||Array.isArray(params))return Promise.reject(invalid('资源发布参数无效。'));
      if(options.signal!==undefined&&!(options.signal instanceof AbortSignal))return Promise.reject(invalid('取消信号无效。'));
      if(closing.signal.aborted)return Promise.reject(new RuntimeError('unavailable','资源发布入口已关闭。'));
      if(queued>=16)return Promise.reject(new RuntimeError('resource-limit','资源发布操作过多，请稍后重试。'));
      queued++;
      const signal=AbortSignal.any([closing.signal,...(options.signal?[options.signal]:[])]);
      const result=tail.then(()=>{signal.throwIfAborted();return perform(method,params,signal);}).catch((cause:unknown)=>{
        if(cause instanceof RuntimeError)throw cause;
        throw Object.assign(new RuntimeError(signal.aborted?'aborted':'storage',signal.aborted?'资源操作已停止，提交身份和材料保留。':'资源发布材料无法保存或读取，已有材料保留。'),{cause});
      }).finally(()=>{queued--;});
      tail=result.catch(()=>{});return result;
    },
    async close({deadline}:{deadline:number}){
      if(!Number.isFinite(deadline)||deadline<0)throw invalid('关闭期限无效。');closing.abort();
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([tail,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new RuntimeError('timeout','资源发布关闭超时。')),Math.max(0,Math.min(2_147_483_647,deadline-performance.now())));})]);}finally{clearTimeout(timer);}
    },
  };
}
