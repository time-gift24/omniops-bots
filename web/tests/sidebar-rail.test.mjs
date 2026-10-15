import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

test("SidebarRail renders on the server without mounting browser portals", async (t) => {
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  t.after(() => server.close());
  const { useHydrated } = await server.ssrLoadModule("/src/lib/hooks/use-hydrated.ts");
  assert.equal(renderToString(createElement(() => String(useHydrated()))), "false");
  const { SidebarRail } = await server.ssrLoadModule(
    "/src/components/premium/sidebar-blocks/sidebar-rail.tsx",
  );
  const html = renderToString(createElement(SidebarRail, { workspaceName: "Cognacta" }));
  assert.match(html, /Cognacta/);
  assert.match(html, /aria-label="工作区导航区域"/);
  assert.doesNotMatch(html, /role="tooltip"/);
});
