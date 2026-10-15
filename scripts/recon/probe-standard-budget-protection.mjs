import { applyBudgets } from "../../dist/axure/page-map.js";
const node = (id, extra = {}) => ({ id, ref: `p#${id}`, depth: 0, kind: "shape", type: "Rectangle", x: 0, y: 0, width: 10, height: 10, vx: 0, vy: 0, onScreen: true, visible: true, ...extra });
// 200 off-canvas shapes, one of them protected.
const list = [];
for (let i = 0; i < 200; i++) list.push(node(`u${i}`, { onScreen: i === 150 ? false : true, text: i === 150 ? undefined : "t" }));
const stats = { widgets: 200, nodes: 200, visibleNodes: 200, offCanvasNodes: 0, truncatedNodes: 0, omittedNodes: 0, interactiveNodes: 0, imageNodes: 0 };
const omitted = {};
const out = applyBudgets(list, 50, stats, omitted, new Set(["u150"]));
console.log("kept:", out.length, "| protected u150 kept:", out.some((n) => n.id === "u150"));
console.log("omitted:", JSON.stringify(omitted));

