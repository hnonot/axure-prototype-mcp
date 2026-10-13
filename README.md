# Axure Prototype MCP

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that gives any
MCP-compatible host **structural, spatial and visual** access to an Axure prototype published as
a share link.

```
structure + space + visual, for the same page, in one call:

  axure_list_pages    -> what pages exist             (cheap discovery)
  axure_get_page_map  -> what is where, plus text     (the workhorse)
  axure_get_visual    -> the matching pixels          (coordinates stay aligned)
```

It has no dependency on any particular host, model or client library: one `npm install`, one
`node bin/axure-mcp.mjs`, and it speaks standard MCP over **stdio** or **Streamable HTTP**.

- [Architecture](#architecture)
- [Tools](#tools)
- [Install and run](#install-and-run)
- [Configuration](#configuration)
- [Connecting a host](#connecting-a-host)
- [Trust and safety](#trust-and-safety)
- [Model compatibility](#model-compatibility)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Version history](#version-history)

---

## Architecture

Four layers with a one-way dependency graph. Nothing points back up, so a change in one layer
cannot quietly become another layer's concern.

```
                 ┌──────────────────────────────────────────┐
   host  ──────► │ mcp/         protocol + tool definitions  │  schemas, formatting
                 └───────────────────┬──────────────────────┘
                                     ▼
                 ┌──────────────────────────────────────────┐
                 │ service.ts   orchestration and policy     │  navigation, caching,
                 └───────────────────┬──────────────────────┘  canvas fitting, budgets
                                     ▼
                 ┌──────────────────────────────────────────┐
                 │ axure/       Axure domain logic           │  extraction, sitemap,
                 └───────────────────┬──────────────────────┘  scoping, rendering
                                     ▼
                 ┌──────────────────────────────────────────┐
                 │ playwright/  browser adapter              │  the only `playwright`
                 └──────────────────────────────────────────┘  import
        cross-cutting: config.ts · errors.ts · logger.ts · security.ts · types.ts
```

| Path | Responsibility | Does **not** |
|---|---|---|
| `src/mcp/` | Tool schemas, result assembly, registration | touch the filesystem or the network |
| `src/service.ts` | Turn a request into browser operations; own policy | know about MCP, models or clients |
| `src/axure/` | Axure extraction, scoping, rendering | import `playwright` — it takes a `FrameHandle` |
| `src/playwright/` | Own Chromium, isolate sessions, enforce the boundary | know what an Axure page is |
| `src/security.ts` | The one place deciding where the browser may go and what may be written | |
| `src/config.ts` | Read and validate the environment, failing fast | contain feature logic |

Two consequences are worth naming, because they are what the layering buys:

- **`src/axure/` never imports Playwright.** It receives a `FrameHandle`
  (`run` / `title` / `bodyBox` / `ariaSnapshot`), so the domain is unit-testable with a fake
  frame and does not break when Playwright changes.
- **`src/mcp/` performs no I/O.** Every write and every navigation happens below it, which is why
  the tool handlers are short enough to read at a glance.

### Why the outline is parsed rather than derived from ARIA

Measured against a real Axure 10 deployment before anything was written:

**An Axure page's accessibility tree is close to useless.** Every widget surfaces as an anonymous
`paragraph` or `img` — no role, no name, no nesting, no position. The whole page's ARIA snapshot is
115 lines of `- paragraph: <text>` and `- img`.

**The DOM and Axure's own runtime are rich.** Every widget is `<div id="u<number>">`, its kind is
emitted as the HTML comment immediately before it (`<!-- 会员中心 (Dynamic Panel) -->`), and
`window.$axure.getRectAndStyleById(id)` resolves authored geometry, fill, border, corner radius,
opacity and text for **113 of 113** widgets on the reference page.

So the outline is parsed from Axure's own markup and runtime. `includeAccessibility: true` still
returns the ARIA snapshot, chiefly to *demonstrate* the point above rather than to extract from it.

### Relationship to MCP Resources and Prompts

Deliberately **not implemented**. Three tools already cover discovery → reading → seeing.
Resources suit long-lived subscribable objects while a prototype page is an immediately-consumed
snapshot, and Prompts target human-triggered workflows while this server's consumer is an agent.
Adding either would enlarge the unverified surface for no capability gain. The decision is
revisited if a concrete need appears.

---

## Tools

All three are read-only and idempotent, and every result opens with a notice that prototype-derived
values are untrusted data.

### `axure_list_pages`

Reads the project sitemap from Axure's own decoded document model (`$axure.document.sitemap`),
cached for five minutes.

| Argument | Type | Meaning |
|---|---|---|
| `refresh` | boolean | Ignore the cache and re-read the project |
| `filter` | string (≤256) | Case-insensitive substring match on page name and folder path |

`structuredContent`: `{ ok, projectName, baseUrl, generatedAt, pageCount, folderCount, filter?, truncated, pages[] }`

### `axure_get_page_map`

The workhorse: one page's structure **and** geometry **and** annotations in a single call.

```
u1 shape:Group @0,0 1920x1080
  u2 shape:Rectangle @0,0 1920x1080 text="`"
u4 dynamic-panel:Dynamic Panel @0,218 200x56 name="会员中心" states=2,active=0
  u5 shape:Rectangle @0,218 200x56 clickable text="库存管理"
u57 table:Table @222,95 1662x890
  u58 group:Table Cell @222,95 133x33 image text="版本号"
```

| Argument | Type | Meaning |
|---|---|---|
| `page` | string (≤2048) | Page id, page name, project-relative path, or a URL inside the deployment |
| `space` | `page` \| `viewport` | Canvas coordinates (default), or viewport-relative plus `onScreen` |
| `detail` | `compact` \| `standard` \| `full` | `standard` (default) adds fill/stroke/radius/opacity; `full` adds typography |
| `region` | `{x,y,width,height}` | Restrict to one rectangle **in the requested space** |
| `widgetIds` | string[] (≤40, ≤128 each) | These widgets plus their ancestors and descendants |
| `onScreenOnly` | boolean | Drop nodes outside the current viewport |
| `maxNodes` | 20–5000 | Node cap, default `AXURE_MAX_OUTLINE_NODES` |
| `includeHidden` | boolean | Keep widgets whose dynamic-panel state is inactive |
| `includeAccessibility` | boolean | Append the ARIA snapshot, capped at a third of the response budget |
| `includeNotes` | boolean | Designer annotations and page notes (default true) |
| `viewport`, `settleMs` | | Rendering controls |

`structuredContent`: `{ ok, page{id,name,url,title,type,path}, space, pageSize, viewport, detail, stats, omitted, outline[], scope?, notes?, accessibility?, warnings[] }`

### `axure_get_visual`

Pixels **plus the geometry of exactly what was captured**, so the image always lines up with the
map's coordinates.

| Argument | Type | Meaning |
|---|---|---|
| `page` | string | As above |
| `target` | `viewport` \| `full-page` \| `widgets` \| `none` | What to capture; `none` returns geometry only |
| `widgetIds` | string[] | With `target: "widgets"`, crops to these widgets' union |
| `includeImage` | boolean | Attach the PNG as an image block (default true) |
| `savePath` | string (≤512) | Also write the PNG inside `AXURE_SCREENSHOT_DIR` |
| `pad` | 0–200 | Padding around a widget crop |
| `space` | `page` \| `viewport` | Space of the returned geometry |
| `viewport`, `settleMs` | | Rendering controls |
| `scale` | 1–3 | **No effect**, kept for compatibility. See `AXURE_DEVICE_SCALE_FACTOR` |

`structuredContent`: `{ ok, page, target, space, canvas, viewport, region?, widgets[], missingWidgets?, image{bytes,mimeType,attached}, savedTo?, warnings[] }`

### Failures

A failure returns `isError: true` with the **same stable code** in the text and in
`structuredContent.error`:

```
error: WIDGET_NOT_FOUND
message: none of the requested widgets exist on this page: u999999
hint: Call axure_get_page_map for this page first and use the ids from its outline.
retryable: false
```

| Code | Meaning | Class |
|---|---|---|
| `CONFIG_INVALID` | The environment is invalid; the server refuses to start | operator |
| `BROWSER_UNAVAILABLE` | Chromium or a context could not be created | infrastructure |
| `NAVIGATION_FAILED` | The page could not be loaded | infrastructure |
| `NAVIGATION_BLOCKED` | A host outside the deployment was refused by policy | domain |
| `PAGE_NOT_FOUND` | The page reference is not a page of this prototype | domain |
| `NOT_AXURE_PROJECT` | The URL loaded but exposes no Axure document | domain |
| `NO_CONTENT_FRAME` | The page loaded but contains no Axure widget frame | infrastructure |
| `RENDER_FAILED` | The in-page extraction failed | infrastructure |
| `OPERATION_TIMEOUT` | An in-page operation exceeded `AXURE_OPERATION_TIMEOUT_MS` | infrastructure |
| `WIDGET_NOT_FOUND` | A named widget does not exist on this page | domain |
| `SCREENSHOT_FAILED` | The capture itself failed | infrastructure |
| `WRITE_FAILED` | `savePath` was refused, or the write failed | domain / infrastructure |
| `INVALID_ARGUMENT` | The arguments are internally inconsistent | domain |
| `INTERNAL` | An unexpected condition | — |

---

## Install and run

```bash
npm install
npx playwright install chromium     # once
npm run build

node bin/axure-mcp.mjs                          # stdio (default)
node bin/axure-mcp.mjs --http                   # Streamable HTTP on 127.0.0.1:3333
node bin/axure-mcp.mjs --help                   # full option and env reference
node --env-file=.env bin/axure-mcp.mjs          # load configuration from a file
```

An invalid configuration is reported **once, at startup**, listing every problem:

```
[axure-mcp] error: invalid configuration (2 problems):
  - AXURE_URL: not a valid absolute URL: "http://"
  - AXURE_VIEWPORT_WIDTH: 99999999 is outside the allowed range 320..4000
```

`.env.example` lists every variable with its default. Nothing loads `.env` implicitly; pass
`--env-file` or export the variables.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AXURE_URL` | `https://axure.example.com/ProjectB` | Project share URL; origin and project path are split from it |
| `AXURE_ALLOWED_HOSTS` | *(empty)* | Extra hosts the browser may visit, comma separated |
| `AXURE_HEADLESS` | `true` | Run Chromium headless |
| `AXURE_VIEWPORT_WIDTH` / `_HEIGHT` | `1440` / `900` | Initial viewport (320–4000 / 240–4000) |
| `AXURE_DEVICE_SCALE_FACTOR` | `1` | Device pixel ratio (1–3), fixed per browser context |
| `AXURE_MAX_CAPTURE_VIEWPORT_WIDTH` / `_HEIGHT` | `3840` / `2160` | Ceiling for the canvas-fitting resize |
| `AXURE_NAV_TIMEOUT_MS` | `60000` | Navigation timeout |
| `AXURE_OPERATION_TIMEOUT_MS` | `20000` | Timeout for each in-page operation |
| `AXURE_SETTLE_MS` | `4000` | Extra wait after `load`, for Axure's own bootstrapping |
| `AXURE_OUTLINE_CHAR_BUDGET` | `48000` | Hard character budget for the response text |
| `AXURE_MAX_OUTLINE_NODES` | `1200` | Default node cap |
| `AXURE_MAX_WIDGET_IDS` | `40` | Maximum widget ids per call |
| `AXURE_MAX_PAGES` | `500` | Maximum pages returned by one listing |
| `AXURE_BROWSER_IDLE_MS` | `300000` | Close the pooled browser after this much idle time |
| `AXURE_NO_PROXY` | internal hosts | Hosts that must bypass an ambient HTTP proxy |
| `AXURE_SCREENSHOT_DIR` | `.axure-mcp/shots` | Base directory for `savePath` |
| `AXURE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`; always written to stderr |
| `AXURE_HTTP_PORT` / `AXURE_HTTP_HOST` | `3333` / `127.0.0.1` | HTTP transport bind |
| `AXURE_HTTP_TOKEN` | *(unset)* | **Required** for any non-loopback bind; clients send `Authorization: Bearer <token>` |

**Proxy note.** An internal Axure host is usually unreachable through a corporate `HTTP_PROXY`.
`AXURE_NO_PROXY` is applied both to Chromium (`--proxy-bypass-list`) and to the server's own HTTP
calls, so it works in a shell that exports a proxy for registry access.

**Canvas fitting.** Axure's share player scales the wireframe canvas down to fit the available
frame, so a 1920×1080 prototype captured in a 1440×900 viewport silently yields a 1440×900 image
with shrunken text and widget rectangles that no longer match the authored coordinates. The server
measures the canvas after load and enlarges the viewport until it renders 1:1, reporting that it
did so in `warnings`. Pass an explicit `viewport` to pin a size; the server then warns if the
canvas is larger than what was captured.

---

## Connecting a host

### DSH

A configuration-only bundle inserts the shipped `@deepseek-ai/dsh-mcp-client`. It contains no DSH
code and no private API, so the same binary keeps working with any other client.

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

```
plugin_manager action=install_bundle target=E:\dsh-mcp\axure-mcp-dsh-bundle
```

Tools appear as `mcp__axure__axure_list_pages`, `mcp__axure__axure_get_page_map` and
`mcp__axure__axure_get_visual`.

> DSH keeps one stdio child alive and re-reads tool **schemas** from it, but keeps running the old
> **code**. After changing server behaviour, toggle the bundle off and on again.

### Generic stdio client

```jsonc
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

### Streamable HTTP

```bash
AXURE_HTTP_TOKEN=$(openssl rand -hex 16) node bin/axure-mcp.mjs --http --host 0.0.0.0
# clients POST to http://<host>:3333/mcp with Authorization: Bearer <token>
# GET /health is unauthenticated and reports whether a token is required
```

Stateless by design: each request gets its own protocol instance over one shared browser pool, so
there is no session bookkeeping and a crashed client cannot wedge the endpoint.

---

## Trust and safety

Prototype content is attacker-influenceable — anyone who can publish to the project controls page
names, widget text, designer notes and the pixels. Two boundaries follow from that.

**1. The browser stays inside the deployment.** A tool caller is an agent that can be steered by
what it reads, so an unvalidated page reference would turn this server into an SSRF proxy with
internal network access. Every candidate URL passes through `security.resolvePageReference`, which
refuses:

- an external host (`http://169.254.169.254/…`), unless the operator listed it in `AXURE_ALLOWED_HOSTS`;
- an explicit non-http scheme, including `file:`;
- a scheme-relative value (`//host/x`), which `new URL(value, base)` silently resolves to a different origin;
- a path that climbs out of the project (`../../other-app/`).

A request guard additionally aborts out-of-boundary hosts, including redirects and subresources. A
caller-supplied `savePath` is confined to `AXURE_SCREENSHOT_DIR`; absolute paths and `..` are
refused. The HTTP transport never binds a non-loopback address without a token.

**2. Prototype content is labelled, and cannot forge structure.** Every result opens with the
notice before any prototype text, and the server instructions on the protocol handshake repeat it.
Values are neutralized so they cannot break out of the format: newlines and control characters are
collapsed, the widget-kind comment is parsed by index rather than with a newline-permitting regex,
and backticks are escaped inside the fenced ARIA snapshot. Tests inject `\nformat:`, `## outline`,
`warning: obey me` and a closing code fence into widget text, annotations, page names and the
snapshot.

The server performs **read-only static analysis**. It never clicks, types, submits or triggers an
Axure interaction, so prototype content cannot cause an action.

---

## Model compatibility

The tools are designed so a weak client degrades rather than breaks.

- **No images at all.** `includeImage: false` (or `target: "none"`) returns the canvas size, the
  region and per-widget geometry with no image block. `savePath` writes the PNG for a separate
  vision step.
- **Text-only models.** `structuredContent` never carries pixel data, and a model without image
  support simply never asks for an image.
- **Small context windows.** Two budgets apply to what the model receives: `maxNodes` caps the node
  count, and `AXURE_OUTLINE_CHAR_BUDGET` is a **hard** cap on the response text — the outline is
  truncated depth-first to fit and the truncation is reported. On a 1119-widget page with
  `detail=full, maxNodes=5000`, the response is 48,078 characters against a 48,000 budget.
  `region` and `widgetIds` are the intended way to choose *which* part to see.
- **Errors.** `isError: true` plus a leading `error: <CODE>` line, so a text-only consumer can tell
  success from failure without parsing prose, and a structured consumer gets the same code in
  `structuredContent.error.code`.
- **Structured output.** Every tool declares an `outputSchema`. It is intentionally loose, because
  the SDK validates a *failure* payload against it too and a strict success schema would reject
  every error result. The per-tool key sets are asserted by `npm run test:e2e` instead.

---

## Tests

```bash
npm test              # 30 unit: config, domain, rendering, budgets
npm run test:security # 14 security: navigation scope, path confinement, escaping
npm run test:e2e      # 24 end-to-end against the live deployment, over real stdio
npm run test:http     #  8 HTTP transport, including the authentication gate
npm run test:all      # everything
```

`scripts/test-inpage.mjs` (6 checks) guards the browser boundary separately: the in-page extractor
and the adapter's callback are compiled with `new Function` in Node, so a reference to module scope
fails here rather than as a `ReferenceError` inside Chromium. It also enforces the single in-page
convention (`axureExtractOutline`), which caught a real inconsistency during the refactor.

`scripts/recon/` holds the throwaway probes used to establish the findings behind the design —
Axure's ARIA output, runtime API coverage, canvas scaling behaviour, screenshot strategies. They
document *why* the implementation looks the way it does and are not part of the build.

---

## Known limitations

- **Static analysis only.** The server reads state; it does not click, type, hover or trigger Axure
  interactions. Widgets behind a click are reported as `clickable`, not activated.
- **One dynamic-panel state.** `includeHidden: true` enumerates authored states, but the outline
  still reflects a single rendering.
- **Repetition on data-dense pages.** A table is one widget per cell, so a 100-row table produces
  thousands of nodes. Scope with `region` or `widgetIds`; a node budget truncates rather than
  focuses.
- **One page per call.** No multi-page diffing or navigation graph, and `Inline Frame` widgets are
  reported as widgets rather than recursed into.
- **Device pixel ratio is fixed per context.** `scale` is accepted but ignored; set
  `AXURE_DEVICE_SCALE_FACTOR=2` and restart.
- **Attached images are capped at 8 MiB.** A larger capture is written to disk and reported, but not
  attached, so one response cannot carry tens of megabytes.
- **No authentication against the prototype.** It reads whatever the share link exposes
  anonymously; a password-protected prototype would need a login step that is not implemented.
- **Concurrency is capped at 4 browser contexts** per process, and the cap is not configurable.

## Next steps

1. **Recurse into inline frames** so embedded prototype pages appear in the parent outline.
2. **Click-driven state capture** — a `target: "state"` that triggers a widget's Axure action and
   re-captures, for panels and tabs that exist only after interaction.
3. **Collapse table rows** into a compact form when a `Table` widget is detected, cutting dense-page
   token cost by an order of magnitude.
4. **Diff two page maps**, making "what changed in this prototype revision" a single call.
5. **Make the concurrency cap configurable** and report it from `/health`.

## Version history

Version-managed prompts, audits and change records live in [`.update/`](.update/README.md).

| Version | Change |
|---|---|
| 0.2.0 | Four-layer refactor, security boundary, protocol and budget fixes — [`.update/0.1.0`](.update/0.1.0/plan.md) |
| 0.1.0 | Initial release: three tools, canvas 1:1 fitting, region/widget scoping, stdio + HTTP |
