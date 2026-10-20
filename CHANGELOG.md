# Changelog

Version-managed iteration records (requirements, audits, plans) live in `.update/` in the source
repository and are not published. This file summarises what changed for package consumers.

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
