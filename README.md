# Axure Prototype MCP

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that gives any
MCP agent **structural, spatial and visual** access to an Axure prototype published as a
share link.

It is deliberately independent of any host harness: no private APIs, no harness SDK, one
`npm install` and one `node bin/axure-mcp.mjs`. DSH connects to it the same way any other
MCP client would — over stdio — so upgrading or replacing the harness cannot break it.

```
structure + space + visual, in one agent turn:

  axure_list_pages      -> what pages exist          (cheap discovery)
  axure_get_page_map    -> what is where, plus text  (the workhorse)
  axure_get_visual      -> the matching pixels       (vision, coordinate-aligned)
```

---

## Why this design

The task was to let an agent see an Axure page, and the obvious approach — read the
accessibility tree and take a screenshot — was measured against a real deployment
(`https://axure.example.com/ProjectB`, 279 pages) before anything was written. Two findings changed
the design:

**1. An Axure page's accessibility tree is close to useless.** Every widget surfaces as an
anonymous `paragraph` or `img` — no role, no name, no nesting, no position. On the reference
page the entire ARIA snapshot is 115 lines of `- paragraph: <text>` and `- img`. Axure gives
its widgets no ARIA semantics, so an ARIA-first server would return almost nothing.

**2. The DOM and Axure's own runtime are rich.** Every widget is `<div id="u<number>">`, its
kind is emitted as the HTML comment immediately before it
(`<!-- 会员中心 (Dynamic Panel) -->`), and `window.$axure.getRectAndStyleById(id)` resolves
authored geometry, fill, border, corner radius, opacity and text for **113 of 113** widgets
on the reference page. That is the source of truth this server reads.

So the outline is parsed from Axure's own markup and runtime — a thin, evidence-driven
parser, not a reimplementation of layout. There is no OCR, no image understanding and no
interaction, because none of those are needed to answer "what is this page and where is
everything".

Accessibility is still available via `includeAccessibility: true`, which is useful mainly
to *prove* the claim above rather than to extract information.

---

## Tools

Three tools, built around one observation: an agent analysing a page needs structure, space
and vision **for the same page at the same moment**. Splitting them into separate
`get_structure` / `get_bounding_boxes` / `screenshot` calls would triple the browser work,
force the model to re-correlate coordinates across payloads, and turn every layout question
into a multi-call dance.

### `axure_list_pages`

Reads the project sitemap from Axure's own decoded document model (`$axure.document.sitemap`)
after the share shell boots. Returns a folder tree with each page id and URL, cached for five
minutes.

| Argument | Type | Meaning |
|---|---|---|
| `refresh` | boolean | Bypass the cache and re-read the project |
| `filter` | string | Case-insensitive substring match on page name/path |

### `axure_get_page_map`

The workhorse. Returns a flat, in-order, indented outline in which every node carries its id,
kind, authored geometry and its own text.

