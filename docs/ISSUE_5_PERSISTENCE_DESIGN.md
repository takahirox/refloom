# Issue #5 persistence design

Status: implemented contract for Issue #5. The repository now delivers this
single PostgreSQL/S3 persistence architecture and its production-path tests.

## Decision

Refloom will replace its authoritative `FileWorkspaceStore` with PostgreSQL for
workspace metadata and an S3-compatible object store for binary media. HTTP,
MCP, and website capture will use one shared repository contract. The browser
will continue to use the same-origin HTTP repository and will hold no
authoritative data.

Use these established Node dependencies:

- `pg` for PostgreSQL. It is the established, narrowly scoped Node PostgreSQL
  client, provides pools, parameterized queries, explicit transactions, and
  access to PostgreSQL error codes without introducing an ORM or a second data
  model.
- `@aws-sdk/client-s3` for media. It is the maintained AWS SDK v3 S3 client,
  supports S3-compatible endpoints, path-style addressing, checksums, bounded
  streaming, `HeadObject`, and paginated listing, and does not require an
  object-store-specific client.

Both packages and their exact transitive versions must be committed through
`package.json` and `package-lock.json`. Runtime code must not use an ORM, schema
auto-synchronization, provider-specific PostgreSQL extension, or a second S3
library.

The current project-owned Reference schema is retained exactly. References,
Assets, Targets, and Moments continue to carry and validate `projectId` as the
version-1 compatibility boundary. Issue #5 must not simulate workspace-level
Reference reuse. That ownership can change only after every migration gate in
`PRODUCT_SPEC.md` is satisfied by a separate decision and implementation.

## Relational model

Identifiers remain opaque application-generated strings. Timestamps are
`timestamptz`; JSON-shaped domain fields are `jsonb`. All tables are in the
default application schema. Migrations create entities in this order:

1. `workspace_state(singleton boolean primary key default true check
   (singleton), revision bigint not null check (revision >= 0))`. It contains
   exactly one row, `(true, 0)` on a new database.
2. `projects(id text primary key, title text not null, brief text,
   created_at timestamptz not null, updated_at timestamptz not null)`.
3. `references(id text primary key, project_id text not null references
   projects(id) on delete cascade, title text, source_url text, creator text,
   notes text, captured_at timestamptz not null, capture_method text not null,
   created_at timestamptz not null, updated_at timestamptz not null)`.
4. `assets(id text primary key, project_id text not null references projects(id)
   on delete cascade, reference_id text not null references references(id) on
   delete cascade, kind text not null check (kind in ('image','video','url')),
   locator text not null, media_type text, captured_at timestamptz not null,
   provenance jsonb not null, created_at timestamptz not null, updated_at
   timestamptz not null, foreign key (reference_id, project_id) references
   references(id, project_id))`.
5. `targets(id text primary key, project_id text not null references projects(id)
   on delete cascade, reference_id text not null references references(id) on
   delete cascade, asset_id text, kind text not null check (kind in
   ('reference','asset','region','frame','interaction')), detail jsonb not null,
   created_at timestamptz not null, updated_at timestamptz not null, foreign key
   (reference_id, project_id) references references(id, project_id), foreign key
   (asset_id, reference_id) references assets(id, reference_id), check
   (kind <> 'asset' or asset_id is not null))`.
6. `moments(id text primary key, project_id text not null references projects(id)
   on delete cascade, target_id text not null references targets(id) on delete
   cascade, label text, start_value double precision, end_value double
   precision, state jsonb not null, created_at timestamptz not null, updated_at
   timestamptz not null, foreign key (target_id, project_id) references
   targets(id, project_id), check (start_value is null or start_value >= 0),
   check (end_value is null or end_value >= coalesce(start_value, 0)))`.
7. `selections(id text primary key, project_id text not null references
   projects(id) on delete cascade, target_id text not null references targets(id)
   on delete cascade, moment_id text, aspect text not null, intent text not null,
   created_at timestamptz not null, updated_at timestamptz not null, foreign key
   (target_id, project_id) references targets(id, project_id), foreign key
   (moment_id, target_id) references moments(id, target_id))`.
8. `boards(id text primary key, project_id text not null references projects(id)
   on delete cascade, title text not null, created_at timestamptz not null,
   updated_at timestamptz not null)`.
9. `board_selections(board_id text not null references boards(id) on delete
   cascade, selection_id text not null references selections(id) on delete
   cascade, position integer not null check (position >= 0), primary key
   (board_id, selection_id), unique (board_id, position))`. Repository writes
   verify that board and selection have the same `project_id`.
10. `signals(id text primary key, project_id text not null references projects(id)
    on delete cascade, event text not null check (event in ('capture','enrich',
    'selection.create','board.change','export')), subject_type text not null,
    subject_id text not null, occurred_at timestamptz not null, facts jsonb not
    null, created_at timestamptz not null, updated_at timestamptz not null)`.
