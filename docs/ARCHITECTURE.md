# Architecture

## Decisions

Refloom 0.1 is a browser application served by a small Node.js HTTP service. It
has no account system, hosted API, telemetry, or AI dependency. PostgreSQL and a
private S3-compatible object store provide one cloud-capable persistence path
for local Compose and deployed environments.

The server exposes only `public/` and `src/`, binds to `127.0.0.1` by default,
and applies one security-header policy to success and error responses. Its
factory is importable for integration tests; executing `server.mjs` directly
retains the normal start behavior.

The browser code is separated into these boundaries:

- `domain.js`: immutable workspace operations, relationships, validation,
  deletion cascades, factual signals, and creative-direction export.
- `storage.js`: browser HTTP repository and backup-v2 encoding/decoding.
- `postgres-workspace-repository.js`: normalized relational reconstruction,
  revision transactions, backup snapshots, and authorized media access.
- `s3-media-store.js`: immutable verified media writes/reads and bounded orphan
  cleanup under `media/`.
- `ui-format.js`: presentation-only formatting and filename normalization.
- `app.js`: DOM events, orchestration, confirmation, rendering, and downloads.
  It renders user content with text nodes rather than HTML injection.
- `mcp-server.mjs`: dependency-free newline-delimited JSON-RPC stdio transport,
  progressive read tools, additive mutation tools, structured errors, and
  registered-media MCP resources.
- `capture-url.js`, `capture-proxy.js`, and `chrome-capture.js`: dependency-free
  public-address validation, DNS-pinned proxying, and controlled Chrome/CDP
  lifecycle.
- `website-capture-service.js`: progressive checkpoint persistence into the
  existing Asset, Target, and Moment model with bounded revision-race retries.
- `capture-scheduler.js`: bounded process-wide concurrency, queueing, status,
  cancellation, and safe public job history for UI/API/MCP capture requests.
- `capture-request.js`: the strict shared HTTP/MCP request whitelist and public
  result projection; URL and process settings never cross these surfaces.

## Domain boundaries

In the current version-1 domain, a project owns references, targets, moments,
selections, boards, and signals. A reference owns assets and targets. A
selection joins a project-owned target, an optional moment belonging to that
target, an aspect, and an intent. A board contains only selections from its
project. Domain validation rejects dangling or cross-project relationships and
duplicate board entries.

That Reference ownership is a deliberate 0.1 simplification, not the durable
product model. References are intended to become workspace-level reusable
sources while Targets and Moments remain source-linked and Selections, Boards,
Signals, and Decisions remain context-specific. `PRODUCT_SPEC.md` defines the
migration gates; version 1 is unchanged until all are met.

Signals record supported observable events and facts. They are not a store for
inferred taste or preference claims. Reference and project deletion cascade
through owned entities so boards cannot retain dangling selections.

## Storage boundaries

PostgreSQL owns normalized entity rows and one locked `workspace_state`
revision plus shared Workspace settings. S3 owns immutable media at
`media/<opaque-id>`. A mutation validates
the complete workspace, uploads and verifies new bytes, locks the singleton
revision row, replaces relational rows in one transaction, verifies every blob
reference, and advances the revision exactly once. A database failure after an
upload leaves a safe orphan; grace-based bounded cleanup removes it later.

The same-origin API loads and commits complete workspaces, reads referenced
media, and imports/exports backup version 2. Host and Origin checks,
JSON and body limits, validation, and optimistic revisions protect the local
boundary. It intentionally has no CORS policy and is not a public listener.

There is no IndexedDB or filesystem authority/migration path. `localStorage`
contains only the current project ID.
Object URLs used for previews are temporary presentation resources, not durable
storage.

The MCP process opens the same configured PostgreSQL/S3 repository. Every mutation
loads an authoritative revision, applies one domain operation, and commits with
optimistic revision comparison under the database revision lock. An
explicit stale `expectedRevision`, or a race after loading, produces
`REVISION_CONFLICT`; the server never retries against changed state or silently
merges an agent's assumptions.

MCP resource URIs contain only opaque media IDs. Resource discovery is derived
from current blob-backed assets, and resource reads call `mediaInfo`, which
rechecks that the blob is referenced by authoritative state before reading it.
The protocol exposes no file URI, path argument, backup replacement, deletion,
or general workspace commit surface. URL assets remain metadata and are not
fetched by the server.

## Data flow

1. A UI event supplies explicit user input or captured media.
2. A domain function returns a new validated workspace value.
3. The HTTP repository commits normalized rows and verified binary additions at its last observed revision.
4. The application rerenders from committed state.
5. Board export derives a read-only creative-direction package; backup export
   packages the whole workspace and referenced binaries.

Import takes the reverse path: parse the backup, verify its format and workspace
relationships, verify required binary records, then replace local state in one
revisioned commit. A stale writer receives a conflict and reloads authoritative
state. The browser and stdio MCP process use this same shared boundary.

Website capture is reference-first. Creating a website Reference through UI,
HTTP, or MCP commits it before the default-on initial capture is queued. A
visible per-create choice can override the shared Workspace default. HTTP and
MCP use the same bounded scheduler and capture service, which reloads the stored
source URL and commits each completed screenshot independently. Container image
commands run under a fixed `DISPLAY=:99` Xvfb server with a `1920x1080x24`
screen and no TCP listener; application and Compose-exec MCP captures share that
container-local display. Chromium remains headless and sandboxed, with an
explicit ANGLE GL path whose WebGL capability is checked before navigation.
Partial failure or cancellation cannot roll back the URL or earlier
checkpoints. URL edits and later captures remain explicit.

## Versioning

SQL migrations, `refloom.workspace-backup`, `refloom.creative-direction`, and
the live MCP tool/resource surface are separate, independently versioned
contracts. Readers must reject unsupported incompatible versions rather than
silently guessing. MCP is an operational interface with
bounded reads and mutations, not an atomic restorable backup. A future domain
migration must be explicit, deterministic, tested, and preserve provenance,
IDs, relationships, and media. See `PRODUCT_SPEC.md` for the product and
migration decisions and `EXPORT_SCHEMA.md` for portable interchange contracts.
