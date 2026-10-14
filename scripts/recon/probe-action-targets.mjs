import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: process.execPath, args: ["bin/axure-mcp.mjs"], env: { ...process.env, AXURE_URL: "https://axure.example.com/ProjectB", NO_PROXY: "axure.example.com,localhost,127.0.0.1" }, stderr: "ignore" });
const c = new Client({ name: "probe", version: "0" });
await c.connect(t);
const r = await c.callTool({ name: "axure_get_interactions", arguments: { page: "6k5oyo", includeInferred: false } });
const facts = r.structuredContent.interactions;
for (const f of facts.slice(0, 6)) {
  for (const b of f.branches ?? []) {
    for (const a of b.actions) {
      console.log(f.widgetRef, "|", a.kind, "| raw:", a.rawType, "| targets:", JSON.stringify(a.targets), "| value:", a.value);
    }
  }
}
await c.close();