11. `media_objects(id text primary key, object_key text not null unique,
    sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), size_bytes bigint not
    null check (size_bytes >= 0), media_type text, original_name text,
    created_at timestamptz not null)`. Blob-backed asset locators remain
    `blob:<id>` and each such ID must reference this table before commit.

Composite foreign keys require matching unique constraints on
`references(id, project_id)`, `assets(id, reference_id)`, `targets(id,
project_id)`, and `moments(id, target_id)`. Add indexes for every foreign-key
column and the query paths already used by MCP: references by project and
updated time, assets/targets by reference, moments by target, selections and
boards by project, board selections by board and position, and signals by
project and occurred time. Reads reconstruct version-1 workspace arrays in the
existing domain order; board membership is ordered by `position`. Before every
write and after reconstruction, `validateWorkspace` remains the final
application-level invariant check, including polymorphic Signal subjects.

## Deterministic migrations

SQL migrations live in `migrations/` with zero-padded immutable names beginning
with `0001_persistence.sql`. A small `src/postgres-migrations.js` runner:

- takes a fixed PostgreSQL advisory lock;
- creates `schema_migrations(version text primary key, sha256 text not null,
  applied_at timestamptz not null)` if absent;
- reads migration files in bytewise filename order;
- rejects a changed checksum for an applied version;
- applies each unapplied file and its checksum insert in one transaction; and
- releases the advisory lock on success or failure.

There is no down migration in production and no startup schema inference.
Application startup runs the same runner, fails closed on any migration error,
and becomes ready only after all committed migrations are recorded. Tests apply
migrations to a new database and a previously migrated database, verify the
second run is a no-op, and verify checksum mismatch and partially failed SQL do
not advance `schema_migrations`.

## Repository contract

`src/persistence-repository.js` defines the behavioral interface implemented by
`PostgresWorkspaceRepository`; it is not a separate storage implementation:

```js
await repository.initialize()
await repository.readiness()
await repository.load() // { revision, workspace }
await repository.commit(expectedRevision, workspace, additions)
await repository.mediaInfo(id) // { contents, mediaType, name }
await repository.exportBackup()
await repository.importBackup(expectedRevision, text)
await repository.cleanupMedia({ graceMs, limit })
await repository.close()
```

`additions` preserves the current `{id, data, type, name}` boundary, with
canonical base64 or a `Buffer` accepted internally and the existing per-object,
workspace, request, and total-size limits enforced before upload. HTTP owns one
repository instance and closes it during server shutdown. MCP owns one instance
using the same environment configuration. Website capture receives this
interface, not a concrete store. Browser `WorkspaceRepository` remains the
same-origin HTTP adapter and never connects to PostgreSQL or S3 directly.

## Transactions, revisions, and conflicts

Every metadata mutation is one PostgreSQL transaction at `READ COMMITTED`:

1. Validate the complete proposed workspace and additions before opening the
   transaction or uploading media.
2. Make every new media object durable and verified as specified below.
3. `select revision from workspace_state where singleton = true for update`.
4. If it differs from `expectedRevision`, roll back and return
   `REVISION_CONFLICT` with expected and actual revisions.
5. Replace relational rows in dependency-safe delete/insert order, or perform
   equivalent targeted writes, while preserving the same resulting workspace.
6. Insert referenced `media_objects` rows, verify every `blob:<id>` has one, and
   update `workspace_state` to exactly `revision + 1`.
7. Reconstruct and validate the committed workspace, then commit.

The locked singleton row is the global serialization point for UI, MCP,
capture, restore, and deletion. A transaction either exposes the entire new
workspace at one revision or none of it. HTTP maps a conflict to 409. MCP maps
it to `REVISION_CONFLICT`. Neither HTTP whole-workspace mutation nor MCP retries
or merges after conflict. Capture may retain its existing bounded retry count
only for an additive checkpoint: each retry reloads authoritative state,
revalidates that the same project-owned Reference and URL source still exist,
reapplies only that completed checkpoint with stable generated IDs, and stops
when its bound is reached.

## Media lifecycle

The bucket is private. The only application-owned key namespace is
`media/<opaque-media-id>`; IDs must match the existing URL-safe media-ID rule.
No request supplies an object key, bucket, endpoint, or credentials.

For each addition, the repository decodes and size-checks bytes, computes
SHA-256 and byte length, and performs `PutObject` directly to the final key with
content type and checksum metadata. It then performs `HeadObject` against that
final key and requires the reported length and stored SHA-256 metadata to match.
An existing final key is accepted only when both values match; otherwise the
operation fails with `MEDIA_COLLISION`. Only after this verification may the
database transaction insert `media_objects` and metadata containing
`blob:<id>`. Thus metadata never references a partial, temporary, or absent
object.

