# Axure 原型 MCP

一个独立的 [模型上下文协议](https://modelcontextprotocol.io) 服务器，让任何 MCP 智能体都能以**结构化、空间化和视觉化**的方式访问以分享链接形式发布的 Axure 原型。

它刻意独立于任何宿主框架：没有私有 API，没有框架 SDK，只需一次 `npm install` 和一次 `node bin/axure-mcp.mjs`。DSH 像连接任何其他 MCP 客户端一样通过 stdio 连接它，因此升级或更换框架都不会破坏它。

```
structure + space + visual, in one agent turn:

  axure_list_pages      -> what pages exist          (cheap discovery)
  axure_get_page_map    -> what is where, plus text  (the workhorse)
  axure_get_visual      -> the matching pixels       (vision, coordinate-aligned)
```

---

## 为什么这样设计

任务是让智能体看到一个 Axure 页面，而最显而易见的方法——读取无障碍树并截图——在编写任何代码之前，先针对一个真实部署（`https://axure.example.com/ProjectB`，279 个页面）进行了测量。两个发现改变了设计：

**1. Axure 页面的无障碍树几乎毫无用处。** 每个控件都表现为匿名的 `paragraph` 或 `img`——没有角色，没有名称，没有嵌套，没有位置。在参考页面上，整个 ARIA 快照是 115 行 `- paragraph: <text>` 和 `- img`。Axure 没有给它的控件任何 ARIA 语义，因此一个以 ARIA 为先的服务器几乎什么都返回不了。

**2. DOM 和 Axure 自己的运行时非常丰富。** 每个控件都是 `<div id="u<number>">`，它的种类作为 HTML 注释紧挨在它前面输出（`<!-- 会员中心 (Dynamic Panel) -->`），而 `window.$axure.getRectAndStyleById(id)` 能为参考页面上 **113 个控件中的 113 个**解析出作者设定的几何、填充、边框、圆角半径、不透明度和文本。这就是本服务器读取的真相来源。

因此，大纲是从 Axure 自己的标记和运行时中解析出来的——一个轻量的、由证据驱动的解析器，而不是对布局的重新实现。没有 OCR，没有图像理解，也没有交互，因为回答“这是什么页面，所有东西在哪里”并不需要这些。

无障碍功能仍然可以通过 `includeAccessibility: true` 使用，它主要用于*证明*上述论断，而不是提取信息。

---

## 工具

三个工具，围绕一个观察构建：分析页面的智能体需要**在同一时刻、针对同一页面**获得结构、空间和视觉。将它们拆分成单独的 `get_structure` / `get_bounding_boxes` / `screenshot` 调用会使浏览器工作量增加两倍，迫使模型在多个负载之间重新关联坐标，并把每一个布局问题变成一场多次调用的舞蹈。

### `axure_list_pages`

在分享外壳启动后，从 Axure 自己的解码文档模型（`$axure.document.sitemap`）读取项目站点地图。返回一个文件夹树，包含每个页面的 id 和 URL，缓存五分钟。

| 参数 | 类型 | 含义 |
|---|---|---|
| `refresh` | boolean | 绕过缓存并重新读取项目 |
| `filter` | string | 对页面名称/路径进行不区分大小写的子串匹配 |

### `axure_get_page_map`

主力工具。返回一个扁平的、按顺序的、缩进的大纲，其中每个节点都带有它的 id、种类、作者设定的几何信息以及它自己的文本。

```
u1 shape:Group @0,0 1920x1080
  u2 shape:Rectangle @0,0 1920x1080 text="`" [fill=#f0f2f5]
  u3 shape:Rectangle @0,0 200x1080 [fill=#001529]
u4 dynamic-panel:Dynamic Panel @0,218 200x56 name="会员中心" states=2,active=0
  u5 shape:Rectangle @0,218 200x56 clickable text="库存管理"
u57 table:Table @222,95 1662x890
  u58 group:Table Cell @222,95 133x33 image text="版本号"
```

| 参数 | 类型 | 含义 |
|---|---|---|
| `page` | string | 页面 id、页面名称、项目相对路径或绝对 URL |
| `space` | `page` \| `viewport` | 绝对画布坐标，或视口相对坐标加一个 `onScreen` 标志 |
| `detail` | `compact` \| `standard` \| `full` | `standard`（默认）添加填充/描边/半径/不透明度；`full` 添加排版和内边距 |
| `maxNodes` | number | 节点上限，默认 1200；当它裁剪时，`stats` 行列出省略原因 |
| `region` | `{x,y,width,height}` | 限制到一个画布矩形——对密集页面至关重要 |
| `widgetIds` | string[] | 限制为这些控件加上祖先和后代 |
| `onScreenOnly` | boolean | 丢弃当前视口之外的节点 |
| `includeHidden` | boolean | 包含动态面板状态未激活的控件 |
| `includeAccessibility` | boolean | 追加原始 ARIA 快照以供比较 |
| `includeNotes` | boolean | 设计者注释和页面笔记（默认 true） |
| `viewport`、`settleMs` | | 渲染控制 |

### `axure_get_visual`

返回 PNG 像素**以及所捕获内容的精确几何信息**，因此图像始终与你可以对照地图对齐的坐标配对。

| 参数 | 类型 | 含义 |
|---|---|---|
| `page` | string | 同上 |
| `target` | `viewport` \| `full-page` \| `widgets` \| `none` | 捕获什么；`none` 仅返回几何信息 |
| `widgetIds` | string[] | 配合 `target: "widgets"`，裁剪到这些控件的并集并报告每一个 |
| `pad` | number | 控件裁剪周围的填充 |
| `savePath` | string | 同时将 PNG 写入磁盘，供程序化消费者使用 |
| `space` | `page` \| `viewport` | 返回几何信息的坐标空间 |

PNG 作为标准 MCP `image` 内容块返回。具备视觉能力的模型接收像素；纯文本模型接收尺寸和几何摘要，而不是原始数据。

### 坐标与缩放

Axure 的分享播放器会**将线框画布缩小**以适应可用框架。一个 1920×1080 的原型在 1440×900 的视口中捕获，会静默地产生一张 1440×900 的图像，文字缩小，控件矩形不再与作者设定的坐标对齐。为消除这一类不匹配，本服务器在加载后测量画布，并放大视口直到它以 1:1 渲染，同时在一个 `warning` 中报告它这样做了。因此 `full-page` 返回真正的 1920×1080 画布。

---

## 安装与运行

```bash
npm install
npx playwright install chromium     # once
npm run build

node bin/axure-mcp.mjs              # stdio  (default; what DSH uses)
node bin/axure-mcp.mjs --http --port 3333   # streamable HTTP at /mcp

# optional: load configuration from a file instead of the shell environment
node --env-file=.env bin/axure-mcp.mjs
```

`.env.example` 列出了每个变量及其默认值。没有任何东西会隐式加载它——请传递 `--env-file`，或者在启动服务器的环境中导出这些变量。服务器在完全没有配置的情况下也能启动，并默认使用参考部署。

### 配置

全部可选；`AXURE_URL` 默认为 `https://axure.example.com/ProjectB`。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `AXURE_URL` | `https://axure.example.com/ProjectB` | 项目分享 URL；源和项目路径从中拆分 |
| `AXURE_HEADLESS` | `true` | 以无头模式运行 Chromium |
| `AXURE_VIEWPORT_WIDTH` / `_HEIGHT` | `1440` / `900` | 画布适配前的初始视口 |
| `AXURE_DEVICE_SCALE_FACTOR` | `1` | 设备像素比；在上下文创建时固定，因此更改需重启 |
| `AXURE_NAV_TIMEOUT_MS` | `60000` | 导航超时 |
| `AXURE_SETTLE_MS` | `4000` | `load` 之后的额外等待，用于 Axure 自己的引导 |
| `AXURE_MAX_OUTLINE_NODES` | `1200` | 默认节点上限 |
| `AXURE_OUTLINE_CHAR_BUDGET` | `48000` | 驱动每节点文本裁剪的预算 |
| `AXURE_BROWSER_IDLE_MS` | `300000` | 空闲这么多时间后关闭池化浏览器 |
| `AXURE_NO_PROXY` | 内部主机 | 必须绕过环境 HTTP 代理的主机 |
| `AXURE_SCREENSHOT_DIR` | `.axure-mcp/shots` | `savePath` 的基础目录 |
| `AXURE_DEBUG` | 未设置 | 设为 `1` 以输出详细 stderr 日志 |

**代理说明。** 内部 Axure 主机通常无法通过公司 `HTTP_PROXY` 访问。服务器将 `AXURE_NO_PROXY` 同时应用于 Chromium（`--proxy-bypass-list`）和它自己的 HTTP 调用，因此它在一个为注册表访问导出了代理的 shell 中也能工作。

---

## DSH 集成

该服务器作为一个仅配置的 DSH bundle 接入，它插入随附的 `@deepseek-ai/dsh-mcp-client`。它不包含任何 DSH 代码和任何私有 API，因此同一个二进制文件可以继续与任何其他 MCP 客户端一起工作。

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
          AXURE_URL: https://axure.example.com/ProjectB
          NO_PROXY: axure.example.com,localhost,127.0.0.1,::1
        toolCallTimeoutMs: 120000   # a cold call launches Chromium and loads a page
        failOnStartupError: true
```

安装一次：

```
plugin_manager action=install_bundle target=E:\dsh-mcp\axure-mcp-dsh-bundle
```

然后这些工具会作为 `mcp__axure__axure_list_pages`、`mcp__axure__axure_get_page_map` 和 `mcp__axure__axure_get_visual` 出现在模型面前。

> **编辑服务器需要重启 MCP 进程。** DSH 保持一个 stdio 子进程存活；它会重新读取工具*模式*，但继续运行旧的*代码*。更改行为后，请将 bundle 关闭再打开。

### 任何其他 MCP 客户端

```jsonc
// Claude Desktop / generic MCP client, stdio
{
  "mcpServers": {
    "axure": {
      "command": "node",
      "args": ["E:/dsh-mcp/axure-mcp/bin/axure-mcp.mjs"],
      "cwd": "E:/dsh-mcp/axure-mcp",
      "env": { "AXURE_URL": "https://axure.example.com/ProjectB", "NO_PROXY": "axure.example.com" }
    }
  }
}
```

或者运行 `--http`，并将 Streamable HTTP 客户端指向 `http://127.0.0.1:3333/mcp`。

---

## 视觉

截图作为原生 MCP `image` 内容块返回。调用模型是否真的能*看到*它们取决于客户端和模型，本服务器不会用文本中嵌入 base64 的技巧来掩盖这一点：

- **具备视觉能力的模型**——客户端将图像存储为持久附件，模型接收像素。在 DSH 中，`deepseek-flash`（`DeepSeek-V41-Flash`）声明了 `inputModalities: ["text", "image"]`，因此这条路径端到端可用。
- **纯文本模型**——DSH 的 MCP 客户端发出 `[image unavailable: image/png; model "…" does not declare image input; raw image data remains available to programmatic callers]`，而文本几何摘要仍然精确描述捕获内容。使用 `savePath` 将 PNG 交给单独的视觉步骤。

`target: "widgets"` 是节省 token 的路径：一个表格或面板的裁剪，每 token 携带的可读细节远多于一张缩小后的 1920×1080 画布。

---

## 测试

```bash
npm test          # unit: config, sitemap resolution, outline rendering, extractor syntax
npm run test:e2e  # live end-to-end against a real Axure deployment, over real stdio
npm run test:http # same tools over the streamable HTTP transport
npm run test:all  # unit + e2e + http
```

`npm run test:e2e` 完全像客户端一样启动服务器，执行 MCP 握手，列出工具并调用每一个，然后对结果进行断言并将产物写入 `selftest-out/`。这是*“它能否独立运行”*的检查，独立于任何框架。

第一个单元检查最重要：提取器是一个在浏览器内部编译的字符串，因此 `npm test` 证明它是有效的纯 JavaScript。该字符串中一个多余的 TypeScript 注解否则只会在运行时、在 Chromium 内部、远离编辑处的地方失败。

`scripts/recon/` 保存了用于建立上述发现的临时探针（Axure 的 ARIA 输出、运行时 API 覆盖、画布缩放、截图策略）。保留它们是因为它们记录了*为什么*实现看起来是这样，而不是作为构建的一部分。

---

## 已知限制

- **仅静态分析。** 服务器读取状态；它不点击、输入、悬停或触发 Axure 交互。点击背后的控件被报告为 `clickable`，但不会被激活。
- **默认仅报告活动动态面板状态。** `includeHidden: true` 会枚举作者设定的备用状态，但大纲仍然反映一次渲染。
- **重叠容器。** 作者设定的坐标来自 Axure 自己的模型，因此一个组或面板报告它自己的矩形；请使用树和 `image` 标志，而不是假设每个矩形都被绘制。
- **数据密集页面上的重复。** 表格是每个单元格一个控件，因此一个 100 行的表格会产生数千个节点。使用 `region` 或 `widgetIds` 来限定范围；仅靠节点预算会截断而不是聚焦。
- **每次调用一个页面。** 没有多页差异比较或导航图，`Inline Frame` 控件被报告为控件，而不是递归进入。
- **设备像素比按浏览器上下文固定。** 接受 `scale` 是为了兼容性，但会被忽略；设置 `AXURE_DEVICE_SCALE_FACTOR=2` 并重启以获得高 DPI 捕获。
- **没有认证流程。** 它读取分享链接匿名暴露的任何内容。受密码保护的原型需要一个未实现的登录步骤。

## 后续步骤

1. **递归进入内联框架**，使嵌入的原型页面出现在父大纲中。
2. **点击驱动的状态捕获**——一个 `target: "state"`，触发控件的 Axure 动作并重新捕获，用于仅在交互后才存在的面板和标签页。
3. **比较两个页面地图**，使审查工作流（“这个原型修订版改了什么”）成为一次调用。
4. **折叠表格行**为紧凑的 `rows: [[...]]` 形式，当检测到 `Table` 控件时，这会将密集页面的 token 成本降低一个数量级。
5. **面向纯文本模型的视觉桥接**：一个可选工具，将保存的 PNG 转发到配置的多模态端点并返回其描述，使流水线优雅降级，而不是丢弃图像。