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
- `storage.js`: IndexedDB transactions, binary lifecycle, and versioned backup
  encoding/decoding. It depends on domain validation.
- `ui-format.js`: presentation-only formatting and filename normalization.
- `app.js`: DOM events, orchestration, confirmation, rendering, and downloads.
  It renders user content with text nodes rather than HTML injection.

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

IndexedDB database `refloom` version 1 has two object stores:

- `workspace`: the validated JSON workspace at key `current`.
- `blobs`: captured binary records addressed by the identifier following a
  `blob:` asset locator.

Each mutation writes the workspace and binary changes in one transaction and
removes unreferenced blobs. `localStorage` contains only the current project ID.
Object URLs used for previews are temporary presentation resources, not durable
storage. There is no server-side persistence.

## Data flow

1. A UI event supplies explicit user input or captured media.
2. A domain function returns a new validated workspace value.
3. The repository commits workspace JSON and binary additions atomically.
4. The application rerenders from committed state.
5. Board export derives a read-only creative-direction package; backup export
   packages the whole workspace and referenced binaries.

Import takes the reverse path: parse the backup, verify its format and workspace
relationships, verify required binary records, then replace local state in one
transaction. Imported strings remain data and are rendered as text.

## Versioning

Workspace, backup, and creative-direction versions are independent. Readers
must reject unsupported versions rather than silently guessing. A future
migration must be explicit, deterministic, tested, and preserve provenance.
See `EXPORT_SCHEMA.md` for the public interchange contracts.