If upload or verification fails, no database transaction commits. If the
database transaction fails after verification, the final object is an
unreferenced, immutable, safe orphan; request handling must not delete it
because a concurrent successful transaction may have adopted the same matching
object.

Cleanup is a separate bounded operation, run once after successful startup and
then at most once per configured interval. It lists only `media/`, one S3 page
at a time, and examines at most `REFLOOM_MEDIA_CLEANUP_LIMIT` objects per run
(default 1000). It deletes only objects absent from `media_objects` whose S3
`LastModified` is older than `REFLOOM_MEDIA_ORPHAN_GRACE_MS` (default 24 hours).
It uses batches of at most 1000 delete keys, records failures without making the
service unready, and resumes from the next run; referenced objects are never
deleted. Database rows are removed transactionally when their last workspace
reference disappears, making their immutable objects eligible only after the
grace period. Reads first establish a current database reference, then fetch
the exact final key with a byte limit and verify length and SHA-256 before
returning it.

## Backup contract

Issue #5 introduces `refloom.workspace-backup` version 2. Version 2 contains:

- `format: "refloom.workspace-backup"` and `version: 2`;
- `workspace`: the unchanged, validated version-1 domain object;
- `binaries`: sorted by ID, each exactly `{id, type, name, size, sha256, data}`
  where `data` is canonical base64 and the other integrity fields match it.

Export reads metadata and workspace at one revision in a repeatable-read,
read-only transaction, then fetches the immutable objects identified by that
snapshot, verifies every size and digest, and emits stable entity and binary
ordering. A missing or changed object fails the export.

Import accepts only version 2, rejects version 1 and every unknown version
before uploads or database changes, validates canonical base64, IDs, sizes,
digests, duplicate and orphan records, workspace relationships, and configured
limits, then uses the normal verified-upload and revision-checked transaction.
The current file persistence envelope and raw `workspace.json` are not import
formats. There is deliberately no automatic import from `FileWorkspaceStore`
or IndexedDB in Issue #5; users must export a version-2 backup from a supported
pre-cutover build or begin with an empty database. Documentation must state this
cutover requirement before the old readers are removed.

## Configuration, security, and readiness

Required production variables are `DATABASE_URL`, `REFLOOM_S3_ENDPOINT`,
`REFLOOM_S3_REGION`, `REFLOOM_S3_BUCKET`, `REFLOOM_S3_ACCESS_KEY_ID`, and
`REFLOOM_S3_SECRET_ACCESS_KEY`. `REFLOOM_S3_FORCE_PATH_STYLE` defaults to
`true` for compatible local services. Existing host, origin, body, capture, and
media limits remain enforced. Secrets are read only from environment variables,
never returned by HTTP/MCP, logged, embedded in object keys, or committed.
PostgreSQL statements are parameterized. S3 redirects are not followed to
arbitrary endpoints. The bucket has public access disabled; HTTP and MCP remain
the only media authorization boundary and serve only currently referenced IDs.

`GET /healthz` reports process liveness without touching dependencies.
`GET /readyz` returns 200 only after migrations are current, a PostgreSQL
`select 1` succeeds, the singleton revision row exists, and `HeadBucket`
succeeds; otherwise it returns a generic 503 without credentials or internal
addresses. Neither endpoint returns workspace data. Normal API routes return
503 while unready. Startup fails for invalid/missing configuration, migration
failure, inaccessible PostgreSQL, inaccessible bucket, or a bucket lacking the
required read/write/delete/list permissions.

## Compose topology

`compose.yaml` defines three services on one private network:

- `postgres`, with a pinned major image, named data volume, database/user from
  Compose environment, and `pg_isready` healthcheck;
- `object-store`, using a pinned MinIO image, named data volume, private S3/API
  ports, and healthcheck;
- `app`, built from the repository, depending on both healthy services, running
  migrations through normal startup, publishing only the Refloom HTTP port to
  `127.0.0.1`, and carrying the production dependency variables.

A one-shot bucket initialization service creates the private bucket
idempotently and exits before `app`. PostgreSQL and object-store ports are not
published to the host. MCP runs from the app image or host process with the
same network-reachable configuration; it does not receive filesystem data
paths. Compose pins image versions rather than floating tags and uses health
conditions, named volumes, restart policies, and an app healthcheck against
`/readyz`.

## Production-path verification

Unit tests may inject repository doubles, but acceptance requires tests against
real PostgreSQL and an S3-compatible service. `npm test` remains the fast suite.
`npm run test:integration` starts the pinned Compose dependencies, applies real
migrations, creates an isolated database/bucket namespace, runs HTTP, MCP,
capture, backup, media, conflict, readiness, and cleanup tests through
`PostgresWorkspaceRepository`, and tears the isolated namespace down even on
failure. CI runs both commands.

