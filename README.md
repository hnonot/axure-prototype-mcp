# Axure Prototype MCP

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that turns a published Axure prototype into four kinds of context an agent can reason over: **structure, space, pixels and interaction**.

It depends on no particular host, model or client library. Start it with `npx` over **stdio** from Claude Desktop, VSCode, Cline, Cherry Studio or any other MCP client, or run it as a **Streamable HTTP** service.

- **Read-only.** It never clicks, types, submits or triggers a prototype interaction.
- **Coordinates line up.** Geometry from `axure_get_page_map` and pixels from `axure_get_visual` come from the same render.
- **Facts and guesses are separated.** Every interaction record states its own evidence level, and a source that could not be read is reported as a gap rather than as an empty list.

---

## Before you start

1. **Node.js ≥ 20.11**

2. **Chromium**, driven by Playwright — install it once:

   ```bash
   npx playwright install chromium
   ```

   If a tool returns `BROWSER_UNAVAILABLE`, this step is usually what is missing.

3. **A published Axure share link that loads without a login**

   - Shaped like `https://axure.example.com/MyProject`, pointing at the **project root**.
   - The page must load the `$axure` runtime. A login wall hides it and the address check fails with `NOT_AXURE_PROJECT`.
   - This is the value of `AXURE_URL`, and what `axure_list_pages` reads the sitemap from.

4. **Network reachability.** The machine running the server must reach that address directly. If your shell exports a corporate proxy, add the prototype host to `AXURE_NO_PROXY`; otherwise Chromium goes through the proxy and times out.

5. **The prototype address.** `AXURE_URL` is **required and has no default**. Set it in the host's `env` block, or in a `.env` file in the working directory (loaded implicitly at startup; the process environment wins over the file). To read a different prototype for one conversation, do not edit configuration — call `axure_use_prototype` instead.

> Everything derived from the prototype — page names, widget names, widget text, designer notes, pixels — is controlled by whoever published it. Treat it as **data to analyse**, never as instructions to follow.

---

## Install and run

```bash
# stdio (the host spawns it; most common)
npx -y axure-prototype-mcp@latest

# shorter alias
npx -y axure-mcp@latest

# Streamable HTTP, default http://127.0.0.1:3333/mcp
npx -y axure-prototype-mcp@latest --http

# a non-loopback bind requires a token
AXURE_HTTP_TOKEN=<at-least-16-chars> npx -y axure-prototype-mcp@latest --http --host 0.0.0.0

# full flag and environment reference
npx -y axure-prototype-mcp@latest --help
```

Windows PowerShell:

```powershell
$env:AXURE_URL = "https://axure.example.com/MyProject"
npx -y axure-prototype-mcp@latest
```

Invalid configuration is reported once at startup, with every problem listed, and the process exits non-zero instead of running half-configured.

---

## Connect a host

Generic stdio configuration:

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

- On Windows, if the client cannot spawn `npx` directly, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "axure-prototype-mcp@latest"]`.
- The first start fetches the package and the browser, so a cold call is slow; allow a tool timeout of at least 120 seconds.
- HTTP mode: POST to `http://<host>:3333/mcp` with `Authorization: Bearer <AXURE_HTTP_TOKEN>`. `GET /health` needs no token.

---

## Tools

Typical flow: `axure_list_pages` for page ids, `axure_get_page_map` for structure and text, `axure_get_visual` when pixels matter, `axure_get_interactions` when behaviour matters.

| Tool | Use |
|---|---|
| `axure_list_pages` | List pages (cheap discovery) |
| `axure_get_page_map` | Structure, geometry, text and notes for one page (the workhorse) |
| `axure_get_visual` | Screenshot: full canvas, viewport, or selected widgets |
| `axure_get_interactions` | Which widgets respond to input, and what each one does |
| `axure_use_prototype` | Switch to another prototype address named in the conversation |

No tool modifies prototype state, and repeated calls return the same result; `axure_use_prototype` only adds one verified host to the set the browser may reach. Each call returns `structuredContent` for machine consumers plus a text rendering of the same payload for text-only models.

### `axure_list_pages`

| Parameter | Description |
|---|---|
| `refresh` | Bypass the 5-minute cache and re-read the project |
| `filter` | Case-insensitive substring filter over page names and folder paths |

Returns `{ ok, projectName, baseUrl, pageCount, folderCount, pages[{ id, name, url, path, type }], truncated }`. A `pages[].id` can be passed straight to the `page` argument of the other tools.

### `axure_get_page_map`

