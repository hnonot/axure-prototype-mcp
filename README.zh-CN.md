# Axure Prototype MCP

一个独立的 [Model Context Protocol](https://modelcontextprotocol.io) 服务，让任何兼容 MCP 的
Host 都能获取 Axure 原型的**结构、空间、视觉与交互**信息（原型以 share link 方式发布）。

```
针对同一页面，每次调用同时给出结构 / 空间 / 视觉 / 交互：

  axure_list_pages         -> 有哪些页面             （廉价发现）
  axure_get_page_map       -> 什么在哪里、文字是什么 （主力工具）
  axure_get_visual         -> 对应像素               （与坐标对齐）
  axure_get_interactions   -> 哪些元素响应输入       （事实与推断分开标注）
```

不依赖任何特定 Host、模型或客户端库：一次 `npm install`、一次
`node bin/axure-mcp.mjs`，即可通过 **stdio** 或 **Streamable HTTP** 提供标准 MCP 服务。

英文版见 [README.md](README.md)。

- [验证状态](#验证状态)
- [架构](#架构)
- [工具](#工具)
  - [`axure_use_prototype`](#axure_use_prototype)
  - [`axure_list_pages`](#axure_list_pages)
  - [`axure_get_page_map`](#axure_get_page_map)
  - [`axure_get_visual`](#axure_get_visual)
  - [`axure_get_interactions`](#axure_get_interactions)
  - [失败与错误码](#失败与错误码)
- [安装与运行](#安装与运行)
- [配置](#配置)
- [接入 Host](#接入-host)
- [信任与安全边界](#信任与安全边界)
- [模型兼容与降级](#模型兼容与降级)
- [测试](#测试)
- [已知限制](#已知限制)
- [后续计划](#后续计划)
- [版本历史](#版本历史)

---

## 验证状态

五个工具均已实现，并已对**真实 Axure 部署**（Axure 10，两个独立项目）验证通过。
以下数字均为实际运行输出；交互数据结论在该工具存在之前已由独立探针交叉验证。

| 套件 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过，无告警 |
| 单元 | `npm test` | 32/32 |
| 安全 | `npm run test:security` | 14/14 |
| 原型地址 + `.env` | `npm run test:url` | 27/27 |
| 浏览器边界 | `npm run test:inpage` | 6/6 |
| 交互逻辑 + 渲染 | `npm run test:interaction`（前半） | 35/35 |
| 页内读取器 | `npm run test:interaction`（后半） | 20/20 |
| 标准化 | `npm run test:standard` | 36/36 |
| 端到端（真实原型、真实 stdio） | `npm run test:e2e` | 63/63 |
| HTTP 传输 | `npm run test:http` | 8/8 |

运行时原型选择，已经由 DSH GUI 在两个真实项目上验证：

| 检查 | 观察到的结果 |
|---|---|
| `.env` 现在决定地址 | `.env` 设为 `AXURE_URL=https://axure.example.com/ProjectA` → `axure_list_pages` 报 `base: https://axure.example.com/ProjectA`，17 页、6 个文件夹 |
| 对话中指定的地址被验证 | `axure_use_prototype` 指向 `https://axure.example.com/ProjectB` → `signals: axure-runtime, axure-runtime:function, axure-runtime:object, base-canvas, data-js, widget-canvas`，3 个 frame，279 页、93 条文件夹路径 |
| 切换对后续调用生效 | 紧接着的 `axure_list_pages` 报 `base: https://axure.example.com/ProjectB` |
| 非 Axure 的主机被拒 | `http://axure.example.com/` → `NOT_AXURE_PROJECT`（真实主机，但没有 Axure 运行时） |
| 危险地址被拒 | `file:///etc/passwd`、一个元数据端点、6379 端口、一个内嵌凭据的 URL → `NAVIGATION_BLOCKED` |

参考原型上的实测（`format="standard"`，订单管理 `w2yv7l`）：

| 指标 | 数值 |
|---|---|
| 提取器看到的控件 | 1119 |
| 文档中的元素（`maxNodes=300`） | 300（131 个根节点，深度 3） |
| 由结构证据确立的角色 | 300 / 300 |
| 发布的关系 | 223（`contains` 169，`duplicates-text-of` 54） |
| 文本索引 | 96 个条目 / 150 次出现 |
| 同一次页面加载携带的交互 | 94（6 declared，88 inferred） |
| **引用到被省略元素的交互记录** | **0** |
| **端点缺失的关系** | **0** |
| 上报的采集省略 | `empty-group`、`off-canvas`、`decorative-shape`、`node-budget` |

最后两行是**不变量**而非偶发计数，端到端套件对它们有断言：由于承载交互的元素不受节点预算裁剪，
读者总能把一条记录解析到它所指的元素上。

关系数与文本数会随每次重新读取真实页面而轻微波动，因此视为代表性数值；
`elements`、`roots`、角色分布与交互计数是稳定的。

参考原型上的实测交互覆盖：

| 页面 | 控件 | 有交互控件 | case | 事件 | 动作 |
|---|---|---|---|---|---|
| 订单管理 `w2yv7l` | 1119 | 6 | 12 | `onClick` | `setFunction` ×12 |
| 版本更新记录 `6k5oyo` | 113 | 18 | 18 | `onClick` | `setPanelState` ×8、`linkWindow` ×10、`setFunction` ×10 |
| 工单管理 `b8yrp4` | 833 | 6 | 12 | `onClick` | `setFunction` ×12 |

**未验证的部分**——明确写出，而不是让人去猜：

- **只观察到 `onClick`。** 悬停、输入、选择、键盘、页面加载等触发类型**有归一化规则，
  但没有实测样本**，因为该原型的全部交互都是点击。因此这些类型**未经验证**。
- **`linkWindow` 的目标页无法确定。** 实测 payload 的 `target` 只有 `targetType: "page"`，
  没有 `pageId`，所以链接动作只报 `Open Link`，**不编造目标页**。这是能力边界，不是待掩盖的缺陷。
- **`observed` 等级不会产生记录。** 本工具**不触发交互**（触发会改变页面状态，属另一套风险），
  因此该等级有完整的数据结构与构造器，但**没有实测样本**。
- **其他 Axure 版本未测试。** 全部结论来自这一个 Axure 10 部署。

---

## 架构

四层，依赖单向，不存在反向依赖，因此一层的改动不会悄悄变成另一层的职责。

```
                 ┌──────────────────────────────────────────┐
   host  ──────► │ mcp/         协议与工具定义               │  schema、结果组装
                 └───────────────────┬──────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────┐
                 │ service.ts   编排与策略                   │  导航、缓存、画布
                 └───────────────────┬──────────────────────┘  1:1、预算
                                     ▼
                 ┌──────────────────────────────────────────┐
                 │ axure/       Axure 领域逻辑               │  提取、站点地图、
                 └───────────────────┬──────────────────────┘  交互分析、渲染
                                     ▼
                 ┌──────────────────────────────────────────┐
                 │ playwright/  浏览器适配层                 │  唯一 import
                 └──────────────────────────────────────────┘  playwright 处
        横切：config.ts · errors.ts · logger.ts · security.ts · types.ts
```

| 路径 | 职责 | **不**做 |
|---|---|---|
| `src/mcp/` | 工具 schema、结果组装、注册 | 不碰文件系统与网络 |
| `src/service.ts` | 把请求变成浏览器操作；持有策略 | 不认识 MCP、模型或客户端 |
| `src/axure/` | Axure 提取、作用域、交互分析、渲染 | 不 import `playwright`，只接收 `FrameHandle` |
| `src/playwright/` | 持有 Chromium、隔离会话、强制执行边界 | 不知道 Axure 页面是什么 |
| `src/security.ts` | 唯一决定「浏览器能去哪、能写哪」的地方 | |
| `src/config.ts` | 读取并校验环境变量，快速失败 | 不含功能逻辑 |

`src/axure/` 内部，交互与标准化功能按**「不依赖浏览器可验证的部分」**拆分——这也是在构建工具链
不可用时仍让它可测试的原因：

| 文件 | 作用 | 由谁测试 |
|---|---|---|
| `interaction.ts` | 纯推理：证据等级、触发器/动作归一化、聚合 | `test-interaction.mjs`（固定用例） |
| `interaction-source.ts` | 页内读取器，以纯 JS 字符串形式存放 | `test-interaction-source.mjs`（编译并在合成模型上运行） |
| `interaction-analyzer.ts` | 按**来源**决定每条记录的证据等级 | `test-interaction.mjs` |
| `interaction-render.ts` | 文本输出，事实与推断分区呈现 | `test-interaction.mjs` |
| `standard.ts` | **解析层**：原始采集 → `axure.page/v1` 文档。纯函数，不接收 `FrameHandle`、不做 IO | `test-standard.mjs`（固定用例） |
| `standard-render.ts` | 标准文档的有界文本渲染 | `test-standard.mjs`；活体形状由 `test:e2e` 覆盖 |

`standard.ts` 就是 0.2.1 要求里所说的「解析层」，它与读取层的拆分正是「原始数据读取层与解析层应保持解耦」
所要求的东西：它把**已经读到的**数据当参数接收、返回一个值，因此每一条转换规则——包括那条
「不得臆造业务含义」的禁令——都可以在没有浏览器、没有网络、没有原型的情况下验证。

两条值得点名的结论，也是分层的收益所在：

- **`src/axure/` 从不 import Playwright。** 它只接收 `FrameHandle`
  （`run` / `title` / `bodyBox` / `ariaSnapshot`），因此领域逻辑可以用假对象单测，
  且不会因 Playwright 变动而失效。
- **`src/mcp/` 不做任何 IO。** 所有写盘与导航都在它下面发生，因此工具 handler
  短到一眼能读完。

### 为什么大纲是解析出来的，而不是从 ARIA 推导

在动手写代码之前，先对真实 Axure 10 部署做了实测：

**Axure 页面的可访问性树几乎没有信息量。** 每个控件都表现为匿名的 `paragraph` 或 `img`——
没有 role、没有 name、没有层级、没有位置。整页的 ARIA 快照是 115 行
`- paragraph: <文本>` 与 `- img`。

**而 DOM 与 Axure 自身的运行时非常丰富。** 每个控件是 `<div id="u<数字>">`，它的种类写在
紧邻其前的 HTML 注释里（`<!-- 会员中心 (Dynamic Panel) -->`），且
`window.$axure.getRectAndStyleById(id)` 在参考页上能为 **113/113** 个控件给出编辑态几何、
填充、边框、圆角、透明度与文本。

因此大纲解析自 Axure 自身的标记与运行时。`includeAccessibility: true` 仍会返回 ARIA 快照，
主要用途是**证明**上面这一点，而不是从中提取信息。

同理，**交互识别读取的是项目模型，而不是外观**：DOM 只呈现交互的*结果*，而一个
`cursor: pointer` 的控件未必真的绑定了交互，因此外观无法构成事实。

### 交互数据究竟在哪里（实测）

由 16 个针对真实部署的探针确定，期间**推翻了三个初始假设**：

| 初始假设 | 实测事实 |
|---|---|
| `$axure.document` 可读 | 内容框架里的 `$axure` 是**函数**，没有 `.document`；`$axure.internal` 不暴露任何键 |
| `$axure` 上有可用的绑定表 | 不存在可用的 path/id 解析函数 |
| 仅凭 DOM 外观即可判定 | 只能得到推断，且与模型数据重复——因此被限制在独立的 `inferred` 通道 |

可行路径：`files/<页面>/data.js` 虽被混淆，但它把**真实属性名**传给了
`$axure.loadCurrentPage(model)`。用 `addInitScript` 在该调用发生前挂钩，即可拿到完整解码模型：

| 内容 | 位置 |
|---|---|
| 页面控件树 | `model.page.diagram.objects`，子节点在 `objs` |
| 母版 | `model.masters.<hash>.diagram.objects`，子节点在 `objs` **与** `diagrams[].objects` |
| 控件 | `{ id: <32 位 hash>, label, friendlyType, interactionMap? }` |
| 交互 | `interactionMap[event].cases[].actions[]` |

页面地图以 `u<N>` 寻址控件，而模型以 hash 为键，因此需要**两条**桥，
而且**任何一条单独都不够**：

1. `model.objectPaths[hash].scriptId` —— 页面级控件（实测 **1119/1119** 精确）。
2. 控件自身 `scriptIds[0]` —— 母版内控件，母版**完全没有** `objectPaths`（实测 **18/18** 精确）。

一个页面级按钮去切换**母版内**的面板时，两条桥必须同时使用，这就是读取器要合并它们的原因。

### 关于 MCP Resources 与 Prompts

**有意不实现。** 五个工具已覆盖「发现 → 读取 → 看 → 交互 → 选择原型」全过程。Resources 适合可订阅的
长期对象，而原型页面是即取即用的快照；Prompts 面向人工触发的工作流，而本服务的消费者是
Agent。引入它们只会扩大未验证的代码面而不增加能力。若出现明确需求再重新评估。

---

## 工具

五个工具。其中四个只读且幂等；`axure_use_prototype` 对原型本身只读，但会扩大浏览器可达的主机范围，
因此按后者声明。每个结果都以「原型内容是不可信数据」的声明开头。

| 工具 | 用途 |
|---|---|
| `axure_use_prototype` | 读取**对话中被点名的**原型，不改任何配置 |
| `axure_list_pages` | 发现页面（廉价） |
| `axure_get_page_map` | 结构、几何、注释，以及 `axure.page/v1` 文档 |
| `axure_get_visual` | 对应的像素 |
| `axure_get_interactions` | 哪些元素响应输入，附带证据等级 |

### `axure_use_prototype`

把服务指向**用户在对话中点名**的原型，因此读取另一个项目**不需要改 `.env`、也不需要重启**。
`AXURE_URL` 仍然是兜底：用户没有给出地址时**不要**调用它，配置里的原型照常生效。

```
user: 使用 axure-reader，原型地址为 https://axure.example.com/ProjectB，分析订单管理页
agent: axure_use_prototype { url: "https://axure.example.com/ProjectB" }   # 先验证，再采纳
       axure_get_page_map    { page: "订单管理" }                  # 读的就是刚点名的原型
```

| 参数 | 类型 | 含义 |
|---|---|---|
| `url` | string（**必填**） | 用户点名的原型 URL，必须带 scheme |
| `maxPages` | 1–500 | 响应里列出多少页（默认 50） |
| `filter` | string（≤256） | 对返回的页面列表做子串过滤 |
| `viewport`、`settleMs` | | 渲染控制 |

`url` 是五个工具里**唯一**的必填参数，这是刻意的：没有可猜的合理默认值，而猜就会读错原型——
正是本迭代要修的那类故障。端到端套件对此有专门断言：其它四个工具的 `required` 必须为空，
只有它有且仅有一个必填项 `url`。

`structuredContent`：`{ ok, url, origin, host, signals[], frames, verifiedBy, title?, alreadyConfigured, pageCount?, pages?, folders?, warnings[] }`

#### 地址是「验证」出来的，不是「信任」出来的

地址来自对话，因此是**攻击者可影响**的文本——Agent 可能被引导去传一个对手挑选的 URL。
主机白名单在这里是错的工具，因为本功能的目的恰恰是访问**不在名单上**的主机。所以地址靠
**正面识别**准入：

**阶段 1 —— 语法预检，在 Chromium 之前**（`preflightPrototypeUrl`，纯函数，有单元覆盖）。
以下直接拒绝：

| 拒绝对象 | 原因 |
|---|---|
| `file:`、`ftp:`、`data:`、`javascript:` | 只有 `http(s)` 是原型；其余会把本服务变成本地文件读取器或脚本执行器 |
| `169.254.169.254`、`169.254.170.2`、`100.100.100.200`、`metadata.google.internal` | 云实例元数据端点。那里没有任何合法东西，因此无条件拒绝 |
| 端口 22、23、25、110、143、445、1433、1521、3306、3389、5432、5900、6379、9200、11211、27017 | 能让 SSRF 变得有用的知名服务端口 |
| 内嵌用户名/密码的 URL | 本服务不转发凭据，而它们会泄漏进日志 |

私网/内网段**刻意不拦**：读内网原型正是本工具存在的全部理由，参考部署本身就是 `10.x` 内网主机。
真正承重的是阶段 2。

**阶段 2 —— 页内探测，逐 frame**（`AXURE_URL_PROBE`）。准入要求**某个 frame 里存在 Axure 运行时**
（`window.$axure`）。支持信号——`#base`、`u<N>` 控件、`data.js` 脚本——会报进 `signals[]` 让调用方
看到依据，但**不能单独承载准入**：一个有 `#base` 和 `data.js`、却没有运行时的页面会被拒绝，
测试套件对这一点有断言。Axure 的 share 链接会把运行时放在一个 frame、控件放在另一个 frame，
所以每个 frame 都要探测。

验证在飞期间，请求守卫**只放这一台主机**、且只放这一次，并在 `finally` 中撤销——
因此识别失败的主机不会保持可达。成功后该主机被准入、被采纳为当前生效的原型，
并且缓存的站点地图会被清空，因为它属于上一个项目。

**拒绝是明示的能力边界，不是保证。** 正面识别限制的是一个恶意地址**能做什么**，而不是让地址变得安全。
登录墙后的原型会因运行时被挡住而验证失败——这一结果会被如实上报，并附带提示。

### `axure_list_pages`

从 Axure 自身解码后的文档模型（`$axure.document.sitemap`）读取站点地图，缓存 5 分钟。

| 参数 | 类型 | 含义 |
|---|---|---|
| `refresh` | boolean | 忽略缓存并重新读取项目 |
| `filter` | string（≤256） | 对页面名与文件夹路径做大小写不敏感的子串过滤 |

### `axure_get_page_map`

主力工具：**一次调用**同时给出某页的结构、几何与注释。

```
u1 shape:Group @0,0 1920x1080
  u2 shape:Rectangle @0,0 1920x1080 text="`"
u4 dynamic-panel:Dynamic Panel @0,218 200x56 name="会员中心" states=2,active=0
  u5 shape:Rectangle @0,218 200x56 clickable text="库存管理"
u57 table:Table @222,95 1662x890
  u58 group:Table Cell @222,95 133x33 image text="版本号"
```

| 参数 | 类型 | 含义 |
|---|---|---|
| `page` | string（≤2048） | 页面 id、页面名、项目内相对路径，或部署范围内的 URL |
| `space` | `page` \| `viewport` | 画布坐标（默认）或视口相对坐标并附带 `onScreen` |
| `detail` | `compact` \| `standard` \| `full` | `standard`（默认）增加填充/描边/圆角/透明度；`full` 再增加字体与内边距 |
| `region` | `{x,y,width,height}` | 限定到一个矩形，**与 `space` 同一坐标系** |
| `widgetIds` | string[]（≤40，每个 ≤128） | 这些控件及其祖先与全部后代 |
| `onScreenOnly` | boolean | 丢弃不在当前视口内的节点 |
| `maxNodes` | 20–5000 | 节点上限，默认 `AXURE_MAX_OUTLINE_NODES` |
| `includeHidden` | boolean | 保留动态面板非活动状态的控件 |
| `includeAccessibility` | boolean | 追加 ARIA 快照，上限为响应预算的三分之一 |
| `includeNotes` | boolean | 设计者注释与页面备注（默认 true） |
| `format` | `outline` \| `standard` | 见下文。默认 `outline`，保持既有形状 |
| `viewport`、`settleMs` | | 渲染控制 |

`structuredContent`：`{ ok, page{id,name,url,title,type,path}, space, pageSize, viewport, detail, stats, omitted, outline[], scope?, notes?, accessibility?, warnings[] }`

#### 标准数据结构（`axure.page/v1`）

`format="standard"` 返回的是一份**带版本、与模型无关的文档**，而不是扁平大纲。它回答了
大纲回答不了的问题：*对每一个取值来说，它是原型声明的、本服务算出来的，还是谁也没能确定的？*
它还在同一次页面加载里同时给出结构与交互，因此调用方不必自己把两个形状拼起来。

```jsonc
{
  "schema": "axure.page/v1",              // 用于分支判断的字段
  "page":     { "id": "w2yv7l", "name": "订单管理", "url": "...", "title": "...",
                "authoredType": "Wireframe", "path": ["MES系统", "生产计划"] },
  "capture":  { "space": "page", "detail": "standard",
                "canvas":   { "width": 1920, "height": 1080 },
                "viewport": { "width": 1440, "height": 900, "scrollX": 0, "scrollY": 0 },
                "at": "2026-05-14T09:12:33.001Z" },
  "elements": [ /* 只含顶层元素；子节点经 childIds 可达 */ ],
  "elementsById": { "u575": { /* 同一批元素，以原始 id 为键 */ } },
  "relations": [ { "id": "rel1:contains:u1->u2", "kind": "contains",
                   "from": "u1", "to": "u2",
                   "provenance": "derived", "rule": "structure/containment" } ],
  "text": { "entries": [ { "text": "库存管理", "elementIds": ["u5", "u7"],
                           "occurrences": 2, "from": "widget-text" } ],
            "totalOccurrences": 150, "distinctTexts": 96, "droppedEmpty": 0 },
  "interactions": { "items": [ /* 与 axure_get_interactions 返回的同一批记录 */ ],
                    "gaps": [], "stats": { /* … */ }, "warnings": [] },
  "stats": { "widgets": 1119, "elements": 300, "roots": 131, "maxDepth": 3,
             "rolesKnown": 300, "rolesUnknown": 0,
             "byRole": { "shape": 245, "input": 36, "image": 13, "container": 5,
                         "repeating-container": 1 },
             "relations": 223,
             "interactions": { "total": 94, "declared": 6, "observed": 0, "inferred": 88 } },
  "omitted": { "empty-group": 58, "off-canvas": 257, "decorative-shape": 12, "node-budget": 148 },
  "gaps": [], "warnings": []
}
```

上述计数来自一次真实运行；由于每次都会重新读取真实页面，关系数与文本数在运行之间会轻微波动。

一个元素，以及这套形状存在的理由——出处标记：

```jsonc
{
  "id": "u1363",                       // 原始原型 id，始终保留
  "ref": "w2yv7l#u1363",               // 供后续调用使用的稳定句柄
  "parentId": "u12", "childIds": ["u1364"], "depth": 2,
  "authoredType": "Checkbox",           // 原型自己的类型 token，逐字保留
  "role": { "value": "input",           // 由规则推导……
            "provenance": "derived",    //（或 { "provenance": "unknown",
            "rule": "classify/role-from-authored-type(checkbox)" },  // "reason": "unrecognized-value", "detail": "…" }）
  "geometry": { "x": 539, "y": 375, "width": 12, "height": 16,
                "onScreen": true, "visible": true,
                "provenance": "derived", "rule": "capture/geometry" },
  "text": "库存管理",
  "interactionRefs": ["w2yv7l#u1363"]
}
```

| 字段 | 含义 |
|---|---|
| `schema` | 常量 `axure.page/v1`。请据此分支，而不要靠字段是否存在来判断 |
| `elements` | **只含顶层**元素。树由 `childIds` 表达；请遍历它，不要把 `elements` 当成扁平列表 |
| `elementsById` | 任意深度的全部元素，以原始 id 为键。**承载交互的元素及其祖先不受 `maxNodes` 裁剪**，因此 `interactions.items` 中的每一条都能在此解析——端到端套件对此有断言；关系端点同理 |
| `authoredType` | 原型自己的控件类型 token，永不归一化 |
| `role` | 可辨识联合：要么 `{ value, provenance, rule }`，要么 `{ provenance: 'unknown', reason, detail }` |
| `geometry` | 恒为 `derived`——由采集层测量并归一化 |
| `relations[].kind` | `contains`、`targets`、`switches-state-of`、`duplicates-text-of` |
| `relations[].provenance` | 来自项目模型时为 `fact`，由本服务推导时为 `derived` |
| `relations[].evidence` | 对来自交互的关系，记录其 `declared`/`observed`/`inferred` 等级 |
| `text.entries[].occurrences` | 被折叠进该条目的载体数量；`elementIds` 列出它们 |
| `text.droppedEmpty` | 被丢弃的纯空白文本段——有计数，绝不静默消失 |
| `omitted` | 因作用域/预算被丢弃的节点，按原因计数 |
| `gaps` | 读不到的来源，以及消费者因此看不到什么 |
| `stats.rolesUnknown` | 无法确定角色的元素数，等于 `byRole` 里的 `unknown` 计数 |

**`structuredContent.document` 携带完整文档；只有文本渲染受预算约束。** 这一分工是刻意的：
约束散文不能反过来把数据丢掉。

#### 转换规则

原始读取结果由 `src/axure/standard.ts`（纯函数）转换为上述文档。每条规则都在此列出其 id，
因为该 id 会出现在输出里（`role.rule`、`geometry.rule`、`relations[].rule`）——
因此任何推导值都能说出自己是**怎么**推出来的。

| 规则 id | 输入 | 输出 | 说明 |
|---|---|---|---|
| `capture/geometry` | 提取器实测并已归一化的矩形 | `geometry.{x,y,width,height,onScreen,visible}` | 恒为 `derived`：由采集测量并取整 |
| `capture/depth` | 提取器给出的 DOM 嵌套 | `depth`、`parentId`、`childIds` | 层级被重建为显式链接，而不是留在嵌套里靠推断 |
| `classify/role-from-authored-type(...)` | 原型自身的 `friendlyType` 记号 | `role.value` | 固定的**结构**对照表：`Rectangle → shape`、`Dynamic Panel → state-container`、`Table → repeating-container`、`Text Field → input` 等 |
| `classify/role-from-structure(...)` | 提取器的分类桶，或非空图片 URL | `role.value` | 仅在类型记号无法识别时使用，且只在不会误导的方向上采信：`group → container`、`input → input`、`image → image` |
| ——（无规则适用） | 没有任何结构证据匹配 | `role = { provenance: 'unknown', reason, detail }` | 原型未给出类型时 `not-authored`；给出了但本服务未覆盖时 `unrecognized-value` |
| `structure/containment` | 父子链接 | 每条边一个 `contains` 关系 | 每个子节点一条边，因此 `contains = elements − roots` |
| `interaction/target` | `action.targets[].widgetId` | `targets` 关系 | 仅当目标确实存在于本文档中；无法解析的目标仍留在交互记录里，而不会被编造成一个节点 |
| `interaction/panel-target` | 由读取器解析好的 `action.panelId` | `switches-state-of` 关系 | 交互为 `declared` 时 `provenance: fact`，否则 `derived` |
| `text/dedup` | 完全相同的文本段 | 一个 `text.entries` 条目 + 一条 `duplicates-text-of` 关系 | 折叠会被如实上报，绝不静默 |

归一化在关键处是无损的：即使 `role` 为 `unknown`，`authoredType` 仍原样保留原型记号；
纯空白文本被丢弃**并有计数**（`text.droppedEmpty`）；被预算截断的文本在
`textTruncated.length` 中记录未截断长度。

### `axure_get_visual`

返回像素**以及被截取内容的精确几何**，因此图像始终能与页面地图的坐标对齐。

| 参数 | 类型 | 含义 |
|---|---|---|
| `page` | string | 同上 |
| `target` | `viewport` \| `full-page` \| `widgets` \| `none` | 截取内容；`none` 只返回几何 |
| `widgetIds` | string[] | `target: "widgets"` 时按这些控件的并集裁剪 |
| `includeImage` | boolean | 是否附加 PNG 图像块（默认 true） |
| `savePath` | string（≤512） | 同时把 PNG 写入 `AXURE_SCREENSHOT_DIR` 之内 |
| `pad` | 0–200 | 裁剪时的外边距 |
| `space` | `page` \| `viewport` | 返回几何的坐标系 |
| `viewport`、`settleMs` | | 渲染控制 |
| `scale` | 1–3 | **无效果**，仅为兼容保留；请用 `AXURE_DEVICE_SCALE_FACTOR` |

`structuredContent`：`{ ok, page, target, space, canvas, viewport, region?, widgets[], missingWidgets?, image{bytes,mimeType,attached}, savedTo?, warnings[] }`

### `axure_get_interactions`

报告页面中哪些控件响应输入、各自做什么。触发条件与动作读取自项目模型，
**不从外观推断**。

| 参数 | 类型 | 含义 |
|---|---|---|
| `page` | string | 同上 |
| `includeInferred` | boolean | 是否包含 `inferred` 推断（默认 true） |
| `maxWidgets` | 1–2000 | 读取模型条目的上限（默认 400） |
| `format` | `interactions` \| `standard` | 默认 `interactions`，即下文所述形状；`standard` 返回 `axure_get_page_map` 在 `format="standard"` 下产出的同一份 `axure.page/v1` 文档 |
| `viewport` | object | 渲染控制 |

`structuredContent`：`{ ok, page, stats, interactions[], gaps[], warnings[] }`

#### 证据模型（本工具的核心）

每条记录都标明**实际掌握了多少**。本次迭代要求「不得把猜测当作确定结果」，
因此证据等级**随数据一起传递**，消费者可以机械地按它过滤：

| `confidence` | 含义 | 是否带动作 |
|---|---|---|
| `declared` | 项目模型声明了该交互。**事实。** | 是，含条件与分支 |
| `observed` | 实际触发了该交互，这是观察到的变化。**事实**，但只覆盖实际走到的那个分支。 | 是，仅该分支 |
| `inferred` | 控件**看起来**可交互（手型光标、表单元素、可聚焦、ARIA role）。**推断。** | **否**，永远没有 |

`inferred` 记录在结构上就不可能带动作：构造它的函数**没有任何接受动作列表的参数**，
因此后续修改即使忘记这条规则也无法把动作附加上去。每条 `inferred` 都在
`inferredReason` 中说明推断依据。

若某个来源读不到，结果会在 `gaps` 中说明，而不是返回一个空的列表。
`declared: 0` **且存在** gap 表示「读不到」；`declared: 0` 且**没有** gap 表示
「模型可读且确实没有声明交互」。响应文本会明确写出属于哪一种——把二者混为一谈，
正是本功能要避免的捏造。

```
stats: 12 of 113 widgets have interaction information; 9 declared, 0 observed, 3 inferred; 14 branches
actions: set-panel-state=4 navigate=2 show=3 hide=1 wait=1

## declared interactions (facts from the project model)
  p1#u5 <click> "库存管理"
    Case 1 if [[This.text]] equals "x" -> set panel state(widget u4 state=1) ; wait(300ms)

## inferred interactivity (guesses — no actions known)
  p1#u47 <click> — CSS cursor is pointer, which suggests it is meant to be clicked
```

#### 本工具**不**做的事

它**不点击、不输入、不触发任何交互**。触发交互会改变页面状态，那是另一种能力、
另一套风险画像，本版本未启用。因此 `observed` 记录通常不会出现；保留该等级是为了让
将来增加「触发式采集」成为**增量改动**，而不是 schema 破坏性变更。

### 失败与错误码

失败以 `isError: true` 返回，且**文本与 `structuredContent.error` 中带有同一个稳定错误码**：

```
error: WIDGET_NOT_FOUND
message: none of the requested widgets exist on this page: u999999
hint: Call axure_get_page_map for this page first and use the ids from its outline.
retryable: false
```

| 错误码 | 含义 | 类别 |
|---|---|---|
| `CONFIG_INVALID` | 环境配置非法，服务拒绝启动 | 运维 |
| `BROWSER_UNAVAILABLE` | Chromium 或上下文无法创建 | 基础设施 |
| `NAVIGATION_FAILED` | 页面无法加载 | 基础设施 |
| `NAVIGATION_BLOCKED` | 目标主机在部署范围之外，被策略拒绝（0.2.2 起也用于运行时地址被预检拒绝） | 领域 |
| `PAGE_NOT_FOUND` | 页面引用不是本原型中的页面 | 领域 |
| `NOT_AXURE_PROJECT` | URL 可加载但未暴露 Axure 文档（0.2.2 起也是 `axure_use_prototype` 验证失败的错误码） | 领域 |
| `NO_CONTENT_FRAME` | 页面已加载但没有 Axure 控件框架 | 基础设施 |
| `RENDER_FAILED` | 页内提取失败 | 基础设施 |
| `OPERATION_TIMEOUT` | 页内操作超过 `AXURE_OPERATION_TIMEOUT_MS` | 基础设施 |
| `WIDGET_NOT_FOUND` | 指定控件在该页不存在 | 领域 |
| `SCREENSHOT_FAILED` | 截图本身失败 | 基础设施 |
| `WRITE_FAILED` | `savePath` 被拒绝或写入失败 | 领域 / 基础设施 |
| `INVALID_ARGUMENT` | 参数内部不一致 | 领域 |
| `INTERNAL` | 未预期的状况 | — |

---

## 安装与运行

```bash
npm install
npx playwright install chromium     # 仅需一次
npm run build

cp .env.example .env                            # 然后在 .env 里设置 AXURE_URL
node bin/axure-mcp.mjs                          # stdio（默认）；会自动读取 .env
node bin/axure-mcp.mjs --http                   # Streamable HTTP，127.0.0.1:3333
node bin/axure-mcp.mjs --help                   # 完整参数与环境变量说明
AXURE_URL=https://host/Project node bin/...     # 或按次覆盖；进程环境优先于 .env
```

配置非法时会在**启动时一次性**报告全部问题：

```
[axure-mcp] error: invalid configuration (2 problems):
  - AXURE_URL: not a valid absolute URL: "http://"
  - AXURE_VIEWPORT_WIDTH: 99999999 is outside the allowed range 320..4000
```

`.env.example` 是**模板，不会被读取**。请把它复制成 `.env`，服务会在启动时隐式加载后者（详见下文）。

---

## 配置

**`AXURE_URL` 是必填的，没有默认值。** 这是刻意的：内置默认值曾经是一个具体的内网原型，
于是既没有设置它、或者改错了文件的操作者，会被**静默地**服务成**另一台**原型，
且没有任何错误来解释。现在缺少该变量就是一次启动失败，错误信息会指名变量、说明没有默认值，
并指向 `axure_use_prototype` 作为「按对话切换」的替代手段。

```
[axure-mcp] error: invalid configuration (1 problem):
  - AXURE_URL: is required and has no default. Set it to the Axure share/publish URL of the prototype
    you want to read, e.g. AXURE_URL=https://axure.example.com/MyProject. To change prototypes per
    conversation instead of editing configuration, call the axure_use_prototype tool.
```

### 地址从哪里来

按下面的顺序解析，因此**显式动作总是获胜**：

1. **真实进程环境** —— shell 导出、容器变量，或 host 提供的 `env` 块。它的优先级最高，
   因此一个钉死了地址的部署仍然掌握控制权。
2. **`.env`** —— 启动时隐式读取。服务从工作目录起查找，连同最多七层父目录（共八个位置），
   也可以用 `AXURE_ENV_FILE` 指定显式路径。文件里设置了、但环境中已经存在的键会被
   报到 stderr 上，使优先级**可见**而不是令人意外。
3. **否则启动失败** —— 见上面。

`.env` 里无法解析的行会被上报，绝不静默丢弃：**一个被忽略的 `AXURE_URL` 行，正是这套机制存在的理由。**

```bash
# .env —— 要编辑的是这个文件，永远不是 .env.example。
AXURE_URL=https://axure.example.com/MyProject
AXURE_NO_PROXY=localhost,127.0.0.1,::1
```

编辑 `.env` 需要重启服务（stdio host 会重启子进程；DSH 在切换 bundle 时重新读取）。
编辑 `.env.example` 完全没有效果——那就是被报告的那个 BUG。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AXURE_URL` | **无 —— 必填** | 项目 share URL，origin 与项目路径从中拆分 |
| `AXURE_ENV_FILE` | *（自动查找）* | 显式指定 `.env` 路径，代替向上查找 |
| `AXURE_ALLOWED_HOSTS` | *（空）* | 额外允许浏览器访问的主机，逗号分隔。**运行时指定的地址不需要列在这里**：它是被验证的 |
| `AXURE_HEADLESS` | `true` | 是否无头运行 Chromium |
| `AXURE_VIEWPORT_WIDTH` / `_HEIGHT` | `1440` / `900` | 初始视口（320–4000 / 240–4000） |
| `AXURE_DEVICE_SCALE_FACTOR` | `1` | 设备像素比（1–3），每个浏览器上下文固定 |
| `AXURE_MAX_CAPTURE_VIEWPORT_WIDTH` / `_HEIGHT` | `3840` / `2160` | 画布 1:1 适配时视口的上限 |
| `AXURE_NAV_TIMEOUT_MS` | `60000` | 导航超时 |
| `AXURE_OPERATION_TIMEOUT_MS` | `20000` | 每次页内操作的超时 |
| `AXURE_SETTLE_MS` | `4000` | `load` 之后的额外等待，留给 Axure 自身初始化 |
| `AXURE_OUTLINE_CHAR_BUDGET` | `48000` | 响应文本的**硬**字符预算 |
| `AXURE_MAX_OUTLINE_NODES` | `1200` | 默认节点上限 |
| `AXURE_MAX_INTERACTION_WIDGETS` | `400` | 读取交互时从项目模型中读取的控件上限 |
| `AXURE_MAX_WIDGET_IDS` | `40` | 单次调用的控件 id 上限 |
| `AXURE_MAX_PAGES` | `500` | 单次列出的页面上限 |
| `AXURE_BROWSER_IDLE_MS` | `300000` | 空闲多久后关闭池化浏览器 |
| `AXURE_NO_PROXY` | `localhost,127.0.0.1,::1` | 必须绕过代理的主机 |
| `AXURE_SCREENSHOT_DIR` | `.axure-mcp/shots` | `savePath` 的基准目录 |
| `AXURE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`；始终输出到 stderr |
| `AXURE_HTTP_PORT` / `AXURE_HTTP_HOST` | `3333` / `127.0.0.1` | HTTP 传输绑定 |
| `AXURE_HTTP_TOKEN` | *（未设）* | 绑定非回环地址时**必需**；客户端发送 `Authorization: Bearer <token>` |

**代理说明。** 内网 Axure 主机通常无法穿过企业 `HTTP_PROXY`。`AXURE_NO_PROXY` 同时作用于
Chromium（`--proxy-bypass-list`）与服务自身的 HTTP 调用，因此在导出了代理的 shell 中也能工作。

**画布 1:1 适配。** Axure 播放器会把线框画布**缩放**以适配可用框架，因此 1920×1080 的原型
在 1440×900 视口下会静默产出 1440×900 的图，文字被压小，控件矩形也不再与编辑态坐标一致。
服务会在加载后测量画布并把视口放大到 1:1，并在 `warnings` 中说明它这样做了。
显式传入 `viewport` 可固定尺寸；此时若画布大于实际截取范围，服务会给出警告。

---

## 接入 Host

### DSH

一个**纯配置** bundle 插入 DSH 已随附的 `@deepseek-ai/dsh-mcp-client`。它不含任何 DSH 代码
或私有 API，因此同一二进制在任何其他客户端上同样可用。

```yaml
# axure-mcp-dsh-bundle/cordis.patch.yml
- insert:
    - id: axure-prototype-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: axure
        transport: stdio
        command: node
        args: [E:/dsh-mcp/axure-mcp/bin/axure-mcp.mjs]
        cwd: E:/dsh-mcp/axure-mcp
        env:
          # 这里故意不写 AXURE_URL。本文件的 env 块会覆盖服务自身的环境，
          # 所以写死在这里的地址曾经压过操作者编辑的 .env —— 地址来自进程环境或 .env。
          NO_PROXY: localhost,127.0.0.1,::1
        toolCallTimeoutMs: 120000   # 冷调用要启动 Chromium 并加载页面
        failOnStartupError: true
```

只有当你必须为这个 profile 钉死某个原型、并且接受它会压过 `.env` 时，才往那个 `env` 块里加 `AXURE_URL`。
运行时替代手段——`axure_use_prototype`——则完全不需要配置。

```
plugin_manager action=install_bundle target=E:\dsh-mcp\axure-mcp-dsh-bundle
```

工具名形如 `mcp__axure__axure_use_prototype`、`mcp__axure__axure_list_pages`、
`mcp__axure__axure_get_page_map`、`mcp__axure__axure_get_visual`、`mcp__axure__axure_get_interactions`。

> DSH 会保持一个 stdio 子进程常驻，并重新读取它的工具 **schema**，但**继续运行旧代码**。
> 改动服务端行为后，需要把 bundle 关掉再打开一次。

### 通用 stdio 客户端

```jsonc
{
  "mcpServers": {
    "axure": {
      "command": "node",
      "args": ["E:/dsh-mcp/axure-mcp/bin/axure-mcp.mjs"],
      "cwd": "E:/dsh-mcp/axure-mcp",
      "env": { "AXURE_URL": "https://axure.example.com/MyProject", "NO_PROXY": "localhost,127.0.0.1" }
    }
  }
}
```

### Streamable HTTP

```bash
AXURE_HTTP_TOKEN=$(openssl rand -hex 16) node bin/axure-mcp.mjs --http --host 0.0.0.0
# 客户端 POST 到 http://<host>:3333/mcp，并带 Authorization: Bearer <token>
# GET /health 无需鉴权，并会说明是否需要 token
```

按设计是无状态的：每个请求拥有独立的协议实例，共享同一个浏览器池，因此没有会话簿记，
且客户端崩溃不会拖垮端点。

---

## 信任与安全边界

原型内容是**攻击者可影响**的——任何能向该项目发布的人都能控制页面名、控件文本、
设计者注释与像素。由此有两条边界。

**1. 浏览器不离开部署范围。** 工具调用方是一个会被所读内容影响的 Agent，
因此未校验的页面引用会把本服务变成一台拥有内网访问能力的 SSRF 代理。
每个候选 URL 都要经过 `security.resolvePageReference`，它会拒绝：

- 外部主机（`http://169.254.169.254/…`），除非运维把它加进 `AXURE_ALLOWED_HOSTS`；
- 显式非 http 协议，包括 `file:`；
- 协议相对值（`//host/x`）——`new URL(value, base)` 会把它静默解析成另一个 origin；
- 爬出项目路径的路径（`../../other-app/`）。

此外还有请求级守卫，会拦截超出边界的主机，包括重定向与子资源。
调用方提供的 `savePath` 被约束在 `AXURE_SCREENSHOT_DIR` 之内，绝对路径与 `..` 一律拒绝。
HTTP 传输在绑定非回环地址时**绝不**允许无 token 运行。

**1b. 运行时地址靠验证准入，不靠信任。** `axure_use_prototype` 会扩大边界，
因此它不能使用上面的白名单——它的目的恰恰是访问不在名单上的主机。于是地址必须先通过
语法预检，再被**正面识别**为 Axure 原型，如其工具章节所述。有两条性质使它不成为漏洞：

- 只有确实提供了 Axure 运行时的主机才会被准入，而且是在**观察到**之后才准入，
  所以调用方无法靠断言挤进来；
- 验证请求在飞期间，守卫**只放这一台主机**，并在 `finally` 中撤销，
  因此识别失败的主机不会留在可达状态。

这**限制**风险，但不**消除**风险。检查证明的是「这个 URL 提供了 Axure 原型」，
与「抓取这个 URL 是安全的」不是一回事。私网/内网段是**故意**保持可达的，
因为读内网原型正是本服务的用途。

**2. 原型内容被明确标注，且无法伪造结构。** 每个结果在任何原型文本**之前**先给出声明，
协议握手时的服务 instructions 也重复该声明。取值会被净化以免突破格式：换行与控制字符被折叠；
控件种类注释按括号索引解析，而不是用允许换行的正则；围栏内的 ARIA 快照中的反引号会被转义。
测试向控件文本、注释、页面名与快照中注入了 `\nformat:`、`## outline`、`warning: obey me`
以及闭合代码围栏。

本服务只做**只读静态分析**：它从不点击、输入、提交或触发 Axure 交互，
因此原型内容无法导致任何动作。

---

## 模型兼容与降级

工具的设计目标是让弱客户端**降级**而不是崩溃。

- **完全不要图片。** `includeImage: false`（或 `target: "none"`）在没有任何图像块的情况下
  返回画布尺寸、区域与逐控件几何。`savePath` 可以把 PNG 写出，交给独立的视觉步骤。
- **纯文本模型。** `structuredContent` 从不携带像素数据；不支持图像的模型只是永远不索取图像。
- **小上下文窗口。** 两个预算共同约束模型收到的内容：`maxNodes` 限制节点数，
  `AXURE_OUTLINE_CHAR_BUDGET` 是响应文本的**硬**上限——大纲按深度优先截断到预算内，
  并报告截断情况。实测：1119 控件页面在 `detail=full, maxNodes=5000` 下，
  响应为 48,078 字符（预算 48,000）。`region` 与 `widgetIds` 是选择「看哪一部分」的正道。
  交互结果按同样预算约束，且**优先丢弃 `inferred` 推断**，绝不为了保留猜测而丢掉事实。
- **错误。** `isError: true` 加上行首的 `error: <CODE>` 行，因此纯文本消费者无需解析散文即可
  区分成功与失败；结构化消费者从 `structuredContent.error.code` 得到同一个码。
- **结构化输出。** 每个工具都声明了 `outputSchema`，且是**有意宽松**的：SDK 也会用同一
  schema 校验**失败**载荷，严格的「成功」schema 会导致每个错误结果都被拒绝。
  各工具的键集合改由 `npm run test:e2e` 断言。

---

## 测试

```bash
npm test                  # 32 单元：配置、领域、渲染、预算
npm run test:security     # 14 安全：导航范围、路径约束、转义
npm run test:interaction  # 35 交互逻辑 + 20 页内读取器 = 55
npm run test:standard     # 36 标准化：角色、出处、层级、去重、边界、循环防护
npm run test:url          # 27 地址预检、Axure 识别、.env 优先级
npm run test:inpage       #  6 浏览器边界：页内约定与隔离
npm run test:e2e          # 63 端到端：真实部署、真实 stdio
npm run test:http         #  8 HTTP 传输，含鉴权门
npm run test:all          # 全部
```

其中五个值得解释，因为它们才是让本功能可测试的关键：

`scripts/test-url.mjs` 是 0.2.2 那个 BUG 的回归套件。它的三个用例对应那三条**互相独立**的成因：
`AXURE_URL` 没有内置默认值（直接断言 `CONFIG_DEFAULTS` 里不存在该键）、空环境被拒绝且错误信息里
出现 `axure_use_prototype`、以及 `.env` 确实被读取——并且进程环境变量优先，无法解析的行被上报而不是丢弃。
其余用例覆盖准入策略，而策略是纯的：scheme、元数据地址、服务端口的拒绝，
以及「识别必须以 Axure 运行时为准，因此 `#base` 与 `data.js` 单独不足以准入某台主机」这条规则。

`scripts/test-interaction.mjs` 不需要浏览器。证据模型、触发器与动作归一化、分支解码、
聚合与渲染都在 `src/axure/interaction.ts` 中（纯函数），因此包括
「`inferred` 记录永远不能带动作」在内的规则可以用固定用例验证。

`scripts/test-interaction-source.mjs` 既不需要浏览器也**不需要构建**。它以文本方式提取页内
读取器源码，用 `new Function` 编译，再在复刻实测结构的合成模型上、以带桩的
`window`/`document` 运行。它验证：语法、自包含性、缺少模型时给出 gap 而不是空列表、
载荷被原样保留、**母版**交互与两条 id 桥都可用、控件上限被强制执行并上报、
模型抛异常不会让读取器崩溃、DOM 观察不会混入模型条目。

`scripts/test-standard.mjs` 覆盖转换逻辑——它是已读取数据的纯函数。其中最重要的断言是否定式
断言：当没有结构规则可用时，角色必须是 `unknown` 而不是被猜出来的；以及 `classifyRole`
**根本读不到**控件的名称或文本——测试用一个 `Proxy` 探测，一旦它触碰这类字段就失败。
这把「不得仅凭组件名称或视觉外观臆造业务含义」从一句承诺变成一项检查。

`npm run test:e2e` 会把交互数量与独立探针（`scripts/recon/probe-interaction-coverage.mjs`）
的实测数字交叉比对，因此「静默退化为 0」或「凭空多出记录」都会让套件失败。它还断言标准文档的
层级可被遍历、每个角色都带出处、`unknown` 角色带的是 reason 而不是 value，
以及新增 `format` 选项没有影响既有的 `outline` 默认输出。

`scripts/recon/` 保存了用于确立设计依据的一次性探针——Axure 的 ARIA 输出、运行时 API 覆盖率、
画布缩放行为、截图策略，以及定位模型、两条 id 桥与真实动作词表的 16 个交互探针。
它们记录了实现**为什么**长成这样，但不属于构建产物。

---

## 已知限制

- **Axure 检查证明的是「某主机提供什么」，不是「抓取它安全」。** `axure_use_prototype` 会拒绝那些
  让 SSRF 变得有用的地址类别，并要求先看到 Axure 运行时才准入一台主机；但一个**确实**提供 Axure
  原型的恶意地址仍然会被抓取。检查限制的是爆炸半径，它不是保证。
- **私网/内网段是按设计可达的。** 拒绝 RFC1918 会拒绝本工具存在的理由。预检拦的是链路本地元数据端点，
  阶段 2 则要求该主机确实是 Axure。
- **登录墙后的原型无法通过验证。** 运行时会从检查面前被藏起来，于是该地址以这个原因被拒绝，
  而不是返回一个空页面。
- **被选中的原型在整个进程内有效，而不是一次对话。** 这是共享状态：第二个调用方指向别处后，
  第一个调用方读到的东西会随之改变，直到有人指回来。错误的代价是有界的：地址经过验证，
  且拒绝清单就是上面那些。**这份准入没有任何撤销接口**——验证过的主机只增不减，直到进程重启。
- **`axure_use_prototype` 的并发验证尚未验证。** 验证期间只放行**一台**主机的那份临时许可是一个
  单槽状态；两次验证同时进行时，它们会互相覆盖、并由先结束的一次清掉另一次的许可
  （读代码推断，未实测）。如果遇到「地址明明是好的却被判成非 Axure」，这是可疑原因之一。
- **仅静态分析。** 服务只读取状态；不点击、不输入、不悬停、不触发 Axure 交互。
  点击后才出现的控件会被标注为 `clickable`，但不会被激活。
- **交互识别已验证，但覆盖面窄。** 见上方[验证状态](#验证状态)：参考原型中只观察到 `onClick`；
  `linkWindow` 的目标页无法从模型恢复；`observed` 因本工具从不触发交互而没有实测样本。
- **交互条件只是转述，不做求值。** 分支的判定条件按模型原文（`conditionString`）报告；
  服务不会判断在给定页面状态下会走哪个分支。
- **条件分支下的动作会被全部列出**，因此消费者会同时看到互斥的结果。区分它们的是
  `conditions` 字段。
- **母版实例之间不做去重。** 同一母版被使用两次时，每个实例都会因 DOM id 不同而各自产生记录。
  这是刻意设计，但计数语义未专门测试。
- **单一动态面板状态。** `includeHidden: true` 可枚举作者设计的备选状态，但大纲仍只反映
  一次渲染。
- **数据密集页会重复。** 表格是「一单元格一控件」，因此 100 行表格会产生数千节点。
  请用 `region` 或 `widgetIds` 聚焦；单靠节点预算只会截断而不会聚焦。
- **单次调用只处理一页。** 没有多页 diff 或导航图；`Inline Frame` 控件被当作控件报告，
  不会被递归进入。
- **设备像素比按上下文固定。** `scale` 被接受但被忽略；请设
  `AXURE_DEVICE_SCALE_FACTOR=2` 并重启。
- **附加图像上限 8 MiB。** 更大的截图会写入磁盘并上报，但不会作为图像块附加，
  以免单个响应携带数十兆字节。
- **不对原型做鉴权。** 它只读取 share link 匿名暴露的内容；密码保护的原型需要登录流程，
  目前未实现。
- **并发上限为每进程 4 个浏览器上下文**，且不可配置。

## 后续计划

1. **递归 Inline Frame**，让嵌入的原型页出现在父级大纲中。
2. **触发式采集**（`observed`）：在隔离上下文中触发一次交互并记录变化，
   这是了解「模型只间接表达的分支结果」的唯一途径。
3. **表格行折叠**：识别到 `Table` 控件时折叠为紧凑形式，把数据密集页的 token 成本降低一个数量级。
   标准文档的 `text.entries[].occurrences` 与 `repeating-container` 角色就是为此预留的挂钩。
4. **两版标准文档 diff**，把「这一版原型改了什么」变成一次调用。`schema` 带版本、
   关系 id 是确定性的，因此同一页面的两份文档可以直接比较。
5. **为尾部小节预留预算。** 目前数据密集页的元素列表可以吃掉整个字符预算，于是
   `## gaps and omissions` 被裁掉，只剩裁剪提示。披露本身是诚实的，但优先级顺序是错的。
6. **让并发上限可配置**，并从 `/health` 报告。

## 版本历史

版本化提示词、审计与变更记录见 [`.update/`](.update/README.md)。
本文档的英文版为 [README.md](README.md)。

| 版本 | 变更 |
|---|---|
| 0.2.2 | `AXURE_URL` 变为必填且没有默认值、`.env` 改为隐式加载且进程环境优先、DSH bundle 里写死的地址被移除，并新增 `axure_use_prototype` 以读取对话中点名的原型 —— [`.update/0.2.2`](.update/0.2.2/plan.md) |
| 0.2.1 | 标准化输出：带版本的 `axure.page/v1` 文档，逐值出处标记、显式层级与关系图、去重后的文本索引，并在一次调用中同时给出结构与交互 —— [`.update/0.2.1`](.update/0.2.1/plan.md) |
| 0.2.0 | 交互识别：`axure_get_interactions`，`declared`/`observed`/`inferred` 证据模型 —— [`.update/0.2.0`](.update/0.2.0/plan.md) |
| 0.1.0 | 首次发布：三个工具、画布 1:1 适配、region/widget 作用域、stdio + HTTP、四层重构 |

`package.json` 与本表都读作 `0.2.2`；两者不一致时，以迭代目录为准。早期版本的本表曾把 0.2.0
迭代标为 `0.3.0`，而 `package.json` 又走在其前面；这些编号现已统一到迭代目录。
