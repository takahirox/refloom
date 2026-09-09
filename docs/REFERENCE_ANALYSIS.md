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
and website-captured images use the same path, including full-page/section images
as qualitative screenshots. DOM/CSS, accessibility, runtime, video, SVG, animation,
action sequences and inferred geometry are not supported. The input signature and
declared MIME must agree. Image decoding/interpretation remains Visparse's job;
the signature check does not establish that an image is decodable.

Runtime/interaction evidence mapping is tracked in
[#31](https://github.com/takahirox/refloom/issues/31). Design DNA, rendered DESIGN.md,
multi-image/target analysis, automatic triggering, hosted/team execution and
workspace-level Reference ownership are outside this integration.

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
An abrupt OS/process crash can leave a private temporary directory for normal OS
temporary-file cleanup; it never becomes the result's durable evidence locator.

Final writes reload state and check the original job and evidence. Revision
conflicts retry only the persistence operation, never the model call. Deleting a
Reference/project or resetting/replacing the workspace removes owned attachments;
a late completion cannot recreate them. Restore interrupts running attachments
instead of resuming jobs. Existing successes remain readable when configuration
changes or Visparse becomes unavailable. Summaries identify changed Asset locators;
consumers compare stored configuration/version/intent before reuse. Explicit new
requests perform that comparison using the current installed code and byte digest.

## HTTP and MCP

HTTP uses the existing local Host/Origin/JSON boundary:

- `POST /api/analyses` with `{referenceId, assetId, intent?, force?}` returns a
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
never calls a model or network. The normal suite covers concurrency/reuse, API/MCP,
stale evidence, restoration, revision/deletion races and bounded history. Compose
integration exercises the real browser dialog and safe result rendering, plus actual PostgreSQL/S3 persistence, backup restoration and
non-destructive SQL upgrade of existing rows. Live model quality is not established
by these tests; a live smoke run is optional and must respect available allowance.
