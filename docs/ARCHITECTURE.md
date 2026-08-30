# Architecture

## Decisions

Refloom 0.1 is a dependency-free browser application served by a small Node.js
static server. It has no account system, hosted API, build step, telemetry, or
required network service. This keeps the core workflow inspectable and usable
offline after its files are available.

The server exposes only `public/` and `src/`, binds to `127.0.0.1` by default,
and applies one security-header policy to success and error responses. Its
factory is importable for integration tests; executing `server.mjs` directly
retains the normal start behavior.

The browser code is separated into these boundaries:

- `domain.js`: immutable workspace operations, relationships, validation,
  deletion cascades, factual signals, and creative-direction export.
- `storage.js`: browser HTTP repository, legacy migration helpers, and stable
  backup encoding/decoding.
- `file-workspace-store.js`: validated revisioned envelopes, media, locking,
  limits, atomic replacement, and orphan cleanup.
- `ui-format.js`: presentation-only formatting and filename normalization.
- `app.js`: DOM events, orchestration, confirmation, rendering, and downloads.
  It renders user content with text nodes rather than HTML injection.
- `mcp-server.mjs`: dependency-free newline-delimited JSON-RPC stdio transport,
  progressive read tools, additive mutation tools, structured errors, and
  registered-media MCP resources.

## Domain boundaries

A project owns references, targets, moments, selections, boards, and signals.
A reference owns assets and targets. A selection joins a project-owned target,
an optional moment belonging to that target, an aspect, and an intent. A board
contains only selections from its project. Domain validation rejects dangling
or cross-project relationships and duplicate board entries.

Signals record supported observable events and facts. They are not a store for
inferred taste or preference claims. Reference and project deletion cascade
through owned entities so boards cannot retain dangling selections.

## Storage boundaries

The Node companion owns `data/workspace.json` and `data/media/`. Workspace JSON
is a validated, independently versioned persistence envelope. Media names are
strict opaque identifiers, never user paths. Commits serialize in-process and
take a bounded cross-process lock, compare the caller revision, stage and sync
media, atomically replace state with temporary-file-plus-rename, then delete
sorted unreferenced media. State never references media before it is durable;
an interrupted cleanup can only leave safe orphans for the next commit.

The same-origin API loads and commits complete workspaces, reads referenced
media, and imports/exports the existing backup contract. Host and Origin checks,
JSON and body limits, validation, and optimistic revisions protect the local
boundary. It intentionally has no CORS policy and is not a public listener.

IndexedDB remains read-only migration input. `localStorage` contains only the
current project ID.
Object URLs used for previews are temporary presentation resources, not durable
storage. There is no server-side persistence.

The MCP process opens the same configured `FileWorkspaceStore`. Every mutation
loads an authoritative revision, applies one domain operation, and commits with
optimistic revision comparison under the store's cross-process lock. An
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
3. The HTTP repository commits workspace JSON and binary additions at its last observed revision.
4. The application rerenders from committed state.
5. Board export derives a read-only creative-direction package; backup export
   packages the whole workspace and referenced binaries.

Import takes the reverse path: parse the backup, verify its format and workspace
relationships, verify required binary records, then replace local state in one
revisioned commit. A stale writer receives a conflict and reloads authoritative
state. The browser and stdio MCP process use this same shared boundary.

## Versioning

Workspace, backup, and creative-direction versions are independent. Readers
must reject unsupported versions rather than silently guessing. A future
migration must be explicit, deterministic, tested, and preserve provenance.
See `EXPORT_SCHEMA.md` for the public interchange contracts.
