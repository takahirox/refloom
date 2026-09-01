# Refloom

Refloom 0.1 is a local-first workspace for turning visual and
interactive references into project-specific creative direction. It preserves
the distinction between a source reference, the exact target or moment being
used, the relevant aspect, and the creator's intent.

The authoritative long-term product model and its distinction from current 0.1
behavior are in [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md).

## Prerequisites

- Docker Desktop with Docker Compose (recommended), or Node.js 22+, PostgreSQL,
  and a private S3-compatible object store
- A current browser
- Chrome or Chromium for optional automatic website capture when running on the
  host; the Compose app image includes Chromium

## Run and verify

```sh
docker compose up --build
```

Open `http://127.0.0.1:4173`. The server binds only to localhost by default.
PostgreSQL and object-store ports remain private inside the Compose network.
The first startup creates the private bucket and applies checked SQL migrations.
The app remains non-root with `no-new-privileges` and a checked-in seccomp
profile that adds only the namespace calls required by Chromium's sandbox.
The image's bounded Node entrypoint starts Xvfb on the fixed container-local
display `:99`, waits for its Unix socket, and forwards command signals. Its
`1920x1080x24` screen has TCP listening disabled. The app, integration command,
and `docker compose exec` MCP process therefore use the same X server while
Chromium remains headless and sandboxed.

For a host-process development run, install packages and set `DATABASE_URL`,
`REFLOOM_S3_ENDPOINT`, `REFLOOM_S3_REGION`, `REFLOOM_S3_BUCKET`,
`REFLOOM_S3_ACCESS_KEY_ID`, and `REFLOOM_S3_SECRET_ACCESS_KEY` before `npm start`.
`REFLOOM_S3_FORCE_PATH_STYLE` defaults to `true`. `GET /healthz` reports process
liveness and `GET /readyz` verifies migrations, PostgreSQL, and bucket access.

```sh
npm test
npm run test:integration
npm run check
npm run check:browser
npm run mcp
```

`npm test` is the fast suite. `npm run test:integration` creates isolated
PostgreSQL/MinIO volumes, verifies the production path, and always removes them.

## Codex MCP setup

Refloom includes a local stdio MCP server. It shares the exact PostgreSQL
revision and S3 media authority used by HTTP/capture and writes diagnostics only
to stderr. Stop a manually started `npm run mcp` before asking Codex to launch
its configured copy.

For the recommended Compose deployment, first run `docker compose up -d --build`.
Then add the following to this repository's `.codex/config.toml` (create it if
needed), replacing the absolute working directory. The MCP process runs inside
the app container, where it shares the private PostgreSQL/S3 network and bundled
Chromium. Refloom does not create or modify Codex configuration automatically:

```toml
[mcp_servers.refloom]
command = "docker"
args = ["compose", "exec", "-T", "app", "node", "mcp-server.mjs"]
cwd = "/absolute/path/to/refloom"
```

For a host-process deployment, install Chrome or Chromium and use the following
configuration instead. Set `REFLOOM_CHROME_PATH` when the executable is not in a
standard platform location:

```toml
[mcp_servers.refloom]
command = "node"
args = ["/absolute/path/to/refloom/mcp-server.mjs"]
cwd = "/absolute/path/to/refloom"
env = { DATABASE_URL = "postgresql://...", REFLOOM_S3_ENDPOINT = "http://...", REFLOOM_S3_REGION = "us-east-1", REFLOOM_S3_BUCKET = "refloom", REFLOOM_S3_ACCESS_KEY_ID = "...", REFLOOM_S3_SECRET_ACCESS_KEY = "...", REFLOOM_S3_FORCE_PATH_STYLE = "true", REFLOOM_CHROME_PATH = "/absolute/path/to/chrome" }
```

Restart Codex in the project and approve/trust the project configuration when
prompted. For a user-local installation, put the same table in
`~/.codex/config.toml`. The server supports the current newline-delimited
JSON-RPC stdio transport and MCP protocol version `2025-06-18`. The equivalent
user-local CLI command is:

