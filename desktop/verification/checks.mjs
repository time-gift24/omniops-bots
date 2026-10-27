import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, mkdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { sha256, requireRuntime } from './protocol.mjs';
const root=resolve(import.meta.dirname,'../..');
const npm=resolve(dirname(process.execPath),process.platform==='win32'?'node_modules/npm/bin/npm-cli.js':'../lib/node_modules/npm/bin/npm-cli.js');
/** Match the pinned SDK locally; an explicit CEF_PATH never silently falls back. */
export async function resolveCefEnvironment({environment=process.env,platform=process.platform,arch=process.arch,home=homedir(),workspace=root}={}){
 const lock=await readFile(join(workspace,'Cargo.lock'),'utf8'),version=/name = "cef-dll-sys"\nversion = "[^"\n]+\+([^"\n]+)"/u.exec(lock)?.[1];
 const target=platform==='darwin'&&arch==='arm64'?{directory:'cef_macos_aarch64',archive:'macosarm64'}:platform==='win32'&&arch==='x64'?{directory:'cef_windows_x86_64',archive:'windows64'}:null;
 if(!version||!target)return null;
 const explicit=environment.CEF_PATH,base=explicit??(platform==='darwin'?join(home,'Library/Caches/tauri-cef'):join(workspace,'desktop/.scratch/windows-cache/cef'));
 if(!isAbsolute(base))return null;
 for(const candidate of [base,join(base,version,target.directory)]){
  try{const archive=JSON.parse(await readFile(join(candidate,'archive.json'),'utf8'));if(!archive.name?.startsWith(`cef_binary_${version}+`)||!archive.name.includes(`_${target.archive}_`)||!/^[a-f0-9]{40}$/u.test(archive.sha1))continue;
   if(!(await stat(join(candidate,'include/cef_api_versions.h'))).isFile()||!(await stat(join(candidate,'CMakeLists.txt'))).isFile())continue;
   return {environment:{CEF_PATH:candidate},source:explicit===undefined?'cache':'environment'};
  }catch{}
 }
 return null;
}
async function command(command,args,{environment={},timeoutMs=300000}={}){
 if(command===npm){args=[npm,...args];command=process.execPath;}
 const start=new Date().toISOString();return new Promise(resolve=>{
  const child=spawn(command,args,{cwd:root,env:{...process.env,...environment},stdio:['ignore','pipe','pipe'],shell:false});let count=0,outputHash=createHash('sha256'),settled=false,timedOut=false;
  const collect=bytes=>{count+=bytes.length;outputHash.update(bytes);};child.stdout.on('data',collect);child.stderr.on('data',collect);
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');},3000).unref();},timeoutMs);
  const done=(exitCode,error)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({command:[command,...args],startedAt:start,endedAt:new Date().toISOString(),status:error?.code==='ENOENT'?'not-run':exitCode===0&&!timedOut?'passed':'failed',exitCode,outputBytes:count,outputSha256:outputHash.digest('hex'),...(timedOut?{reason:'Check exceeded its deadline.'}:error?{reason:'The check could not be started.'}:{})});};child.once('error',error=>done(null,error));child.once('exit',code=>done(code));
 });
}
/** Existing independent checks; none is reclassified as native installed-package evidence. */
export async function runExistingChecks(){
 const stages=[];
 for(const args of [['--prefix','desktop/runtime','run','typecheck'],['--prefix','desktop/runtime','test'],['--prefix','desktop/runtime','run','test:verification'],['--prefix','web','run','typecheck'],['--prefix','web','run','lint'],['--prefix','web','test']])stages.push(await command(npm,args));
 for(const edition of ['user','operations'])stages.push({...await command(npm,['--prefix','web','run','build'],{environment:{VITE_APP_EDITION:edition}}),edition});
 const scripts=(await readdir(join(root,'desktop/scripts'))).filter(x=>x.endsWith('.test.mjs')).map(x=>join('desktop/scripts',x));stages.push(await command(process.execPath,['--test',...scripts]));
 stages.push(await command('python3',['-m','unittest','discover','-s','desktop/scripts','-p','test_*.py'],{environment:{PYTHONDONTWRITEBYTECODE:'1'}}));
 stages.push(await command(npm,['--prefix','desktop/runtime','run','test:browser']));
 // These are explicit native-source regression gates, not evidence that an installed package ran.
 const cef=await resolveCefEnvironment();
 for(const args of [['fmt','--all','--','--check'],['check','--workspace','--all-targets','--all-features','--locked'],['clippy','--workspace','--all-targets','--all-features','--locked','--','-D','warnings'],['test','--workspace','--lib','--bins','--all-features','--locked'],['deny','check','--disable-fetch']]){
  const needsCef=['check','clippy','test'].includes(args[0]);
  if(needsCef&&!cef)stages.push({command:['cargo',...args],status:'not-run',reason:'Pinned CEF SDK is unavailable locally; set CEF_PATH to a valid cached SDK.'});
  else stages.push({...await command('cargo',args,{environment:needsCef?cef.environment:{}}),...(needsCef?{cefSource:cef.source}:{})});
 }
 return stages;
}
export async function runHTMLChecks(reportRoot,{onlyFiles,editions=['user','operations'],production=true}={}){
 const stages=[];let browser;
 const requireWeb=createRequire(new URL('../../web/package.json',import.meta.url)),{createServer}=await import(pathToFileURL(requireWeb.resolve('vite')).href),{chromium}=requireRuntime('playwright-core');
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  for(const edition of editions){
   if(!['user','operations'].includes(edition))throw new Error('Invalid browser edition.');
   const previous=process.env.VITE_APP_EDITION;process.env.VITE_APP_EDITION=edition;
   let vite;
   try{
    vite=await createServer({root:join(root,'web'),server:{host:'127.0.0.1',port:0},logLevel:'silent'});await vite.listen();const origin=vite.resolvedUrls.local[0];
    const files=(await readdir(join(root,'web/tests'))).filter(f=>f.endsWith('.browser.html')&&(!onlyFiles||onlyFiles.includes(f))).sort();
    for(const file of files){const context=await browser.newContext(),page=await context.newPage(),errors=[];const pageFailure=Promise.withResolvers();void pageFailure.promise.catch(()=>{});page.on('pageerror',()=>{errors.push('pageerror');pageFailure.reject(new Error('Page exception.'));});const startedAt=new Date().toISOString();
     // These two parent fixtures serially verify two viewports with a 45-second child budget.
     const timeoutMs=['navigation.browser.html','workspace.browser.html'].includes(file)?100000:30000;
     try{await Promise.race([(async()=>{await page.goto(new URL(`tests/${file}`,origin).href);await page.waitForFunction(()=>{const e=document.querySelector('#result');return e&&(/^(PASS|FAIL)\b/u.test(e.textContent.trim())||['true','false'].includes(e.dataset.passed));},{},{timeout:timeoutMs});})(),pageFailure.promise]);const value=await page.locator('#result').evaluate(e=>({text:e.textContent.trim(),passed:e.dataset.passed}));if(errors.length||value.passed==='false'||!/^PASS\b/u.test(value.text))throw new Error('Browser assertion failed.');stages.push({command:['browser',file],edition,status:'passed',startedAt,endedAt:new Date().toISOString(),timeoutMs,assertionSha256:sha256(value.text)});}
     catch{const shot=join(reportRoot,`${edition}-${file}.png`);await mkdir(reportRoot,{recursive:true,mode:0o700});await page.locator('#result').scrollIntoViewIfNeeded({timeout:1000}).catch(()=>{});await page.screenshot({path:shot}).catch(()=>{});stages.push({command:['browser',file],edition,status:'failed',startedAt,endedAt:new Date().toISOString(),reason:'Page exception, assertion failure or no PASS before deadline.',evidence:shot});}
     finally{await context.close();}
    }
   }finally{await vite?.close();if(previous===undefined)delete process.env.VITE_APP_EDITION;else process.env.VITE_APP_EDITION=previous;}
  }
  if(production){let preview;try{const {preview:servePreview}=await import(pathToFileURL(requireWeb.resolve('vite')).href);preview=await servePreview({root:join(root,'web'),preview:{host:'127.0.0.1',port:0},logLevel:'silent'});const files=(await readdir(join(root,'web/tests'))).filter(f=>f.endsWith('.browser.mjs'));for(const file of files)stages.push(await command(process.execPath,['--test',join(root,'web/tests',file)],{environment:{OMNIOPS_WEB_PREVIEW_URL:preview.resolvedUrls.local[0]}}));}finally{await new Promise(yes=>preview?preview.httpServer.close(yes):yes());}}
 }catch{stages.push({command:['browser','html-suite'],status:'not-run',reason:'Chrome or the browser build environment is unavailable.'});}
 finally{await browser?.close();}
 return stages;
}
