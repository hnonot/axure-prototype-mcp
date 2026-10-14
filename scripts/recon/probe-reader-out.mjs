import { readFileSync } from "node:fs";
const text = readFileSync("src/axure/interaction-source.ts", "utf8");
const s = text.indexOf("export const INTERACTION_SOURCE = `") + "export const INTERACTION_SOURCE = `".length;
const SOURCE = text.slice(s, text.lastIndexOf("`;"));
const toggle = { onClick: { eventType: "OnClick", cases: [] } };
const captured = { page: { diagram: { objects: [{ id: "aaaa", label: "x", friendlyType: "Rectangle", interactionMap: toggle }] } }, objectPaths: { aaaa: { scriptId: "u5" } } };
const factory = new Function("window","document","getComputedStyle", SOURCE + "; return axureExtractOutline;")({ __axureMcpPageModel: captured }, { getElementById:()=>null, body:{querySelectorAll:()=>[]} }, ()=>({cursor:"auto"}));
console.log(JSON.stringify(factory({ maxWidgets: 400 }), null, 1));
