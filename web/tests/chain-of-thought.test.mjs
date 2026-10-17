import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

test("思维链收起时隐藏内容并保留子步骤，运行中展开", async (t) => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { ChainOfThought } = await server.ssrLoadModule("/src/components/chat/chain-of-thought.tsx");
  for (const streaming of [false, true]) {
    const html = renderToString(createElement(ChainOfThought, {
      parts: [{ kind: "reasoning", text: "检查构建日志", state: streaming ? "running" : "done" }],
      streaming, answering: false,
    }));
    const content = html.match(/<div[^>]*data-slot="trace-collapsible-content"[^>]*>/)?.[0];
    assert.ok(content);
    assert.equal(/\sinert(?:=|\s|>)/.test(content), !streaming);
    assert.equal(content.includes('aria-hidden="true"'), !streaming);
    assert.ok(!/\shidden(?:=|\s|>)/.test(content), "收起由布局过渡控制，不能立即 display:none");
    assert.match(html, streaming ? /正在思考…/ : /已思考/);
  }
});

test("思考完成由步骤事件决定；停止和失败不再旋转或显示完成", async (t) => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { ChainOfThought } = await server.ssrLoadModule("/src/components/chat/chain-of-thought.tsx");
  for (const [partState, messageState, title, summary, spinning] of [
    ["running", "streaming", "正在思考…", "正在研究…", true],
    ["done", "streaming", "已思考", "正在研究…", true],
    ["running", "stopped", "思考已停止", "研究已停止", false],
    ["running", "failed", "思考中断", "研究中断", false],
    ["done", "stopped", "已思考", "已研究 1 步", false],
    ["done", "failed", "已思考", "已研究 1 步", false],
  ]) {
    const html = renderToString(createElement(ChainOfThought, {
      parts: [{ kind: "reasoning", text: "已收到部分思考内容", state: partState }],
      streaming: messageState === "streaming", messageState, answering: false,
    }));
    assert.ok(html.includes(title), `${partState} / ${messageState}: ${title}`);
    assert.ok(html.includes(summary), `${partState} / ${messageState}: ${summary}`);
    assert.equal(html.includes("chat-quiet-dot"), spinning);
    if (partState === "running") assert.ok(!html.includes("已思考"));
  }
});

test("组内等待保持活动提示，正文接管后完成，步骤自身保持已完成", async (t) => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { ChainOfThought } = await server.ssrLoadModule("/src/components/chat/chain-of-thought.tsx");
  for (const answering of [false, true]) {
    const html = renderToString(createElement(ChainOfThought, {
      parts: [
        { kind: "reasoning", text: "已检查", state: "done" },
        { kind: "tool", name: "searchCode", callId: "c1", inputText: "{}", state: "done" },
      ],
      streaming: true, answering,
    }));
    assert.ok(html.includes("已思考"));
    assert.ok(html.includes("已搜索代码"));
    assert.ok(html.includes(answering ? "已研究 2 步" : "正在研究…"));
    assert.equal(html.includes("chat-quiet-dot"), !answering);
  }
});

test("工具进行中结束回复也移除旋转状态", async (t) => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { ChainOfThought } = await server.ssrLoadModule("/src/components/chat/chain-of-thought.tsx");
  for (const messageState of ["stopped", "failed"]) {
    const html = renderToString(createElement(ChainOfThought, {
      parts: [{ kind: "tool", name: "searchCode", callId: "c1", inputText: "{}", state: "running" }],
      streaming: false, messageState, answering: false,
    }));
    assert.ok(html.includes(messageState === "stopped" ? "已停止搜索代码" : "搜索代码中断"));
    assert.ok(!html.includes("chat-quiet-dot"));
  }
});
