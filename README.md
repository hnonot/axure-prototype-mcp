# Axure Prototype MCP

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that gives any
MCP-compatible host **structural, spatial, visual and interaction** access to an Axure prototype
published as a share link.

```
structure + space + visual + interaction, for the same page, in one call each:

  axure_list_pages         -> what pages exist             (cheap discovery)
  axure_get_page_map       -> what is where, plus text     (the workhorse)
  axure_get_visual         -> the matching pixels          (coordinates stay aligned)
  axure_get_interactions   -> what responds to input       (facts vs. guesses, labelled)
```

It has no dependency on any particular host, model or client library: one `npm install`, one
`node bin/axure-mcp.mjs`, and it speaks standard MCP over **stdio** or **Streamable HTTP**.

- [Axure Prototype MCP](#axure-prototype-mcp)
  - [Architecture](#architecture)
    - [Why the outline is parsed rather than derived from ARIA](#why-the-outline-is-parsed-rather-than-derived-from-aria)
    - [Relationship to MCP Resources and Prompts](#relationship-to-mcp-resources-and-prompts)
  - [Tools](#tools)
    - [`axure_list_pages`](#axure_list_pages)
    - [`axure_get_page_map`](#axure_get_page_map)
    - [`axure_get_visual`](#axure_get_visual)
    - [`axure_get_interactions`](#axure_get_interactions)
    - [Failures](#failures)
  - [Install and run](#install-and-run)
  - [Configuration](#configuration)
  - [Connecting a host](#connecting-a-host)
    - [DSH](#dsh)
    - [Generic stdio client](#generic-stdio-client)
    - [Streamable HTTP](#streamable-http)
  - [Trust and safety](#trust-and-safety)
  - [Model compatibility](#model-compatibility)
  - [Tests](#tests)
  - [Known limitations](#known-limitations)
  - [Next steps](#next-steps)
  - [Version history](#version-history)

## Verification status

All four tools are implemented and **verified against a live Axure deployment**
(`https://axure.example.com/ProjectB`, Axure 10). The numbers below are from actual runs, and the interaction
findings were cross-checked with an independent recon probe before the tool existed.

| Suite | Command | Result |
|---|---|---|
| Build | `npm run build` | clean |
| Unit | `npm test` | 30/30 |
| Security | `npm run test:security` | 14/14 |
| Browser boundary | `npm run test:inpage` | 6/6 |
| Interaction logic + rendering | `npm run test:interaction` (first) | 34/34 |
| In-page reader | `npm run test:interaction` (second) | 20/20 |
| End-to-end (live prototype, real stdio) | `npm run test:e2e` | 35/35 |
| HTTP transport | `npm run test:http` | 8/8 |

Measured interaction coverage on the reference prototype:

| Page | Widgets | With interactions | Cases | Events | Actions |
|---|---|---|---|---|---|
| 订单管理 `w2yv7l` | 1119 | 6 | 12 | `onClick` | `setFunction` ×12 |
| 版本更新记录 `6k5oyo` | 113 | 18 | 18 | `onClick` | `setPanelState` ×8, `linkWindow` ×10, `setFunction` ×10 |
| 工单管理 `b8yrp4` | 833 | 6 | 12 | `onClick` | `setFunction` ×12 |

**What is not verified** — stated plainly rather than implied:

- **Only `onClick` was observed.** Hover, input, selection, keyboard and page-load triggers have
  normalization rules but **no measured sample**, because every interaction in this prototype is a
  click. Their handling is therefore untested.
- **`linkWindow` destinations are unknown.** The measured payload's `target` carries only
  `targetType: "page"` and no `pageId`, so a link action reports `Open Link` **without inventing a
  destination**. This is a capability boundary, not a bug to paper over.
- **`observed` is never produced.** This tool does not fire interactions (doing so changes page
  state and is a separate risk), so that evidence level has a complete data structure and
  constructor but no live sample.
- **Other Axure versions are untested.** Every conclusion comes from this one Axure 10 deployment.

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
| `src/axure/` | Axure extraction, scoping, interaction analysis, rendering | import `playwright` — it takes a `FrameHandle` |
| `src/playwright/` | Own Chromium, isolate sessions, enforce the boundary | know what an Axure page is |
| `src/security.ts` | The one place deciding where the browser may go and what may be written | |
| `src/config.ts` | Read and validate the environment, failing fast | contain feature logic |

Inside `src/axure/`, the interaction feature is split by **what can be verified without a
browser**, which is what made it testable while the build toolchain was unavailable:

| File | Role | Tested by |
|---|---|---|
| `interaction.ts` | Pure reasoning: evidence levels, trigger/action normalization, aggregation | `test-interaction.mjs` (fixtures) |
| `interaction-source.ts` | The in-page reader, as a plain JS string | `test-interaction-source.mjs` (compiles and runs it against a synthetic model) |
| `interaction-analyzer.ts` | Decides each record's evidence level from its source | `test-interaction.mjs` |
| `interaction-render.ts` | Text output, keeping facts and guesses in separate sections | `test-interaction.mjs` |

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

### Where interaction data actually lives

Established by 16 probes against the live deployment, which refuted three initial assumptions:

| Assumption | Measured reality |
|---|---|
| `$axure.document` is readable | `$axure` in the content frame is a **function** with no `.document`; `$axure.internal` exposes no keys |
| A binding table is reachable on `$axure` | No usable path/id resolver exists |
| DOM appearance is enough | It yields only guesses, and duplicates the model — so it is confined to the `inferred` channel |

The working route: `files/<page>/data.js` is obfuscated, but it passes **real property names** into
`$axure.loadCurrentPage(model)`. Hooking that call with `addInitScript` — before any page script runs
— yields the fully decoded model:

| What | Where |
|---|---|
| Page widget tree | `model.page.diagram.objects`, children under `objs` |
| Masters | `model.masters.<hash>.diagram.objects`, children under `objs` **and** `diagrams[].objects` |
| A widget | `{ id: <32-char hash>, label, friendlyType, interactionMap? }` |
| Its interactions | `interactionMap[event].cases[].actions[]` |

The page map addresses widgets as `u<N>` while the model keys them by hash, so two bridges are
needed — and **neither alone is sufficient**:

1. `model.objectPaths[hash].scriptId` — page-level widgets (measured **1119/1119** exact).
2. A widget's own `scriptIds[0]` — master widgets, which have no `objectPaths` at all (measured
   **18/18** exact).

A page-level button that switches a panel *inside a master* needs both at once, which is why the
reader merges them.

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

### `axure_get_interactions`

Reports which widgets respond to input, and what each one does. Triggers and actions are read
from the project model, never guessed from appearance.

| Argument | Type | Meaning |
|---|---|---|
| `page` | string | As above |
| `includeInferred` | boolean | Include `inferred` guesses (default true) |
| `maxWidgets` | 1–2000 | Cap on model entries read (default 400) |
| `viewport` | object | Rendering control |

`structuredContent`: `{ ok, page, stats, interactions[], gaps[], warnings[] }`

#### The evidence model

Every record states how much is actually known about it. This is the point of the tool: the
iteration requires that a guess is never presented as a confirmed result, so the level travels
**with the data** and a consumer can filter on it mechanically.

| `confidence` | Meaning | Has actions? |
|---|---|---|
| `declared` | The project model states this interaction. A fact. | Yes, with conditions and branches |
| `observed` | The interaction was triggered and this is what changed. A fact, but covering only the one branch that ran. | Yes, for that branch only |
| `inferred` | The widget merely looks interactive (pointer cursor, form element, focusable, ARIA role). A **guess**. | **No** — never |

`inferred` records cannot carry actions by construction: the constructor that builds them has no
parameter that accepts an action list, so no later edit can attach one by forgetting the rule.
Each `inferred` record states its basis in `inferredReason`.

If a source could not be read, the result says so in `gaps` rather than returning a bare empty
list. `declared: 0` **with** a gap means "could not read"; `declared: 0` with **no** gap means
"the model is readable and declares nothing". The response text states which of the two applies,
because conflating them would be exactly the fabrication this feature is designed to avoid.

```
stats: 12 of 113 widgets have interaction information; 9 declared, 0 observed, 3 inferred; 14 branches
actions: set-panel-state=4 navigate=2 show=3 hide=1 wait=1

## declared interactions (facts from the project model)
  p1#u5 <click> "库存管理"
    Case 1 if [[This.text]] equals "x" -> set panel state(widget u4 state=1) ; wait(300ms)

## inferred interactivity (guesses — no actions known)
  p1#u47 <click> — CSS cursor is pointer, which suggests it is meant to be clicked
```

#### What this tool does not do

It **does not click, type or otherwise fire an interaction**. Doing so changes page state, which
is a different capability with a different risk profile, and it is not enabled. `observed` records
are therefore normally absent; the level exists so that adding trigger-driven capture later is an
additive change rather than a schema break.

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
node bin/axure-mcp.mjs --http                   # Streamable HTTP on 127.0.0.1:7458
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
npm test                  # 30 unit: config, security-independent domain, rendering, budgets
npm run test:security     # 14 security: navigation scope, path confinement, escaping
npm run test:interaction  # 34 interaction logic + 20 in-page reader = 54
npm run test:inpage       #  6 browser-boundary: in-page convention and isolation
npm run test:e2e          # 35 end-to-end against the live deployment, over real stdio
npm run test:http         #  8 HTTP transport, including the authentication gate
npm run test:all          # everything
```

Three of these are worth explaining, because they are what makes this feature testable.

`scripts/test-interaction.mjs` needs no browser. The evidence model, trigger and action
normalization, branch decoding, aggregation and rendering all live in `src/axure/interaction.ts`,
which is pure, so the rules — including "an inferred record can never carry actions" — are verified
from fixtures.

`scripts/test-interaction-source.mjs` needs no browser **and no build**. It extracts the in-page
reader's source textually, compiles it with `new Function`, and runs it against synthetic models
replicating the measured structure with a stubbed `window`/`document`. It verifies syntax,
self-containment, that a missing model produces a stated gap instead of a bare empty list, that
payloads are preserved verbatim, that **master** interactions and both id bridges work, that the
widget cap is enforced and reported, and that a model which throws does not crash the reader.

`npm run test:e2e` cross-checks the interaction counts against numbers measured by an independent
recon probe (`scripts/recon/probe-interaction-coverage.mjs`), so a silent regression to zero or a
surge of invented records both fail the suite.

`scripts/recon/` holds the throwaway probes used to establish the findings behind the design —
Axure's ARIA output, runtime API coverage, canvas scaling behaviour, screenshot strategies, and the
16 interaction probes that located the model, the two id bridges, and the real action vocabulary.
They document *why* the implementation looks the way it does and are not part of the build.

---

## Known limitations

- **Static analysis only.** The server reads state; it does not click, type, hover or trigger Axure
  interactions. Widgets behind a click are reported as `clickable`, not activated.
- **Interaction recognition is verified but narrow.** See the verification status above: only
  `onClick` was observed in the reference prototype, `linkWindow` destinations are not recoverable
  from the model, and `observed` has no live sample because this tool never fires interactions.
- **Interaction conditions are paraphrased, not evaluated.** A branch's guard is reported as the
  model wrote it (`conditionString`); the server does not determine which branch a given page state
  would take.
- **Actions behind a conditional branch are all listed**, so a consumer sees mutually exclusive
  outcomes together. The `conditions` field is what distinguishes them.
- **Master instances are not de-duplicated across instances.** One master used twice produces
  records per rendered instance, which differ by DOM id. That is intentional, but the counting
  semantics have not been specifically tested.
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

1. **Verify interaction recognition against a live prototype** and record which model containers
   and property names actually carry interaction data — the first thing to do once the toolchain
   is available.
2. **Recurse into inline frames** so embedded prototype pages appear in the parent outline.
3. **Trigger-driven capture** (`observed`): fire one interaction in an isolated context and record
   what changed, which is the only way to learn a branch outcome that the model expresses
   indirectly.
4. **Collapse table rows** into a compact form when a `Table` widget is detected, cutting dense-page
   token cost by an order of magnitude.
5. **Diff two page maps**, making "what changed in this prototype revision" a single call.
6. **Make the concurrency cap configurable** and report it from `/health`.

## Version history

Version-managed prompts, audits and change records live in [`.update/`](.update/README.md).
[README.zh-CN.md](README.zh-CN.md) is the Chinese version of this document.

| Version | Change |
|---|---|
| 0.3.0 | Interaction recognition: `axure_get_interactions`, the `declared`/`observed`/`inferred` evidence model — [`.update/0.2.0`](.update/0.2.0/plan.md). Implemented but not yet executed; see verification status |
| 0.2.0 | Four-layer refactor, security boundary, protocol and budget fixes — [`.update/0.1.0`](.update/0.1.0/plan.md) |
| 0.1.0 | Initial release: three tools, canvas 1:1 fitting, region/widget scoping, stdio + HTTP |