```
u1 shape:Group @0,0 1920x1080
  u2 shape:Rectangle @0,0 1920x1080 text="`" [fill=#f0f2f5]
  u3 shape:Rectangle @0,0 200x1080 [fill=#001529]
u4 dynamic-panel:Dynamic Panel @0,218 200x56 name="会员中心" states=2,active=0
  u5 shape:Rectangle @0,218 200x56 clickable text="库存管理"
u57 table:Table @222,95 1662x890
  u58 group:Table Cell @222,95 133x33 image text="版本号"
```

| Argument | Type | Meaning |
|---|---|---|
| `page` | string | Page id, page name, project-relative path, or absolute URL |
| `space` | `page` \| `viewport` | Absolute canvas coordinates, or viewport-relative plus an `onScreen` flag |
| `detail` | `compact` \| `standard` \| `full` | `standard` (default) adds fill/stroke/radius/opacity; `full` adds typography and padding |
| `maxNodes` | number | Node cap, default 1200; the `stats` line lists omission reasons when it trims |
| `region` | `{x,y,width,height}` | Restrict to one canvas rectangle — essential for dense pages |
| `widgetIds` | string[] | Restrict to these widgets plus ancestors and descendants |
| `onScreenOnly` | boolean | Drop nodes outside the current viewport |
| `includeHidden` | boolean | Include widgets whose dynamic-panel state is not active |
| `includeAccessibility` | boolean | Append the raw ARIA snapshot for comparison |
| `includeNotes` | boolean | Designer annotations and page notes (default true) |
| `viewport`, `settleMs` | | Rendering controls |

### `axure_get_visual`

Returns PNG pixels **plus the geometry of exactly what was captured**, so the image is always
paired with coordinates you can line up against the map.

| Argument | Type | Meaning |
|---|---|---|
| `page` | string | As above |
| `target` | `viewport` \| `full-page` \| `widgets` \| `none` | What to capture; `none` returns geometry only |
| `widgetIds` | string[] | With `target: "widgets"`, crops to these widgets' union and reports each |
| `pad` | number | Padding around a widget crop |
| `savePath` | string | Also write the PNG to disk, for programmatic consumers |
| `space` | `page` \| `viewport` | Coordinate space of the returned geometry |

The PNG is returned as a standard MCP `image` content block. A vision-capable model receives
the pixels; a text-only model receives the size and geometry summary instead of raw data.

### Coordinates and scaling

Axure's share player **scales the wireframe canvas down** to fit the available frame. A
1920×1080 prototype captured in a 1440×900 viewport silently produces a 1440×900 image with
shrunken text, and widget rectangles no longer line up with authored coordinates. To remove
that class of mismatch, this server measures the canvas after load and enlarges the viewport
until it renders 1:1, reporting that it did so in a `warning`. `full-page` therefore returns a
true 1920×1080 canvas.

---

## Install and run

```bash
npm install
npx playwright install chromium     # once
npm run build

node bin/axure-mcp.mjs              # stdio  (default; what DSH uses)
node bin/axure-mcp.mjs --http --port 3333   # streamable HTTP at /mcp

# optional: load configuration from a file instead of the shell environment
node --env-file=.env bin/axure-mcp.mjs
```

`.env.example` lists every variable with its default. Nothing loads it implicitly — pass
`--env-file`, or export the variables in the environment that starts the server. The server
starts with no configuration at all and defaults to the reference deployment.

### Configuration

All optional; `AXURE_URL` defaults to `https://axure.example.com/ProjectB`.

| Variable | Default | Meaning |
|---|---|---|
| `AXURE_URL` | `https://axure.example.com/ProjectB` | Project share URL; origin and project path are split from it |
| `AXURE_HEADLESS` | `true` | Run Chromium headless |
| `AXURE_VIEWPORT_WIDTH` / `_HEIGHT` | `1440` / `900` | Initial viewport before canvas fitting |
| `AXURE_DEVICE_SCALE_FACTOR` | `1` | Device pixel ratio; fixed at context creation, so restart to change |
| `AXURE_NAV_TIMEOUT_MS` | `60000` | Navigation timeout |
| `AXURE_SETTLE_MS` | `4000` | Extra wait after `load`, for Axure's own bootstrapping |
| `AXURE_MAX_OUTLINE_NODES` | `1200` | Default node cap |
| `AXURE_OUTLINE_CHAR_BUDGET` | `48000` | Budget that drives per-node text clipping |
| `AXURE_BROWSER_IDLE_MS` | `300000` | Close the pooled browser after this much idle time |
| `AXURE_NO_PROXY` | internal hosts | Hosts that must bypass an ambient HTTP proxy |
| `AXURE_SCREENSHOT_DIR` | `.axure-mcp/shots` | Base directory for `savePath` |
| `AXURE_DEBUG` | unset | `1` for verbose stderr logging |

**Proxy note.** An internal Axure host is usually unreachable through a corporate
`HTTP_PROXY`. The server applies `AXURE_NO_PROXY` both to Chromium
(`--proxy-bypass-list`) and to its own HTTP calls, so it works in a shell that exports a proxy
for registry access.

---

## DSH integration

The server is wired in as a configuration-only DSH bundle that inserts the shipped
`@deepseek-ai/dsh-mcp-client`. It contains no DSH code and no private API, so the same binary
keeps working with any other MCP client.

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

Install it once:

```
plugin_manager action=install_bundle target=E:\dsh-mcp\axure-mcp-dsh-bundle
```

The tools then appear to the model as `mcp__axure__axure_list_pages`,
`mcp__axure__axure_get_page_map` and `mcp__axure__axure_get_visual`.

> **Editing the server requires restarting the MCP process.** DSH keeps one stdio child
> alive; it re-reads the tool *schemas* but keeps running the old *code*. After changing
> behaviour, toggle the bundle off and on again.

### Any other MCP client

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

Or run `--http` and point a Streamable HTTP client at `http://127.0.0.1:3333/mcp`.

---

## Vision

Screenshots are returned as native MCP `image` content blocks. Whether the calling model can
actually *see* them depends on the client and model, and this server does not paper over that
with base64-in-text tricks:

- **Vision-capable model** — the client stores the image as a durable attachment and the model
  receives the pixels. In DSH, `deepseek-flash` (`DeepSeek-V41-Flash`) declares
  `inputModalities: ["text", "image"]`, so this path works end to end.
- **Text-only model** — DSH's MCP client emits
  `[image unavailable: image/png; model "…" does not declare image input; raw image data
  remains available to programmatic callers]` and the text geometry summary still describes
  the capture exactly. Use `savePath` to hand the PNG to a separate vision step.

`target: "widgets"` is the token-efficient path: a crop of one table or panel carries far more
legible detail per token than a downscaled 1920×1080 canvas.

---

## Tests

```bash
npm test          # unit: config, sitemap resolution, outline rendering, extractor syntax
npm run test:e2e  # live end-to-end against a real Axure deployment, over real stdio
npm run test:http # same tools over the streamable HTTP transport
npm run test:all  # unit + e2e + http
```

`npm run test:e2e` starts the server exactly as a client would, performs the MCP handshake,
lists tools and calls every one, then asserts on the results and writes artifacts to
`selftest-out/`. It is the *"can it run standalone"* check, independent of any harness.

The first unit check matters most: the extractor is a string that is compiled inside the
browser, so `npm test` proves it is valid plain JavaScript. A stray TypeScript annotation in
that string would otherwise only fail at runtime, inside Chromium, far from the edit.

`scripts/recon/` holds the throwaway probes used to establish the findings above (Axure's ARIA
output, runtime API coverage, canvas scaling, screenshot strategies). They are kept because
they document *why* the implementation looks the way it does, not as part of the build.

---

## Known limitations

- **Static analysis only.** The server reads state; it does not click, type, hover or trigger
  Axure interactions. Widgets behind a click are reported as `clickable` but not activated.
- **Only the active dynamic-panel state** is reported by default. `includeHidden: true`
  enumerates authored alternate states, but the outline still reflects one rendering.
- **Overlapping containers.** Authored coordinates come from Axure's own model, so a group or
  panel reports its own rectangle; use the tree and the `image` flag rather than assuming every
  rectangle is painted.
- **Repetition on data-dense pages.** A table is one widget per cell, so a 100-row table
  produces thousands of nodes. Use `region` or `widgetIds` to scope; a node budget alone
  truncates rather than focuses.
- **Single page per call.** No multi-page diffing or navigation graph, and `Inline Frame`
  widgets are reported as widgets rather than being recursed into.
- **Device pixel ratio is fixed per browser context.** `scale` is accepted for compatibility
  but ignored; set `AXURE_DEVICE_SCALE_FACTOR=2` and restart for high-DPI captures.
- **No authentication flow.** It reads whatever the share link exposes anonymously. A
  password-protected prototype would need a login step that is not implemented.

## Next steps

1. **Recurse into inline frames** so embedded prototype pages appear in the parent outline.
2. **Click-driven state capture** — a `target: "state"` that triggers a widget's Axure action
   and re-captures, for panels and tabs that only exist after interaction.
3. **Diff two page maps** to make review workflows ("what changed in this prototype revision")
   a single call.
4. **Collapse table rows** into a compact `rows: [[...]]` form when a `Table` widget is
   detected, which would cut dense-page token cost by an order of magnitude.
5. **A vision bridge** for text-only models: an optional tool that forwards a saved PNG to a
   configured multimodal endpoint and returns its description, so the pipeline degrades
   gracefully instead of dropping the image.
