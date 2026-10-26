import assert from "node:assert/strict"
import { test } from "node:test"
import { access, readFile } from "node:fs/promises"
import { createServer } from "vite"

test("Cognacta presentation adapts backend parts without mutating execution state", async t=>{
 const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:"custom",optimizeDeps:{noDiscovery:true,include:[]}})
 t.after(()=>server.close())
 const {toArcTurns}=await server.ssrLoadModule("/src/components/chat/arc-bridge.ts")
 const source=[{id:"user",role:"user",state:"done",parts:[{kind:"text",text:"保留\n原文"}],attachments:[{name:"note.txt",mediaType:"text/plain"}]},{id:"reply",role:"assistant",state:"stopped",parts:[{kind:"reasoning",text:"检查资料",state:"done"},{kind:"tool",name:"search",callId:"tool",inputText:'{"q":"内容"}',state:"running"},{kind:"text",text:"中文 👩🏽‍💻"},{kind:"text",text:"第二段"}]}]
 const before=structuredClone(source),[turn]=toArcTurns(source,"actual-model")
 assert.deepEqual(source,before)
 assert.equal(turn.versions[0].prompt,"保留\n原文")
 assert.equal(turn.versions[0].attachments[0].name,"note.txt")
 assert.equal(turn.versions[0].reply.status,"stopped")
 assert.equal(turn.versions[0].reply.reasoning,"检查资料")
 assert.equal(turn.versions[0].reply.text,"中文 👩🏽‍💻\n\n第二段")
 assert.equal(turn.versions[0].reply.tools[0].status,"error")
 assert.equal(turn.versions[0].reply.model,"actual-model")
 const failed=toArcTurns([source[0],{...source[1],state:"failed"}],"actual-model","安全错误摘要")[0].versions[0].reply
 assert.equal(failed.status,"error");assert.equal(failed.error,"安全错误摘要")
})

test("Arc renderer and reveal preserve incomplete fences and the final content", async t=>{
 const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:"custom",optimizeDeps:{noDiscovery:true,include:[]}})
 t.after(()=>server.close())
 const {nextCut}=await server.ssrLoadModule("/src/components/arc/blocks/ai-chat/chat-reveal.ts")
 assert.equal(nextCut("a word",0,3,false),2)
 assert.equal(nextCut("```ts",0,3,false),0)
 assert.equal(nextCut("```ts",0,3,true),5)
 const {parseMarkdown}=await server.ssrLoadModule("/src/components/arc/blocks/ai-chat/chat-markdown.tsx")
 const blocks=parseMarkdown("你好 👩🏽‍💻\n\n```ts\nconst result = 1\n```")
 assert.equal(blocks[0].segments[0].text,"你好 👩🏽‍💻")
 assert.equal(blocks[1].closed,true)
 assert.equal(blocks[1].code,"const result = 1")
})

test("Removed component catalog cannot re-enter the frontend through configuration", async ()=>{
 for(const name of ["../src/components/beui","../src/lib/beui","../scripts/beui-catalog.json","../tsconfig.beui.json"])await assert.rejects(access(new URL(name,import.meta.url)))
 const config=JSON.parse(await readFile(new URL("../components.json",import.meta.url),"utf8"))
 assert.equal(config.registries["@beui"],undefined)
 assert.ok(config.registries["@uiarc"])
})