```sh
codex mcp add refloom --env DATABASE_URL=postgresql://... --env REFLOOM_S3_ENDPOINT=http://... --env REFLOOM_S3_REGION=us-east-1 --env REFLOOM_S3_BUCKET=refloom --env REFLOOM_S3_ACCESS_KEY_ID=... --env REFLOOM_S3_SECRET_ACCESS_KEY=... -- node /absolute/path/to/refloom/mcp-server.mjs
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
Creating a Reference with a website `sourceUrl` is also open-world: one initial
capture is queued by default after the Reference commit succeeds. Pass
`capture: false` to `create_reference` to opt out for that creation. Use
`get_capture_status` to observe `queued`, `capturing`, and final states, or
`cancel_website_capture` to cancel without deleting the Reference or an already
committed checkpoint. The shared Workspace preference controls the default but
an explicit per-call value wins.

Captured binary media is exposed as `refloom://media/<opaque-id>` MCP resources.
Only media currently referenced by a registered workspace asset can be read;
filesystem paths and unregistered blobs are rejected. Resource MIME type and
asset provenance are returned with the bytes.
Run `docker compose exec -T app npm run check:browser` to verify the bundled
browser, loopback CDP connection, and WebGL capability without contacting an
external website. `BROWSER_UNAVAILABLE`, `BROWSER_START_FAILED`,
`WEBGL_UNAVAILABLE`, `PAGE_RUNTIME_ERROR`, and `CAPTURE_RUNTIME_FAILED`
diagnostics are written only to MCP stderr; tool responses retain the stable,
path-free `CAPTURE_FAILED` error.
`npm run check` verifies required deliverables, JavaScript syntax, and safe
rendering constraints.

## End-to-end workflow

1. Create a project and optional brief.
2. Capture an image by picker, drop, or clipboard, or save a URL immediately.
3. A newly saved website URL queues bounded initial/scroll screenshots by
   default. Disable the visible per-create control or shared Workspace default
   to save without external access. The URL remains saved if capture is
   cancelled, Chrome is unavailable, or a later checkpoint fails.
4. Enrich the reference later with provenance, notes, and more image or video
   assets.
5. Select an exact reference target or moment, name the relevant aspect, and
   state the intended use.
6. Compose and arrange selections on the project board; filter by aspect.
7. Download the board as Markdown or `refloom.creative-direction` JSON.
8. Review factual capture, enrichment, selection, board, and export activity.

Project and reference deletion and the full reset action require confirmation.

## Data and backups

PostgreSQL is the sole workspace authority and the private S3-compatible bucket
is the sole captured-media authority. Browser, HTTP, MCP, and capture coordinate
through the same global revision. The browser stores no authoritative data;
`localStorage` retains only the selected project ID.

There is no reader or automatic migration for old browser/file persistence.
Before upgrading, export a version-2 backup from a supported pre-cutover build,
or start with an empty database. Backup version 1 and raw workspace files are
rejected.

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

Included: project/reference capture and enrichment, controlled automatic
website screenshot checkpoints, precise selections, boards, factual activity
signals, Markdown/JSON direction export, validated backup/import, cascade
deletion, and local reset.

Not included: video/hover/click/drag capture, semantic transition detection,
search or recommendations, persistent personal/team contexts, collaboration,
hosted sync, AI providers, or legal/copyright policy automation. See
[docs/ROADMAP.md](docs/ROADMAP.md).

The living product specification, current slice, technical boundaries, and
portable formats are documented in
[docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md),
[docs/PRODUCT_SLICE.md](docs/PRODUCT_SLICE.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/EXPORT_SCHEMA.md](docs/EXPORT_SCHEMA.md), and
[docs/PRIVACY_SECURITY.md](docs/PRIVACY_SECURITY.md). Website-capture controls
and limits are in [docs/WEBSITE_CAPTURE.md](docs/WEBSITE_CAPTURE.md).
