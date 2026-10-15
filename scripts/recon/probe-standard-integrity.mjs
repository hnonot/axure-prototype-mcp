import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: process.execPath, args: ["bin/axure-mcp.mjs"], env: { ...process.env, AXURE_URL: "https://axure.example.com/ProjectB", NO_PROXY: "axure.example.com,localhost,127.0.0.1" }, stderr: "ignore" });
const c = new Client({ name: "verify", version: "0" });
await c.connect(t);
for (const maxNodes of [60, 300]) {
  const r = await c.callTool({ name: "axure_get_page_map", arguments: { page: "w2yv7l", format: "standard", maxNodes } });
  const d = r.structuredContent.document;
  const byId = d.elementsById;
  const items = d.interactions.items;
  const dangling = items.filter((f) => !byId[f.widgetId]);
  const declaredDangling = items.filter((f) => f.confidence === "declared" && !byId[f.widgetId]);
  const relEndpoints = d.relations.filter((rel) => !byId[rel.from] || (rel.to && !byId[rel.to]));
  console.log(`maxNodes=${maxNodes}: elements=${d.stats.elements} roots=${d.stats.roots} relations=${d.relations.length} interactions=${items.length}`);
  console.log(`   dangling interaction widgets: ${dangling.length}/${items.length} (declared ${declaredDangling.length})`);
  console.log(`   relations with a missing endpoint: ${relEndpoints.length}`);
  const byKind = {};
  for (const rel of d.relations) byKind[rel.kind] = (byKind[rel.kind] ?? 0) + 1;
  console.log(`   relations by kind:`, JSON.stringify(byKind));
  console.log(`   text: distinct=${d.text.distinctTexts} occurrences=${d.text.totalOccurrences}`);
}
await c.close();
