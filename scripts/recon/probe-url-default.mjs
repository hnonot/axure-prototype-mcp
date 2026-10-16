import { loadConfig } from "../../dist/config.js";
const c = loadConfig({});
console.log("未配置 AXURE_URL 时 baseUrl =", JSON.stringify(c.baseUrl));
console.log("  -> 是否硬编码了具体原型？", c.baseUrl.includes("ProjectB") ? "是（BUG：默认值内嵌了具体原型）" : "否");

