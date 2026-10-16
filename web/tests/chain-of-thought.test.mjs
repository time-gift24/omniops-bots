import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

test("思维链收起时隐藏内容并保留子步骤，运行中展开", async (t) => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const { ChainOfThought } = await server.ssrLoadModule("/src/components/chat/chain-of-thought.tsx");
  const parts = [{ kind: "reasoning", text: "检查构建日志" }];

  for (const streaming of [false, true]) {
    const html = renderToString(createElement(ChainOfThought, {
      parts, streaming, answering: false,
    }));
    const content = html.match(/<div[^>]*data-slot="trace-collapsible-content"[^>]*>/)?.[0];
    assert.ok(content);
    assert.equal(/\shidden(?:=|\s|>)/.test(content), !streaming);
    assert.match(html, /已思考/);
  }
});