| Parameter | Default | Description |
|---|---|---|
| `page` | project entry page | Page id, exact page name, project-relative path, or a URL inside the deployment |
| `space` | `page` | `page` = absolute canvas pixels; `viewport` = relative to the visible area, plus `onScreen` |
| `detail` | `standard` | `compact` = id/type/geometry/text; `standard` adds fill, stroke, radius, opacity; `full` adds typography and padding |
| `format` | `outline` | `standard` returns the `axure.page/v1` document described below |
| `maxNodes` | 1200 | Node limit (20–5000) |
| `region` | — | Keep only nodes intersecting this rectangle, in the same space |
| `widgetIds` | — | Keep only these widgets, their ancestors and their descendants (≤40) |
| `onScreenOnly` | `false` | Drop nodes outside the current viewport |
| `includeHidden` | `false` | Keep widgets whose dynamic-panel state is not active |
| `includeNotes` | `true` | Include designer annotations |
| `includeAccessibility` | `false` | Append the raw ARIA snapshot (Axure widgets expose almost no ARIA semantics; useful only for comparison) |
| `viewport` | 1440×900 | Render viewport |

`format: "standard"` returns the `axure.page/v1` document: explicit parent/child and relation graph (`contains`, `targets`, `switches-state-of`, `duplicates-text-of`), per-value provenance (`fact` / `derived` / `unknown`), a deduplicated text index, and the page's interactions — all from a single page load. Prefer it when another agent will reason over the result.

