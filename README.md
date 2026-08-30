# Refloom

Refloom 0.1 is a dependency-free, local-first workspace for turning visual and
interactive references into project-specific creative direction. It preserves
the distinction between a source reference, the exact target or moment being
used, the relevant aspect, and the creator's intent.

## Prerequisites

- Node.js 22 or newer
- A current browser
- Chrome or Chromium for optional automatic website capture

No package installation, account, hosted backend, or AI provider is required.

## Run and verify

```sh
npm start
```

Open `http://127.0.0.1:4173`. The server binds only to localhost by default.
Set `PORT` to choose another port.

```sh
npm test
npm run check
npm run mcp
```

`npm test` runs the domain, storage, formatting, and HTTP integration tests.

## Codex MCP setup

Refloom includes a dependency-free local stdio MCP server. It shares the exact
revisioned `FileWorkspaceStore` used by the browser and writes diagnostics only
to stderr. Stop a manually started `npm run mcp` before asking Codex to launch
its configured copy.

Add the following to this repository's `.codex/config.toml` (create it if
needed), replacing the two absolute paths. Refloom does not create or modify
Codex configuration automatically:

```toml
[mcp_servers.refloom]
command = "node"
args = ["/absolute/path/to/refloom/mcp-server.mjs"]
cwd = "/absolute/path/to/refloom"
env = { REFLOOM_DATA_DIR = "/absolute/path/to/refloom/data" }
```

Restart Codex in the project and approve/trust the project configuration when
prompted. For a user-local installation, put the same table in
`~/.codex/config.toml`; project configuration is preferable when the data path
is repository-specific. The server supports the current newline-delimited
JSON-RPC stdio transport and MCP protocol version `2025-06-18`. The equivalent
user-local CLI command is:

```sh
codex mcp add refloom --env REFLOOM_DATA_DIR=/absolute/path/to/refloom/data -- node /absolute/path/to/refloom/mcp-server.mjs
```

Read tools progressively disclose project and board summaries before paginated
reference/selection search, exact reference/selection detail, and creative
direction. Write tools only append references, assets, targets, moments,
selections, or board membership, or enrich descriptive reference fields. There
are no delete, remove, reset, import, reorder, or arbitrary workspace-write
tools. Supply `expectedRevision` when coordinating multiple agents; stale
mutations return `REVISION_CONFLICT` instead of overwriting newer state.
The `request_website_capture` tool is an explicitly open-world, non-destructive
action: it accepts an existing Reference ID and bounded capture settings, then
uses only that Reference's stored source URL.

Captured binary media is exposed as `refloom://media/<opaque-id>` MCP resources.
Only media currently referenced by a registered workspace asset can be read;
filesystem paths and unregistered blobs are rejected. Resource MIME type and
asset provenance are returned with the bytes.
`npm run check` verifies required deliverables, JavaScript syntax, and safe
rendering constraints.

## End-to-end workflow

1. Create a project and optional brief.
2. Capture an image by picker, drop, or clipboard, or save a URL immediately.
3. Optionally enrich a saved URL with bounded initial/scroll screenshots. The
   URL remains saved if Chrome is unavailable or a later checkpoint fails.
4. Enrich the reference later with provenance, notes, and more image or video
   assets.
5. Select an exact reference target or moment, name the relevant aspect, and
   state the intended use.
6. Compose and arrange selections on the project board; filter by aspect.
7. Download the board as Markdown or `refloom.creative-direction` JSON.
8. Review factual capture, enrichment, selection, board, and export activity.

Project and reference deletion and the full reset action require confirmation.

## Local data and backups

The authoritative workspace and captured media live below the repository-local
`data/` directory by default. Set `REFLOOM_DATA_DIR` to choose another local
directory. `data/` is ignored by Git; do not place it under a tracked source
path. The browser talks only to the same-origin localhost companion. This
boundary lets the UI and the stdio MCP process coordinate through revisions
without silently overwriting each other.

On the first empty startup, Refloom offers to copy an existing IndexedDB
workspace and all referenced blobs. Migration is one-way and never deletes the
legacy browser copy. If migration fails, fix the reported missing data or export
the legacy backup with the earlier version, then retry while server state is
still empty. `localStorage` retains only non-authoritative project selection.

Download workspace backups regularly. A backup contains the complete workspace,
provenance, source URLs, notes, and base64-encoded captured media, so treat it as
sensitive. Import replaces the current workspace after confirmation; export a
current backup and inspect the source of any file before importing it.

## Accessibility

The interface uses semantic landmarks, associated labels, keyboard-operable
controls, visible focus states, status announcements, responsive layouts, and a
reduced-motion mode. Report accessibility problems with the browser and input
method needed to reproduce them.

## 0.1 scope

Included: local project/reference capture and enrichment, controlled automatic
website screenshot checkpoints, precise selections, boards, factual activity
signals, Markdown/JSON direction export, validated backup/import, cascade
deletion, and local reset.

Not included: video/hover/click/drag capture, semantic transition detection,
search or recommendations, persistent personal/team contexts, collaboration,
hosted sync, AI providers, or legal/copyright policy automation. See
[docs/ROADMAP.md](docs/ROADMAP.md).

Technical boundaries and formats are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/EXPORT_SCHEMA.md](docs/EXPORT_SCHEMA.md), and
[docs/PRIVACY_SECURITY.md](docs/PRIVACY_SECURITY.md). Website-capture controls
and limits are in [docs/WEBSITE_CAPTURE.md](docs/WEBSITE_CAPTURE.md).
