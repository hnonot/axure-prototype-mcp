# Changelog

Version-managed iteration records (requirements, audits, plans) live in `.update/` in the source
repository and are not published. This file summarises what changed for package consumers.

## 0.2.4 — every documented setting takes effect

An audit of `.env.example` against the code found settings that were listed, parsed and then
ignored. A setting that silently does nothing cannot be told apart from one that worked, so each
was either wired up or removed.

- `AXURE_HTTP_PORT`, `AXURE_HTTP_HOST` and `AXURE_HTTP_TOKEN` are read from the merged environment,
  so they work from `.env` like every other setting. They used to be read straight off
  `process.env`: the file was loaded, the key was merged, and the HTTP branch never looked. An empty
  token now means "unset" rather than "present but too short".
- `AXURE_MAX_WIDGET_IDS` now bounds the `widgetIds` argument of `axure_get_page_map` and
  `axure_get_visual`. The bound was a hard-coded `40`, so the setting was accepted, range-checked,
  listed in `--help`, and inert. The default is unchanged, so an unconfigured server behaves as
  before.
- `AXURE_DEBUG` removed from the template: nothing read it. `AXURE_LOG_LEVEL` is the knob, and it
  is now listed instead.
- The template's `AXURE_HTTP_PORT` now matches the code default (`3333`). It said `7458`, so copying
  the template moved the endpoint without saying so.
- Added to the template, previously supported but undocumented there:
  `AXURE_OPERATION_TIMEOUT_MS`, `AXURE_MAX_CAPTURE_VIEWPORT_WIDTH`, `_HEIGHT`, `AXURE_MAX_PAGES`,
  `AXURE_MAX_WIDGET_IDS`.
- `AXURE_ENV_FILE` is marked process-environment-only in the template, because it chooses which file
  to read and therefore cannot come from that file.
- New `npm run test:config` asserts the property rather than describing it: every key in
  `.env.example` must appear in a table naming its effect; each one must change the derived
  configuration when set in a real `.env`; and the four that never reach the configuration object
  (the HTTP trio, the tool-schema bound, the log level) are proven by starting the server and
  observing behaviour. It also fails when the code reads an `AXURE_*` name the template omits.

## 0.2.3 — npm package

- Published as a standalone, host-agnostic npm package runnable with `npx`, over standard MCP and
  `stdio`.
- `private` removed, so `npm publish` no longer refuses; `publishConfig` pins public access and the
  npmjs registry.
- Two bin names are available: `axure-prototype-mcp` and the shorter `axure-mcp`.
- `main`, `types` and an `exports` map added, so the package can also be imported as a library
  (`import { createRuntime } from 'axure-prototype-mcp'`) instead of only executed.
- `files` now lists exactly what a consumer needs: `bin`, `dist`, both READMEs, `.env.example` and
  this changelog. Tests, probes and iteration records are not shipped.
- `prepublishOnly` cleans `dist`, rebuilds and runs the offline suites, so a stale or absent build
  cannot be published.
- `npm run verify:package` checks the built artefact the way a consumer uses it: bin resolvable, MCP
  handshake over stdio, full tool set, and a refused address reported as a coded error rather than a
  crash.
- Every hard-coded deployment address was removed from the working tree and from the documentation;
  examples use `axure.example.com` placeholders. Repository history was rewritten separately.

## 0.2.2

- `AXURE_URL` is required and has no built-in default. A built-in address used to serve the wrong
  prototype silently.
- `.env` is loaded implicitly at startup. Precedence: process environment, then `.env`, then a hard
  error. The search covers the working directory and the server's own directory, because an
  editor-hosted client chooses the working directory.
- New tool `axure_use_prototype`: read a prototype named in the conversation without editing
  configuration. The address is admitted by verification — the Axure runtime must be found — not by
  trust. Non-http(s) schemes, cloud metadata endpoints, service ports and URLs with embedded
  credentials are refused.

## 0.2.1

- Output standardised as the versioned `axure.page/v1` document: per-value provenance
  (`fact` / `derived` / `unknown`), an explicit hierarchy and relation graph, a deduplicated text
  index, and structure plus interactions from a single page load.
- `axure_get_page_map` gained `format` (`outline` default, unchanged, or `standard`).

## 0.2.0

- Interaction recognition via `axure_get_interactions`, with a `declared` / `observed` / `inferred`
  evidence model. An `inferred` record cannot carry actions by construction.

## 0.1.0

- Four-layer architecture (MCP → service → axure → playwright), navigation and path security
  boundaries, canvas 1:1 fitting, region and widget scoping, stdio and Streamable HTTP transports.