Required production-path cases are: clean and repeated migration; concurrent
stale revision conflict; transaction rollback; all domain foreign keys and
ordered boards; upload/head verification before metadata; S3 failure; database
failure leaving a safe orphan; grace-period and per-run cleanup bounds; media
collision and digest mismatch; referenced-media read authorization; capture
retry without lost concurrent work; version-2 backup round trip; rejection of
version 1, unknown versions, corrupt bytes, duplicates, orphans, and missing
media; hostile Host/Origin and oversized bodies; readiness transitions; and
HTTP/MCP observation of the same committed revision.

## Removal inventory

The cutover removes, rather than leaves dormant:

- `src/file-workspace-store.js` and `test/file-workspace-store.test.js`;
- `FileWorkspaceStore` imports, construction, filesystem locks, data-directory
  options, and `REFLOOM_DATA_DIR` use in `server.mjs`, `mcp-server.mjs`, capture,
  tests, and documentation;
- `LegacyIndexedDBRepository`, `readLegacyMigration`, IndexedDB constants and
  helpers, migration prompts/orchestration, and their tests from `src/storage.js`
  and `src/app.js`;
- statements that `data/workspace.json` or `data/media/` are authoritative, and
  FileWorkspaceStore-specific lock, rename, and cleanup descriptions;
- obsolete ignore rules and test fixtures that exist solely for repository-local
  `data/` state.

`WorkspaceRepository` stays as the browser HTTP adapter. Domain operations,
creative-direction version 1, controlled capture, and `localStorage` use for
the non-authoritative selected project ID stay.

## Documentation inventory

The implementation updates `README.md`, `docs/ARCHITECTURE.md`,
`docs/PRODUCT_SPEC.md`, `docs/EXPORT_SCHEMA.md`, `docs/WEBSITE_CAPTURE.md`, and
`docs/PRIVACY_SECURITY.md` to describe PostgreSQL/S3 authority, configuration,
Compose startup, readiness, backup version 2 and version-1 rejection, media
orphan behavior, removal of IndexedDB/file migration, and the unchanged
project-owned Reference decision. `docs/PRODUCT_SLICE.md` and `docs/ROADMAP.md`
change only if an existing persistence statement becomes false; product scope
must not be expanded.

## Phased file-level implementation sequence

1. Add `pg` and `@aws-sdk/client-s3` to `package.json` and lock them in
   `package-lock.json`; add configuration parsing tests.
2. Add `migrations/0001_persistence.sql` and
   `src/postgres-migrations.js` with deterministic migration tests.
3. Add `src/persistence-repository.js`, `src/postgres-workspace-repository.js`,
   and repository integration tests covering schema, revisions, transactions,
   reconstruction, and media lifecycle.
4. Change backup helpers in `src/storage.js` to version 2 and add strict
   compatibility and integrity tests.
5. Wire the shared repository into `server.mjs`, `mcp-server.mjs`, and
   `src/website-capture-service.js`; add `/healthz`, `/readyz`, shutdown, HTTP,
   MCP, and capture production-path tests.
6. Add `Dockerfile`, `compose.yaml`, bucket initialization, integration-test
   orchestration, and CI invocation.
7. Remove every item in the removal inventory and update browser/storage tests.
8. Update every document in the documentation inventory, then run the complete
   unit, integration, syntax, and repository check suites.

Each phase must leave one authoritative persistence path; no phase may ship a
runtime switch that permits file and PostgreSQL stores to diverge.

## Issue-close acceptance checklist

- The committed dependency and migration choices match this document and a
  fresh Compose startup reaches readiness without manual schema work.
- PostgreSQL is the only authoritative metadata store and the private
  S3-compatible bucket is the only authoritative media store.
- HTTP, MCP, and capture share the repository contract and revision row; stale
  writers cannot overwrite committed work.
- Every relationship, cascade, ordered board, Signal restriction, and current
  project-owned Reference invariant is enforced and production-path tested.
- Metadata can reference media only after its final object is durable and
  verified; failure leaves no dangling reference, and cleanup is grace-based,
  prefix-scoped, and bounded.
- Backup version 2 round-trips all workspace data and bytes; version 1, unknown,
  incomplete, corrupt, duplicate, and orphan-bearing inputs are rejected before
  replacement.
- Limits, parameterization, private bucket policy, secret handling, Host/Origin
  checks, generic errors, liveness, readiness, and shutdown behavior are tested.
- Compose exposes only localhost HTTP and uses pinned, healthy, persistent
  PostgreSQL and object-store services.
- IndexedDB authority/migration code, `FileWorkspaceStore`, filesystem locking,
  and obsolete data-directory behavior and documentation are absent.
- Unit tests, production-path integration tests, `npm run check`, and CI pass,
  and all documentation inventory entries describe the delivered behavior.
