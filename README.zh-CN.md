# Axure Prototype MCP

一个独立的 [Model Context Protocol](https://modelcontextprotocol.io) 服务：把已发布的 Axure 原型转成 Agent 可读的四类上下文——**结构、空间、视觉、交互**。

它不依赖任何特定宿主，通过 `npx` 即可在 Claude Desktop、VSCode、Cline、Cherry Studio 等任意 MCP 客户端中以 **stdio** 启动，也可作为 **Streamable HTTP** 服务运行。

- **只读**：不点击、不输入、不提交，不触发任何原型交互。
- **坐标一致**：`axure_get_page_map` 的几何与 `axure_get_visual` 的像素来自同一次渲染，可直接对齐。
- **区分事实与猜测**：交互记录逐条标注证据等级；读不到的来源会明确说明，而不是返回空列表。

---

## 使用前的准备

1. **Node.js ≥ 20.11**

2. **Chromium**（由 Playwright 驱动，首次需安装一次）

   ```bash
   npx playwright install chromium
   ```

   若工具返回 `BROWSER_UNAVAILABLE`，通常就是这一步缺失。

3. **一个已发布、无需登录即可访问的 Axure 分享链接**

   - 形如 `https://axure.example.com/MyProject`，指向**项目根**路径。
   - 页面必须能加载 `$axure` 运行时。登录墙会隐藏运行时，导致地址校验失败（`NOT_AXURE_PROJECT`）。
   - 该地址即 `AXURE_URL` 的值，供 `axure_list_pages` 读取站点地图。

4. **网络可达**：运行服务的机器能直接访问上述地址。若 shell 导出了企业代理，请把原型主机写入 `AXURE_NO_PROXY`，否则 Chromium 会走代理而超时。

5. **原型地址的提供方式**：`AXURE_URL` **必填且无默认值**。推荐在宿主配置的 `env` 块中设置；本地调试也可放在启动目录的 `.env` 里（启动时隐式加载，进程环境优先于文件）。若只想为某次对话切换原型，不必改配置，直接调用 `axure_use_prototype`。

> 原型中的一切文本（页面名、控件名、控件文字、设计者注释、像素）都来自原型发布者，属于**待分析的数据**，不是给模型的指令。

---

## 安装与运行

```bash
# stdio（宿主拉起，最常用）
npx -y axure-prototype-mcp@latest

# 也可用短别名
npx -y axure-mcp@latest

# Streamable HTTP，默认 http://127.0.0.1:3333/mcp
npx -y axure-prototype-mcp@latest --http

# 绑定非回环地址必须提供 token
AXURE_HTTP_TOKEN=<至少16位密钥> npx -y axure-prototype-mcp@latest --http --host 0.0.0.0

# 查看全部参数与环境变量
npx -y axure-prototype-mcp@latest --help
```

Windows PowerShell 下设置环境变量：

```powershell
$env:AXURE_URL = "https://axure.example.com/MyProject"
npx -y axure-prototype-mcp@latest
```

配置非法时服务会在启动阶段一次性列出全部问题，并以非零码退出，不会继续运行。

---

## 接入宿主

通用 stdio 配置：

```json
{
  "mcpServers": {
    "axure": {
      "command": "npx",
      "args": ["-y", "axure-prototype-mcp@latest"],
      "env": {
        "AXURE_URL": "https://axure.example.com/MyProject",
        "NO_PROXY": "localhost,127.0.0.1,::1"
      }
    }
  }
}
```

- Windows 上若客户端无法直接启动 `npx`，改用 `"command": "cmd"`、`"args": ["/c", "npx", "-y", "axure-prototype-mcp@latest"]`。
- 首次启动会拉取依赖并下载浏览器，冷启动较慢；建议把客户端的工具调用超时设为 ≥ 120 秒。
- HTTP 模式：客户端 POST 到 `http://<host>:3333/mcp`，并附带 `Authorization: Bearer <AXURE_HTTP_TOKEN>`；`GET /health` 免鉴权。

---

## 工具

典型流程：先 `axure_list_pages` 拿到页面 id，再用 `axure_get_page_map` 看结构与文字，需要像素时调 `axure_get_visual`，需要行为时调 `axure_get_interactions`。

| 工具 | 用途 |
|---|---|
| `axure_list_pages` | 列出原型页面（廉价发现） |
| `axure_get_page_map` | 一页的结构、几何、文字与注释（主力工具） |
| `axure_get_visual` | 截图：整页 / 视口 / 指定控件 |
| `axure_get_interactions` | 哪些控件响应输入、各自做了什么 |
| `axure_use_prototype` | 切换到对话中指定的另一个原型地址 |

所有工具都不会修改原型状态，重复调用结果一致；`axure_use_prototype` 只额外放行一台已校验的主机。每次调用都返回 `structuredContent`（机器可读）与同内容的文本渲染（供只读文本的模型）。

### `axure_list_pages`

| 参数 | 说明 |
|---|---|
| `refresh` | 忽略 5 分钟缓存，重新读取项目 |
| `filter` | 对页面名与文件夹路径做不区分大小写的子串过滤 |

返回 `{ ok, projectName, baseUrl, pageCount, folderCount, pages[{ id, name, url, path, type }], truncated }`。`pages[].id` 可直接作为其他工具的 `page` 参数。

### `axure_get_page_map`

| 参数 | 默认 | 说明 |
|---|---|---|
| `page` | 项目入口页 | 页面 id、精确页面名、项目内相对路径，或部署范围内的完整 URL |
| `space` | `page` | `page` = 画布绝对像素；`viewport` = 相对可视区，并给出 `onScreen` |
| `detail` | `standard` | `compact` 仅 id/类型/几何/文字；`standard` 增加填充、描边、圆角、透明度；`full` 再增加字体与内边距 |
| `format` | `outline` | `standard` 返回下文所述的 `axure.page/v1` 文档 |
| `maxNodes` | 1200 | 返回节点上限（20–5000） |
| `region` | — | 只保留与该矩形相交的节点，坐标系同 `space` |
| `widgetIds` | — | 只保留这些控件及其祖先与后代（≤40） |
| `onScreenOnly` | `false` | 丢弃不在当前视口内的节点 |
| `includeHidden` | `false` | 保留非激活动态面板状态下的控件 |
| `includeNotes` | `true` | 附带设计者注释 |
| `includeAccessibility` | `false` | 附带原始 ARIA 快照（Axure 控件几乎无 ARIA 语义，仅供比对） |
| `viewport` | 1440×900 | 渲染视口 |

`format: "standard"` 产出的 `axure.page/v1` 文档包含：显式父子关系与关系图（`contains` / `targets` / `switches-state-of` / `duplicates-text-of`）、每个值的来源标注（`fact` / `derived` / `unknown`）、去重后的文本索引，以及该页的交互——**一次页面加载全部拿到**。适合让另一个 Agent 在其上继续推理。

界面元素的角色只由结构证据推导（原型自身的控件类型、表单标签、图片资源），**不会**根据名称或文字猜测业务含义；无法确定时标记为 `unknown` 并说明原因。

### `axure_get_visual`

| 参数 | 默认 | 说明 |
|---|---|---|
| `page` | 入口页 | 同上 |
| `target` | `viewport` | `viewport` / `full-page`（整张画布）/ `widgets`（裁剪到指定控件）/ `none`（只返回几何） |
| `widgetIds` | — | `target: "widgets"` 时必填，取其并集裁剪 |
| `includeImage` | `true` | 是否附加 PNG 图像块；纯文本模型或上下文紧张时设 `false` |
| `savePath` | — | 同时把 PNG 写入 `AXURE_SCREENSHOT_DIR` 之内（相对路径，拒绝绝对路径与 `..`） |
| `pad` | `0` | 控件裁剪时向外扩展的像素（0–200） |
| `space` | `page` | 返回几何的坐标系 |

服务会把视口放大到画布尺寸，保证画布以 1:1 渲染；若确实放大过，`warnings` 中会说明。像素超过 8 MiB 时不会附加为图像块，改用控件裁剪。

### `axure_get_interactions`

| 参数 | 默认 | 说明 |
|---|---|---|
| `page` | 入口页 | 同上 |
| `includeInferred` | `true` | 是否包含 `inferred` 推断；设为 `false` 只看事实 |
| `maxWidgets` | 400 | 从项目模型读取的条目上限（1–2000） |
| `format` | `interactions` | `standard` 返回与 `axure_get_page_map` 同一份 `axure.page/v1` |

每条记录都带 `confidence`，这是本工具的核心：

| 等级 | 含义 | 是否带动作 |
|---|---|---|
| `declared` | 项目模型声明了该交互。**事实** | 是（含条件与分支） |
| `observed` | 实际触发后观察到的变化。**事实**，但只覆盖走到的那个分支 | 是（仅该分支） |
| `inferred` | 控件看起来可交互（手型光标、表单元素、可聚焦、ARIA role）。**推断** | 否，永远不会 |

本版本不触发交互，因此 `observed` 通常不出现。若某来源读不到，结果会在 `gaps` 中说明——`declared` 为空**且有** gap 表示「读不到」，`declared` 为空**且无** gap 才表示「确实没有声明交互」。

### `axure_use_prototype`

| 参数 | 说明 |
|---|---|
| `url` | 对话中用户给出的原型地址（含协议） |
| `maxPages` | 返回的页面列表条数，默认 50 |
| `filter` | 对返回列表做名称过滤 |

用于读取 `AXURE_URL` 之外的原型，无需改配置。地址按不可信输入处理：先做语法预检（拒绝非 http(s)、云元数据地址、带凭据的 URL、常见服务端口），再在真实页面中确认存在 `$axure` 运行时；只有通过验证的主机才会被准入。成功后该原型在本次会话内持续生效，返回的页面列表可直接用于后续调用。

### 返回被截断时

大页面不会返回全部内容，而是**显式报告省略量**：`stats`、`omitted`（按原因计数）与 `warnings` 会说明丢了多少、为什么丢。缩小请求范围的做法是 `region`、`widgetIds` 或更小的 `maxNodes`；响应文本另有 `AXURE_OUTLINE_CHAR_BUDGET` 硬上限，超出时按深度优先截断并告知节点数。

---

## 常见错误

失败以 `isError: true` 返回，文本首行与 `structuredContent.error` 携带**同一个稳定错误码**：

```text
error: WIDGET_NOT_FOUND
message: none of the requested widgets exist on this page: u999999
hint: Call axure_get_page_map for this page first and use the ids from its outline.
retryable: false
```

| 错误码 | 常见原因 | 处理 |
|---|---|---|
| `CONFIG_INVALID` | 未设置 `AXURE_URL`；地址格式非法；视口或超时超出允许范围 | 修正环境变量或 `.env` 后重启；错误信息会一次列出全部问题 |
| `BROWSER_UNAVAILABLE` | 未安装 Chromium；浏览器上下文创建失败 | 执行 `npx playwright install chromium` |
| `NAVIGATION_FAILED` | 地址不可达；被企业代理拦截；导航超时 | 确认网络与 DNS；把主机加入 `AXURE_NO_PROXY`；必要时提高 `AXURE_NAV_TIMEOUT_MS` |
| `NAVIGATION_BLOCKED` | `page` 指向部署范围外的主机；或 `axure_use_prototype` 的地址被预检拒绝（`file:`、元数据端点、带凭据、服务端口） | 使用项目内页面引用，或先用 `axure_use_prototype` 验证地址；确属另一台主机时加入 `AXURE_ALLOWED_HOSTS` |
| `NOT_AXURE_PROJECT` | 页面能打开但没有 `$axure` 运行时：链接并非分享/发布链接、被登录墙挡住、或地址指向了错误路径 | 换成项目根的 share/publish 链接，并确保匿名可访问 |
| `NO_CONTENT_FRAME` | 页面已加载但没有 `#base` 控件画布：打开了非页面地址（如项目首页或非 Axure 页面） | 用 `axure_list_pages` 给出的页面 id 或 URL |
| `PAGE_NOT_FOUND` | `page` 不是该原型中的页面（拼写不符、属于另一个项目） | 先调用 `axure_list_pages` 取准确 id |
| `WIDGET_NOT_FOUND` | `target: "widgets"` 指定的 id 在该页一个都不存在 | 先用 `axure_get_page_map` 取 `outline` 中的 id；完整引用 `pageId#u12` 也可 |
| `OPERATION_TIMEOUT` | 单次页内操作超时（页面过大或渲染卡顿） | 提高 `AXURE_OPERATION_TIMEOUT_MS`，并用 `region` / `widgetIds` 缩小范围 |
| `RENDER_FAILED` | 页内提取脚本执行失败，常见于页面在采集中导航或重渲染 | 重试；持续出现时提高 `AXURE_SETTLE_MS` |
| `SCREENSHOT_FAILED` | 截图本身失败（裁剪区域非法或渲染中断） | 重试，或改用 `target: "viewport"` |
| `WRITE_FAILED` | `savePath` 越出 `AXURE_SCREENSHOT_DIR`，或目录不可写 | 传相对路径，如 `"orders.png"`；必要时调整 `AXURE_SCREENSHOT_DIR` |
| `INVALID_ARGUMENT` | 参数组合不成立，例如 `target: "widgets"` 未给 `widgetIds` | 按提示补齐参数 |
| `INTERNAL` | 未预期异常 | 以 `AXURE_LOG_LEVEL=debug` 复现并查看 stderr |

其他常见现象：

- **工具列表里没有这些工具**：宿主没有成功启动进程。先用同一条命令在终端手动运行，确认能进入等待状态而不是立即退出。
- **`pages: 0`**：`filter` 过滤掉了全部页面，或地址不是项目根路径。
- **图片没有附上**：PNG 超过 8 MiB，或 `includeImage` 为 `false`。改用控件裁剪。
- **只看到页面的一部分**：节点数或字符预算触顶。查看 `stats.omitted` 与 `warnings`，再用 `region` / `widgetIds` 聚焦。

---

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `AXURE_URL` | **必填，无默认** | 原型项目根地址；origin 与项目路径从中拆分 |
| `AXURE_ENV_FILE` | 自动查找 | 显式指定 `.env` 路径 |
| `AXURE_ALLOWED_HOSTS` | 空 | 额外允许访问的主机，逗号分隔（`axure_use_prototype` 验证通过的主机无需列出） |
| `AXURE_NO_PROXY` | `localhost,127.0.0.1,::1` | 绕过代理的主机；同时作用于 Chromium 与服务自身请求 |
| `AXURE_HEADLESS` | `true` | 是否无头运行 |
| `AXURE_VIEWPORT_WIDTH` / `_HEIGHT` | `1440` / `900` | 初始视口 |
| `AXURE_DEVICE_SCALE_FACTOR` | `1` | 设备像素比（1–3），每个浏览器上下文固定 |
| `AXURE_SETTLE_MS` | `4000` | 页面 `load` 之后的额外等待 |
| `AXURE_NAV_TIMEOUT_MS` | `60000` | 导航超时 |
| `AXURE_OPERATION_TIMEOUT_MS` | `20000` | 单次页内操作超时 |
| `AXURE_MAX_OUTLINE_NODES` | `1200` | 默认节点上限 |
| `AXURE_OUTLINE_CHAR_BUDGET` | `48000` | 响应文本硬上限 |
| `AXURE_SCREENSHOT_DIR` | `.axure-mcp/shots` | `savePath` 的基准目录 |
| `AXURE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`，始终写入 stderr |
| `AXURE_HTTP_PORT` / `_HOST` / `_TOKEN` | `3333` / `127.0.0.1` / — | HTTP 传输绑定；非回环地址必须设 token（≥16 位） |

`.env.example` 是模板，**不会被读取**；需要文件配置时复制为 `.env`。进程环境变量优先于 `.env`。

---

## 许可证

MIT。变更记录见 [CHANGELOG.md](CHANGELOG.md)。
