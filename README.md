# Axure Prototype MCP

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that gives any
MCP-compatible host **structural, spatial, visual and interaction** access to an Axure prototype
published as a share link.

```
structure + space + visual + interaction, for the same page, in one call each:

  axure_list_pages         -> what pages exist             (cheap discovery)
  axure_get_page_map       -> what is where, plus text     (the workhorse; format=standard for the
                                                           provenance-marked document)
  axure_get_visual         -> the matching pixels          (coordinates stay aligned)
  axure_get_interactions   -> what responds to input       (facts vs. guesses, labelled)
```

It has no dependency on any particular host, model or client library: one `npm install`, one
`node bin/axure-mcp.mjs`, and it speaks standard MCP over **stdio** or **Streamable HTTP**.

- [Axure Prototype MCP](#axure-prototype-mcp)
  - [Architecture](#architecture)
    - [Why the outline is parsed rather than derived from ARIA](#why-the-outline-is-parsed-rather-than-derived-from-aria)
    - [Where interaction data actually lives](#where-interaction-data-actually-lives)
    - [Relationship to MCP Resources and Prompts](#relationship-to-mcp-resources-and-prompts)
  - [Tools](#tools)
    - [`axure_list_pages`](#axure_list_pages)
    - [`axure_get_page_map`](#axure_get_page_map)
      - [The standard document (`axure.page/v1`)](#the-standard-document-axurepagev1)
        - [Conversion rules](#conversion-rules)
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
| Interaction logic + rendering | `npm run test:interaction` (first) | 35/35 |
| In-page reader | `npm run test:interaction` (second) | 20/20 |
| Standardization | `npm run test:standard` | 36/36 |
| End-to-end (live prototype, real stdio) | `npm run test:e2e` | 52/52 |
| HTTP transport | `npm run test:http` | 8/8 |

Measured on the reference prototype, `format="standard"` for 订单管理 (`w2yv7l`) at
`maxNodes=300`, as asserted by `npm run test:e2e`:

| Metric | Value |
|---|---|
| Widgets the extractor saw | 1119 |
| Elements in the document | 300 (131 roots, depth 3) |
| Roles established from structural evidence | 300 of 300 |
| Relations published | 223 (`contains` 169, `duplicates-text-of` 54) |
| Interactions carried, from the same page load | 94 (6 declared, 88 inferred) |
| Interaction records naming an omitted element | **0** |
| Relations with a missing endpoint | **0** |
| Text | 96 distinct of 150 occurrences |
| Capture omissions reported | `empty-group`, `off-canvas`, `decorative-shape`, `node-budget` |

The last two rows are invariants, not incidental counts, and the suite asserts them: because
interaction-bearing elements are exempt from the node budget, a reader can always resolve a record
to the element it is about.

Exact relation and text counts vary slightly run to run (the outline is re-read from a live page),
so treat them as representative; `elements`, `roots`, the role split and the interaction counts are
stable.

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

Inside `src/axure/`, the interaction and standardization features are split by **what can be
verified without a browser**:

| File | Role | Tested by |
|---|---|---|
| `interaction.ts` | Pure reasoning: evidence levels, trigger/action normalization, aggregation | `test-interaction.mjs` (fixtures) |
| `interaction-source.ts` | The in-page reader, as a plain JS string | `test-interaction-source.mjs` (compiles and runs it against a synthetic model) |
| `interaction-analyzer.ts` | Decides each record's evidence level from its source | `test-interaction.mjs` |
| `interaction-render.ts` | Text output, keeping facts and guesses in separate sections | `test-interaction.mjs` |
| `standard.ts` | **The parsing layer**: raw captures → the `axure.page/v1` document. Pure, takes no `FrameHandle` and does no I/O | `test-standard.mjs` (fixtures) |
| `standard-render.ts` | Bounded text rendering of a standard document | `test-standard.mjs` (via `test:e2e` for the live shape) |

`standard.ts` is the piece the 0.2.1 requirements call the 「解析层」, and its separation from the
reading layer is what 「原始数据读取层与解析层应保持解耦」 asks for: it receives already-read data as
arguments and returns a value, so every conversion rule — including the prohibition on inferring
business meaning — is testable with no browser, no network and no prototype.

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

Deliberately **not implemented**. The four tools already cover discovery → reading → seeing → interacting.
Resources suit long-lived subscribable objects while a prototype page is an immediately-consumed
snapshot, and Prompts target human-triggered workflows while this server's consumer is an agent.
Adding either would enlarge the unverified surface for no capability gain. The decision is
revisited if a concrete need appears.

---

## Tools

All four are read-only and idempotent, and every result opens with a notice that prototype-derived
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
| `format` | `outline` \| `standard` | See below. Default `outline` keeps the legacy shape |
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

| `includeNotes` | boolean | Include designer annotations (default true) |
| `format` | `outline` \| `standard` | Output shape. `outline` is the default and is described above; see [The standard document](#the-standard-document-axurepagev1) |

#### The standard document (`axure.page/v1`)

`format="standard"` returns a **versioned, model-agnostic document** instead of the flat outline.
It answers a question the outline cannot: *for each value, is this something the prototype states,
something this server computed, or something nobody determined?* It also returns structure and
interactions together, from one page load, so a consumer does not have to join two shapes by hand.

```jsonc
{
  "schema": "axure.page/v1",              // the field to branch on
  "page":     { "id": "w2yv7l", "name": "订单管理", "url": "...", "title": "...",
                "authoredType": "Wireframe", "path": ["MES系统", "生产计划"] },
  "capture":  { "space": "page", "detail": "standard",
                "canvas":   { "width": 1920, "height": 1080 },
                "viewport": { "width": 1440, "height": 900, "scrollX": 0, "scrollY": 0 },
                "at": "2026-05-14T09:12:33.001Z" },
  "elements": [ /* top-level elements; children are reachable through childIds */ ],
  "elementsById": { "u575": { /* the same elements, keyed by raw id */ } },
  "relations": [ { "id": "rel1:contains:u1->u2", "kind": "contains",
                   "from": "u1", "to": "u2",
                   "provenance": "derived", "rule": "structure/containment" } ],
  "text": { "entries": [ { "text": "库存管理", "elementIds": ["u5", "u7"],
                           "occurrences": 2, "from": "widget-text" } ],
            "totalOccurrences": 150, "distinctTexts": 96, "droppedEmpty": 0 },
  "interactions": { "items": [ /* the same records axure_get_interactions returns */ ],
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

Counts are from a real run; relation and text totals move slightly between runs because the page is
re-read live.

An element, with the provenance marks that are the point of the shape:

```jsonc
{
  "id": "u1363",                       // raw prototype id, always preserved
  "ref": "w2yv7l#u1363",               // stable handle for follow-up calls
  "parentId": "u12", "childIds": ["u1364"], "depth": 2,
  "authoredType": "Checkbox",           // the prototype's own token, verbatim
  "role": { "value": "input",           // derived…  (or { "provenance": "unknown",
            "provenance": "derived",    //            "reason": "unrecognized-value",
            "rule": "classify/role-from-authored-type(checkbox)" },  // "detail": "…" })
  "geometry": { "x": 539, "y": 375, "width": 12, "height": 16,
                "onScreen": true, "visible": true,
                "provenance": "derived", "rule": "capture/geometry" },
  "text": "库存管理",
  "interactionRefs": ["w2yv7l#u1363"]
}
```

| Field | Meaning |
|---|---|
| `schema` | Constant `axure.page/v1`. Branch on this, not on field presence |
| `elements` | **Top-level** elements only. The tree is `childIds`; walk it, do not read `elements` as a flat list |
| `elementsById` | Every element at any depth, keyed by raw id. Interaction-bearing elements and their ancestors are exempt from `maxNodes`, so every entry in `interactions.items` resolves here — the e2e suite asserts that. A relation endpoint always resolves too |
| `authoredType` | The prototype's own widget type token, never normalized |
| `role` | A discriminated union. Either `{ value, provenance, rule }`, or `{ provenance: 'unknown', reason, detail }` |
| `geometry` | Always `derived` — the capture measured and normalized it |
| `relations[].kind` | `contains`, `targets`, `switches-state-of`, `duplicates-text-of` |
| `relations[].provenance` | `fact` when it comes from the project model, `derived` when this server worked it out |
| `relations[].evidence` | For interaction-derived relations, the record's `declared`/`observed`/`inferred` level |
| `text.entries[].occurrences` | How many carriers were collapsed into one entry. `elementIds` lists them |
| `text.droppedEmpty` | Whitespace-only runs that were discarded — counted, never silently lost |
| `omitted` | Nodes dropped by scoping/budgeting, by reason |
| `gaps` | Sources that could not be read, and what a consumer therefore cannot see |
| `stats.rolesUnknown` | How many elements have no determinable role. Equal to the `unknown` count in `byRole` |

**`structuredContent.document` carries the whole document; only the text rendering is budgeted.**
That split is deliberate: bounding the prose must never lose the data.

#### Conversion rules

The raw read is turned into the document above by `src/axure/standard.ts`, a pure function. Every
rule is listed here with its id, because that id appears in the output as `role.rule`,
`geometry.rule` or `relations[].rule` — so a derived value always names how it was derived.

| Rule id | Input | Output | Notes |
|---|---|---|---|
| `capture/geometry` | the extractor's measured rect, already normalized | `geometry.{x,y,width,height,onScreen,visible}` | Always `derived`: the capture measured and rounded it |
| `capture/depth` | DOM nesting from the extractor | `depth`, `parentId`, `childIds` | The hierarchy is rebuilt as explicit links rather than left implicit in nesting |
| `classify/role-from-authored-type(...)` | the prototype's own `friendlyType` token | `role.value` | A fixed structural table: `Rectangle → shape`, `Dynamic Panel → state-container`, `Table → repeating-container`, `Text Field → input`, … |
| `classify/role-from-structure(...)` | the extractor's bucket, or a non-empty image URL | `role.value` | Used only when the type token is unrecognized, and trusted only where it cannot mislead: `group → container`, `input → input`, `image → image` |
| — (no rule applies) | nothing structural matched | `role = { provenance: 'unknown', reason, detail }` | `not-authored` when the prototype named no type; `unrecognized-value` when it named one this server does not cover |
| `structure/containment` | parent/child links | a `contains` relation per edge | One edge per child, so `contains = elements − roots` |
| `interaction/target` | `action.targets[].widgetId` | a `targets` relation | Only when the target exists in this document; an unresolvable target stays visible in the interaction record instead of becoming a fabricated node |
| `interaction/panel-target` | `action.panelId`, already resolved by the reader | a `switches-state-of` relation | `provenance: fact` when the interaction is `declared`, `derived` otherwise |
| `text/dedup` | identical text runs | one `text.entries` bucket plus a `duplicates-text-of` relation | The collapse is reported, never silent |

Normalization is lossless where it matters: `authoredType` keeps the prototype's token verbatim
even when `role` is `unknown`; whitespace-only text is dropped **and counted** in
`text.droppedEmpty`; and text clipped by a budget records its untruncated length in
`textTruncated.length`.

### `axure_get_interactions`

Reports which widgets respond to input, and what each one does. Triggers and actions are read
from the project model, never guessed from appearance.

| Argument | Type | Meaning |
|---|---|---|
| `page` | string | As above |
| `includeInferred` | boolean | Include `inferred` guesses (default true) |
| `maxWidgets` | 1–2000 | Cap on model entries read (default 400) |
| `format` | `interactions` \| `standard` | `interactions` is the default and is described below; `standard` returns the same `axure.page/v1` document `axure_get_page_map` produces |
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

Tools appear as `mcp__axure__axure_list_pages`, `mcp__axure__axure_get_page_map`,
`mcp__axure__axure_get_visual` and `mcp__axure__axure_get_interactions`.

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
npm run test:interaction  # 35 interaction logic + 20 in-page reader = 55
npm run test:standard     # 36 standardization: roles, provenance, hierarchy, dedup, bounding
npm run test:inpage       #  6 browser-boundary: in-page convention and isolation
npm run test:e2e          # 52 end-to-end against the live deployment, over real stdio
npm run test:http         #  8 HTTP transport, including the authentication gate
npm run test:all          # everything
```

Four of these are worth explaining, because they are what makes this feature testable.

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

`scripts/test-standard.mjs` covers the conversion, which is a pure function of already-read data.
Its most important assertions are negative ones: that a role is `unknown` rather than guessed when
no structural rule applies, and that `classifyRole` cannot read a widget's name or text at all — it
is probed with a `Proxy` and the test fails if it touches such a field. That turns
「不得仅凭组件名称或视觉外观臆造业务含义」 from a promise into a check.

`npm run test:e2e` cross-checks the interaction counts against numbers measured by an independent
recon probe (`scripts/recon/probe-interaction-coverage.mjs`), so a silent regression to zero or a
surge of invented records both fail the suite. It also asserts that the standard document's
hierarchy is walkable, that every role carries provenance, that an `unknown` role has a reason
instead of a value, and that the legacy `outline` default is unaffected by the new option.

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
- **Roles are structural, never semantic.** The standard document reports `input`, `shape`,
  `state-container` and so on, derived only from the authored widget type, a form tag or an image
  asset. It will not tell you that a widget is "a submit button for the order form". A widget named
  订单管理 is not thereby an order-management component, and a `Rectangle` with a pointer cursor is
  not thereby a button. Where no structural rule applies the role is `unknown` with a reason, and the
  authored type is always preserved beside it. This is a deliberate boundary, not a gap to be closed
  by a cleverer heuristic.
- **Duplicate subtrees are not merged.** Two identical-looking widgets are two widgets: they have
  different ids and may be genuinely distinct. What is deduplicated is *text*, through
  `text.entries[].occurrences`, with a `duplicates-text-of` relation recording what was collapsed.
  Merging elements instead would destroy exactly the information this layer exists to preserve.
- **`structuredContent` is bounded by `maxNodes`, not by the character budget.** Only the text
  rendering is text-budgeted, so a consumer always receives the whole document while a model's
  context is protected. Raise `maxNodes` deliberately, not by accident.
- **A dense page's element list can consume the whole text budget**, in which case the
  `## gaps and omissions` section is dropped and only the trim note is shown. The omission is
  disclosed, but the priority order is wrong; see [Next steps](#next-steps).

## Next steps

1. **Recurse into inline frames** so embedded prototype pages appear in the parent outline.
2. **Trigger-driven capture** (`observed`): fire one interaction in an isolated context and record
   what changed, which is the only way to learn a branch outcome that the model expresses
   indirectly.
3. **Collapse table rows** into a compact form when a `Table` widget is detected, cutting dense-page
   token cost by an order of magnitude. The standard document's `text.entries[].occurrences` and
   `repeating-container` role are the hooks for this.
4. **Diff two standard documents**, making "what changed in this prototype revision" a single call.
   `schema` is versioned and relation ids are deterministic, so two documents from one page are
   directly comparable.
5. **Reserve budget for the tail sections.** Today a dense page's element list can consume the whole
   character budget, so `## gaps and omissions` is dropped and only the trim note appears. The
   disclosure is honest but the priority order is wrong.
6. **Make the concurrency cap configurable** and report it from `/health`.

## Version history

Version-managed prompts, audits and change records live in [`.update/`](.update/README.md).
[README.zh-CN.md](README.zh-CN.md) is the Chinese version of this document.

| Version | Change |
|---|---|
| 0.2.1 | Standardized output: the versioned `axure.page/v1` document with per-value provenance, an explicit hierarchy and relation graph, a deduplicated text index, and structure + interactions in one call — [`.update/0.2.1`](.update/0.2.1/plan.md) |
| 0.2.0 | Interaction recognition: `axure_get_interactions`, the `declared`/`observed`/`inferred` evidence model — [`.update/0.2.0`](.update/0.2.0/plan.md) |
| 0.1.0 | Initial release: three tools, canvas 1:1 fitting, region/widget scoping, stdio + HTTP, four-layer refactor |

The version recorded here tracks the iteration directory, which is the authority. Earlier revisions
of this table labelled the 0.2.0 iteration `0.3.0` while `package.json` moved ahead of it; both now
read `0.2.1`.