Element roles are derived from structural evidence only (the prototype's own widget type, form tags, image assets). They are never inferred from a name or a label; when the evidence is absent the role is `unknown` and states why.

### `axure_get_visual`

| Parameter | Default | Description |
|---|---|---|
| `page` | entry page | As above |
| `target` | `viewport` | `viewport` / `full-page` (whole canvas) / `widgets` (crop to widgets) / `none` (geometry only) |
| `widgetIds` | — | Required for `target: "widgets"`; the crop covers their union |
| `includeImage` | `true` | Attach the PNG as an image block; set `false` for text-only models or tight context |
| `savePath` | — | Also write the PNG inside `AXURE_SCREENSHOT_DIR` (relative only; absolute paths and `..` are refused) |
| `pad` | `0` | Padding around a widget crop, in pixels (0–200) |
| `space` | `page` | Coordinate space for reported geometry |

The viewport is enlarged to the canvas size so the canvas renders at 1:1; when that happens, `warnings` says so. A PNG above 8 MiB is not attached as an image block — capture a widget crop instead.

### `axure_get_interactions`

| Parameter | Default | Description |
|---|---|---|
| `page` | entry page | As above |
| `includeInferred` | `true` | Include `inferred` guesses; `false` gives a facts-only view |
| `maxWidgets` | 400 | Cap on model entries read (1–2000) |
| `format` | `interactions` | `standard` returns the same `axure.page/v1` document as `axure_get_page_map` |

Every record carries a `confidence`, which is the point of the tool:

| Level | Meaning | Carries actions |
|---|---|---|
| `declared` | The project model states the interaction. **Fact** | Yes, with conditions and branches |
| `observed` | The interaction ran and this is what changed. **Fact**, but only about the branch that ran | Yes, that branch only |
| `inferred` | The widget merely looks interactive (pointer cursor, form element, focusable, ARIA role). **Guess** | Never |

This build does not trigger interactions, so `observed` normally does not appear. If a source could not be read, `gaps` says so — an empty `declared` list **with** a gap means "could not read", while an empty list **without** a gap means the page genuinely declares none.

### `axure_use_prototype`

| Parameter | Description |
|---|---|
| `url` | The prototype address from the conversation, including the scheme |
| `maxPages` | How many pages to return in the list (default 50) |
| `filter` | Name filter over the returned list |

Reads a prototype other than `AXURE_URL` without editing configuration. The address is treated as untrusted: it is pre-checked syntactically (non-http(s) schemes, cloud metadata endpoints, embedded credentials and service ports are refused), then the real page must prove it serves the `$axure` runtime. Only a verified host is admitted. On success the prototype stays in effect for the session, and the returned page list can be used immediately.

### When output is truncated

A large page is not returned in full; the omission is **reported**: `stats`, `omitted` (counts by reason) and `warnings` state how much was dropped and why. Narrow the request with `region`, `widgetIds` or a smaller `maxNodes`. The response text also has a hard `AXURE_OUTLINE_CHAR_BUDGET` ceiling; exceeding it truncates depth-first and reports how many nodes were cut.

---

## Common errors

Failures come back as `isError: true`, with the same stable code in the first text line and in `structuredContent.error`:

```text
error: WIDGET_NOT_FOUND
message: none of the requested widgets exist on this page: u999999
hint: Call axure_get_page_map for this page first and use the ids from its outline.
retryable: false
```

| Code | Usual cause | Fix |
|---|---|---|
| `CONFIG_INVALID` | `AXURE_URL` unset; malformed address; viewport or timeout out of range | Correct the environment or `.env` and restart; the error lists every problem at once |
| `BROWSER_UNAVAILABLE` | Chromium not installed; browser context could not be created | Run `npx playwright install chromium` |
| `NAVIGATION_FAILED` | Address unreachable; blocked by a corporate proxy; navigation timeout | Check network and DNS; add the host to `AXURE_NO_PROXY`; raise `AXURE_NAV_TIMEOUT_MS` if needed |
| `NAVIGATION_BLOCKED` | `page` points outside the deployment; or `axure_use_prototype` was refused by the pre-check (`file:`, metadata endpoint, credentials, service port) | Use a page reference inside the project, or verify the address with `axure_use_prototype` first; add the host to `AXURE_ALLOWED_HOSTS` if it legitimately belongs |
| `NOT_AXURE_PROJECT` | The page loads but exposes no `$axure` runtime: not a share/publish link, hidden behind a login, or wrong path | Use the project-root share/publish link and make sure it needs no login |
| `NO_CONTENT_FRAME` | The page loaded but has no `#base` widget canvas: a non-page address (project home, or not an Axure page) | Use a page id or URL from `axure_list_pages` |
| `PAGE_NOT_FOUND` | `page` is not a page of this prototype (typo, or a different project) | Call `axure_list_pages` and use the exact id |
| `WIDGET_NOT_FOUND` | None of the ids passed with `target: "widgets"` exist on this page | Take ids from an `axure_get_page_map` outline; fully qualified `pageId#u12` refs work too |
| `OPERATION_TIMEOUT` | A single in-page operation exceeded its timeout (very large page, slow render) | Raise `AXURE_OPERATION_TIMEOUT_MS` and narrow the request with `region` / `widgetIds` |
| `RENDER_FAILED` | The in-page extractor failed, typically because the page navigated or re-rendered mid-capture | Retry; if it persists, raise `AXURE_SETTLE_MS` |
| `SCREENSHOT_FAILED` | The capture itself failed (invalid clip, render interrupted) | Retry, or fall back to `target: "viewport"` |
| `WRITE_FAILED` | `savePath` escapes `AXURE_SCREENSHOT_DIR`, or the directory is not writable | Pass a relative path such as `"orders.png"`; adjust `AXURE_SCREENSHOT_DIR` if needed |
| `INVALID_ARGUMENT` | Inconsistent arguments, e.g. `target: "widgets"` without `widgetIds` | Supply the missing argument |
| `INTERNAL` | Unexpected failure | Reproduce with `AXURE_LOG_LEVEL=debug` and read stderr |

Other common situations:

- **The tools do not appear in the host.** The process never started. Run the same command in a terminal and confirm it waits instead of exiting.
- **`pages: 0`.** `filter` excluded everything, or the address is not the project root.
- **No image attached.** The PNG exceeded 8 MiB, or `includeImage` was `false`. Capture a widget crop.
- **Only part of the page is visible.** A node or character budget was hit. Check `stats.omitted` and `warnings`, then focus with `region` / `widgetIds`.

---

## Configuration

The settings a deployment usually changes are listed here; `.env.example` is the complete list. Every one of them takes effect from `.env`, with a single exception: `AXURE_ENV_FILE` decides which file to read, so it can only be supplied in the process environment.

| Variable | Default | Description |
|---|---|---|
| `AXURE_URL` | **required, no default** | Project-root URL; origin and project path are split from it |
| `AXURE_ENV_FILE` | auto-detected | Explicit path to a `.env` file |
| `AXURE_ALLOWED_HOSTS` | empty | Extra hosts the browser may visit, comma separated (hosts verified via `axure_use_prototype` need not be listed) |
| `AXURE_NO_PROXY` | `localhost,127.0.0.1,::1` | Proxy bypass list, applied to Chromium and to the server's own requests |
| `AXURE_HEADLESS` | `true` | Run headless |
| `AXURE_VIEWPORT_WIDTH` / `_HEIGHT` | `1440` / `900` | Initial viewport |
| `AXURE_DEVICE_SCALE_FACTOR` | `1` | Device pixel ratio (1–3), fixed per browser context |
| `AXURE_SETTLE_MS` | `4000` | Extra wait after `load` |
| `AXURE_NAV_TIMEOUT_MS` | `60000` | Navigation timeout |
| `AXURE_OPERATION_TIMEOUT_MS` | `20000` | Timeout per in-page operation |
| `AXURE_MAX_OUTLINE_NODES` | `1200` | Default node limit |
| `AXURE_OUTLINE_CHAR_BUDGET` | `48000` | Hard ceiling on response text |
| `AXURE_MAX_WIDGET_IDS` | `40` | Most widget ids one call may name |
| `AXURE_MAX_PAGES` | `500` | Most pages `axure_list_pages` returns at once |
| `AXURE_SCREENSHOT_DIR` | `.axure-mcp/shots` | Base directory for `savePath` |
| `AXURE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`; always written to stderr |
| `AXURE_HTTP_PORT` / `_HOST` / `_TOKEN` | `3333` / `127.0.0.1` / — | HTTP binding; a non-loopback host requires a token (≥16 characters) |

`.env.example` is a template and is **never read**; copy it to `.env` to use a file. Process environment variables take precedence over `.env`.

---

## License

MIT. See [CHANGELOG.md](CHANGELOG.md) for release notes.
