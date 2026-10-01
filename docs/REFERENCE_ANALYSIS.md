# Reference analysis

Issue [#30](https://github.com/takahirox/refloom/issues/30) adds an optional,
manual path from one stored PNG/JPEG Asset to a Visparse Design Profile. Open a
Reference's **More → Analysis**, choose an image and preserve/adapt purpose, and
click **Analyze selected image**. The dialog shows the original image, run status,
and a result/provenance viewer. Analysis never blocks capture or saving.

The default purpose is `preserve`; `adapt` provides reference-derived principles
without a target site. Neither setting is inferred from a Selection's free-text
Intent. This slice analyzes the complete Asset bytes, with no crop, resize,
geometry estimation, target inputs or second semantic-extraction call. Uploaded
and website-captured images use the same design-profile path, including full-page/section images
as qualitative screenshots. This product does not analyze DOM/CSS, accessibility,
runtime, video, SVG, animation, action sequences or inferred geometry. The input signature and
declared MIME must agree. Image decoding/interpretation remains Visparse's job;
the signature check does not establish that an image is decodable.

Issue [#31](https://github.com/takahirox/refloom/issues/31) also supports
**Stored runtime inspection** in the same dialog and durable lifecycle. Select an
image Asset and either its original capture provenance or a particular stored
Moment. Click **Inspect stored capture**. This invokes Visparse's deterministic
`inspect_snapshot`/`normalize_inspection` contract, not an AI analyzer. The result
is a validated supplied-evidence bundle (`visparse.inspection`, schema `0.1`),
not a Design Profile or an inferred interaction/UX profile.

Design DNA, rendered DESIGN.md,
multi-image/target analysis, automatic triggering, hosted/team execution and
workspace-level Reference ownership are outside this integration.

## Stored evidence mapping and gaps

The mapping was checked against Refloom's `website-capture-service.js`,
`interactive-auto.js` and `guided-executor.js`, and the reviewed Visparse revision's
[`inspection.py`](https://github.com/takahirox/visparse/blob/5a4166dd37e65ca368ab9521eab4be52ceeda74f/src/visparse/inspection.py),
[`inspection contract`](https://github.com/takahirox/visparse/blob/5a4166dd37e65ca368ab9521eab4be52ceeda74f/docs/inspection.md), and
[`interaction contract`](https://github.com/takahirox/visparse/blob/5a4166dd37e65ca368ab9521eab4be52ceeda74f/docs/interactions.md).
`src/inspection-evidence.js` is the explicit mapping boundary.

| Stored Refloom evidence | Visparse inspection mapping | Scope and limits |
| --- | --- | --- |
| One PNG/JPEG blob | `screenshot` capture `reference-1` | Exact Asset ID, immutable blob locator, actual SHA-256, MIME and original Asset provenance. Bytes remain an independently retrievable artifact; inspection does not send them to a provider. |
| Automated-browser Asset provenance or selected Moment state | `runtime` capture `runtime-1` | Raw viewport/scroll/region, URLs, capture time, checkpoint, sampling/stability settings, warnings, completion, surface discovery and automation metadata are retained as opaque supplied JSON. No new collection occurs. |
| Stored `targetCanvas` | `canvas` capture `canvas-1` | Supplied surface identity, bounds and instrumentation metadata. A selector/bounds record is not a DOM snapshot or CSS inventory. |
| `targetCanvas.webglContext === true` and `supported === true` | `webgl` capture `webgl-1` | Generic observed context/draw-call metadata only. It does not imply renderer resources, an application state model or a Three.js scene. Unsupported frame/worker discovery remains raw metadata and warnings. |
| Passive representative Moments | No interaction sequence | Visual samples do not establish actions, transitions, causality or exhaustive animation coverage. |
| Guided action log | Retained inside runtime metadata only | Ordered click targets, requested roles/labels, relative start timestamps, outcomes and policy reasons are preserved, without treating `executed` as an observed application effect. |
| DOM, computed/matched CSS, accessibility tree, Three.js scene inventory | Unavailable | Capture may internally inspect elements or instrument WebGL, but it does not durably retain these contracts' inventories. No captures of these kinds are synthesized. |

Inspection requires stored `captureMethod: automated-browser`, viewport metadata
and capture timestamp. Uploaded images with no such runtime evidence return
`ANALYSIS_NO_RUNTIME_EVIDENCE`. Missing/foreign Moments, unsupported image formats,
oversized inputs and invalid source ownership return `ANALYSIS_UNSUPPORTED_EVIDENCE`.
The actual image signature and digest are checked before Visparse preflight;
if a stored screenshot digest disagrees, the request returns `ANALYSIS_STALE_INPUT`.
The existing image Design Profile path remains available for uploaded images.

Asset deduplication preserves the first Asset's provenance while later captures
create separate Targets/Moments. A selected Moment's state is therefore the sole
authority for that capture's runtime metadata: it is never merged with earlier
Asset provenance. Without `momentId`, inspection deliberately describes the
Asset's original capture. Each attachment snapshots the Reference identity and
source fields, Asset identity/provenance and, when selected, the complete
Target/Moment. The snapshot digest, actual image digest, scope, product,
mapping configuration and installed Visparse fingerprint bind reuse. Changes to
this evidence mark the stored result stale and reject late completion. Tag edits
and design-provider/model configuration do not invalidate deterministic inspection.
Snapshot object-key order is insignificant, including after PostgreSQL JSONB reload.

Inspection preserves payloads without generating prose or promoting values into
claims: `measurements`, `runtime_observations`, `visual_observations`,
`interpretations` and `confidence` are empty. Raw numerical metadata remains
available for an authorized consumer to examine in its original context. In
particular, scheduled sample timestamps and visual-difference scores are not
measured response times or inferred UX pacing. Missing evidence stays explicitly
unavailable. This path validates and exposes supplied evidence; it does not claim
that runtime or UX interpretation was performed. The result must match the exact
mapped input after real Visparse validation; offline imports check that same
bounded mapping and remain untrusted supplied evidence.

`product: visparse.interaction-profile` returns
`ANALYSIS_UNSUPPORTED_INTERACTION_EVIDENCE` before any analyzer or browser call,
for both passive and guided captures. Unsupported/no-evidence requests create no
analysis attachment. The current guided executor runs actions before screenshot
sampling, records action start times without completion intervals, and does not
retain per-action pre/post snapshots or a common capture/action clock. Capture
and analysis authorizations remain independent; inspection never runs guided
actions, recaptures a URL or invokes Visparse's optional browser collector.

Separate future capture work would need durable session/reset/storage and input
modality records, monotonic clock identity, non-atomic capture intervals, action
start/end intervals, target-to-capture identities, and explicitly bound per-action
before/feedback/after evidence to support `interaction-sequence/0.2`. Merely
filling required fields with defaults or treating scheduled timestamps as observed
intervals would fabricate evidence. Supporting DOM/CSS/AX or cooperative Three.js
would similarly require separately authorized inventory capture. None of those
capabilities is added by this bridge.

## Enable on the host

Supported execution placement: Refloom's Node server/MCP and a Python 3.10+ Visparse
installation on the same POSIX host. Install the reviewed Visparse revision into
a dedicated environment (substitute a venv path you own):

```sh
python3 -m venv /path/to/visparse-venv
/path/to/visparse-venv/bin/pip install 'visparse @ git+https://github.com/takahirox/visparse.git@5a4166dd37e65ca368ab9521eab4be52ceeda74f'
```

Configure the following environment for the HTTP and/or MCP process that may
request analysis. Keep the existing PostgreSQL/S3 configuration.

```sh
REFLOOM_ANALYSIS_ENABLED=1
REFLOOM_VISPARSE_PYTHON=/path/to/visparse-venv/bin/python
REFLOOM_VISPARSE_AGENT=codex
REFLOOM_ANALYSIS_TIMEOUT_SECONDS=300
```

Only standard locale, home, executable-search and Python environment variables
are inherited by default. Database/S3 credentials and other application secrets
are not forwarded. If a trusted provider wrapper needs an environment credential
or proxy/certificate setting, explicitly list its variable name in the operator's
comma-separated `REFLOOM_VISPARSE_INHERIT_ENV`. Values are not stored in analysis
records. Changes to wrapper-managed defaults/credentials may need an explicit
re-analysis because an unreported resolved model cannot be inferred.

The selected agent must already be installed and authenticated for that process's
OS user. Authentication is managed outside Refloom; no credentials are stored in
images, analyses or backups. `REFLOOM_VISPARSE_EXECUTABLE` and
`REFLOOM_VISPARSE_MODEL` are optional operator overrides passed through Visparse's
configuration. An omitted model means the agent's default; `resolvedModel: null`
means the actual model was not reported, not a claim that it matches a guess.

These provider requirements apply to Design Profiles. Runtime inspection needs
only `REFLOOM_ANALYSIS_ENABLED=1` and the reviewed Python/Visparse installation;
it requires no provider installation, authentication or valid provider settings.
List responses report `enabled` for image analysis and `inspectionEnabled` for
inspection separately. Reads require neither.

An explicitly trusted wrapper can use `REFLOOM_VISPARSE_AGENT=command` with an
absolute `REFLOOM_VISPARSE_EXECUTABLE` implementing Visparse's
[`analysis-agent-request/0.1` protocol](https://github.com/takahirox/visparse/blob/5a4166dd37e65ca368ab9521eab4be52ceeda74f/docs/analyzers.md).
The wrapper receives temporary image paths and owns its provider authentication.
It must not escape the invocation's process group or perform retries, allowance
resets, purchases or provider/model switches. Refloom does not sandbox a trusted
operator-supplied executable. It does bound its input/output and process lifetime.

The stock Compose image leaves analysis disabled and does not contain Python,
Visparse or host authentication. It can store/display/restore results without
them. Enabling an environment flag alone does not make a host CLI available in
that container. A custom image/provider deployment is not claimed as tested.
Do not mount a host's entire credential/configuration directory to work around
this. Use the documented host deployment for this integration.

## Lifecycle and reuse

Only explicit UI, HTTP or MCP requests invoke analysis. Website capture settings
do not enable analysis. Reads never start a provider or even require Visparse to
be installed. Each request binds to the Asset ID, immutable blob locator and
SHA-256 bytes, Reference identity, input order/role (one reference), intent,
operator-configuration digest, adapter version and installed Visparse code
fingerprint. The package version alone is insufficient because the reviewed
repository still uses the same package version for multiple contracts.

Matching requests return the newest matching run, including an in-flight run or
failure. **Run again** / `force: true` explicitly starts a new attempt after a
terminal outcome; even force reuses an in-flight match. A failed attempt never
removes prior successes. No automatic retry occurs after any provider error,
including a usage limit. The stable public error deliberately does not include
the provider's raw diagnostic. Tag changes do not invalidate the evidence.

Each persisted attachment has its own version and retains its canonical Visparse
result, source-to-Asset mapping, timestamps, safe settings and producer metadata.
Visparse validates the exact source identity and product schema before success.
Screenshot interpretations never become mechanical measurements. Returned
provenance supports tracing the procedure, not identical repeat model output.
Imported attachments remain untrusted derived data: Refloom validates their
bounded envelope and source relationships offline, but does not attest that the
claimed producer really ran. Visparse is not required to read/import a backup.

There is one active analysis per workspace across HTTP/MCP processes, no queued
model work, and at most four concurrent preflight requests per process. Busy
requests return `ANALYSIS_BUSY`. Each image is at most 1,000,000 bytes (the supported Visparse source limit); provider stdout and
stderr, bridge output and each attachment are bounded to 1 MiB. Existing overall workspace
limits still apply. At most 32 attempts are retained per Reference; a full history
returns `ANALYSIS_HISTORY_FULL` rather than deleting results implicitly.

The configured timeout is 1–900 seconds. A persisted run lease lasts the timeout
plus 25 seconds for process/commit cleanup. If the owning process crashes, reads
report `ANALYSIS_INTERRUPTED` after that deadline and the lease no longer consumes
capacity. Graceful shutdown aborts its own jobs. Another process can cancel through
the shared revision boundary; the owner checks approximately once per second.
Private temporary images are removed on success, error, timeout and cancellation.
Deterministic inspection instead uses a fixed 10-second process bound and
25-second lease, with the same interruption/cancellation behavior.
An abrupt OS/process crash can leave a private temporary directory for normal OS
temporary-file cleanup; it never becomes the result's durable evidence locator.

Final writes reload state and check the original job and evidence. Revision
conflicts retry only the persistence operation, never the model call. Deleting a
Reference/project or resetting/replacing the workspace removes owned attachments;
a late completion cannot recreate them. Restore interrupts running attachments
instead of resuming jobs. Existing successes remain readable when configuration
changes or Visparse becomes unavailable. Summaries identify changed Asset locators
and changed inspection snapshots;
consumers compare stored configuration/version/intent before reuse. Explicit new
requests perform that comparison using the current installed code and byte digest.

## HTTP and MCP

HTTP uses the existing local Host/Origin/JSON boundary:

- `POST /api/analyses` with `{referenceId, assetId, product?, momentId?, intent?, force?}` returns a
  run summary/provenance with HTTP 202. No result body is included in this response.
- `GET /api/references/:referenceId/analyses` returns at most 32 summaries.
- `GET /api/references/:referenceId/analyses/:analysisId` returns one result.
- `DELETE /api/references/:referenceId/analyses/:analysisId` cancels a running job.

MCP exposes `request_reference_analysis`, `list_reference_analyses` (offset/limit,
maximum 32), `get_reference_analysis`, and `cancel_reference_analysis`. The request
tool is explicitly an external-world mutation. Requests accept stored IDs and
bounded options, not paths, executables, URLs or credentials. Existing Reference
detail reports `analysisCount`; search, Selection detail and creative-direction
exports do not inline raw analysis. Original `refloom://media/...` resources remain
independently accessible. Stored result text is data, never agent instructions.

`product` defaults to `visparse.design-profile`; its existing preserve/adapt
`intent` is unchanged. `visparse.inspection` accepts optional `momentId` and no
`intent` (stored purpose is `inspect`). `momentId` must resolve through a Target
owned by the same Reference/project and pointing to the selected Asset. Example:

```json
{"referenceId":"reference_id","assetId":"asset_id","momentId":"moment_id","product":"visparse.inspection"}
```

Both products share pagination, cancellation, leases, concurrency and the 32-run
history cap. Inspection screenshot artifacts can use Refloom's existing 25 MiB
media/capture limit because their bytes remain external; the 1,000,000-byte
Design Profile source limit does not apply to them. Inspection JSON obeys
Visparse's 1,000,000-byte input limit and shape
limits; the stored evidence snapshot is additionally capped at 256 KiB. Each
complete attachment remains bounded to 1 MiB. Existing SQL JSONB storage,
attachment version 1, workspace version 3 and backup version 4 support the
additional product without a migration. Older binaries that only understand
Design Profiles cannot read inspection attachments; stop them before upgrading.

## Persistence and verification

SQL migration `0003_reference_analyses.sql` adds JSONB attachments to References;
source ownership and deletion cascades are unchanged. Workspace version 3 and
backup version 4 preserve attachments. Backup version 3/workspace version 2 has
an explicit deterministic upgrade retaining IDs, tags, settings and media. Backup
versions 1/2 and unknown versions remain rejected. Stop older app/MCP processes
before upgrading; older binaries must not write the migrated database. Export a
backup before upgrading. Reverting the binary alone is not a supported rollback;
use the pre-upgrade database/backup with its matching application version.

```sh
npm test
npm run check
npm run test:integration
REFLOOM_VISPARSE_PYTHON=/path/to/visparse-venv/bin/python npm run test:analysis
```

`test:analysis` requires real Visparse and intentionally fails if unavailable. It
uses an explicitly configured offline command wrapper and a synthetic PNG/profile,
testing Refloom → Python → Visparse transport, validation, identity rejection,
measurement rejection, excessive output, failure, timeout and cancellation. It
never calls a model or network. It also validates runtime inspection through the
real `inspect_snapshot` contract with a provider that would fail if called, and
rejects invalid schema, provenance, source kinds, cross-references and bounds.
The normal suite covers concurrency/reuse, API/MCP,
stale evidence, restoration, revision/deletion races and bounded history. Compose
integration exercises the real browser dialog and safe result rendering, plus actual PostgreSQL/S3 persistence, backup restoration and
non-destructive SQL upgrade of existing rows. Live model quality is not established
by these tests; a live smoke run is optional and must respect available allowance.
