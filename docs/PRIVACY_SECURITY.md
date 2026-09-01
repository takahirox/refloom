# Privacy and security

## Threat model

Refloom 0.1 assumes one person running the application on a device and browser
profile they control. Relevant risks include malicious or malformed imported
backups, untrusted reference text and URLs, accidental local-data loss, exposure
of sensitive backups, another local process reaching the HTTP server, an AI
agent receiving more local data or mutation authority than intended, and a
future code change weakening browser isolation.

Refloom does not defend against a compromised operating system or browser,
malicious extensions, another person with access to the unlocked browser
profile, or deliberate modification of the application source. Local-first
storage is not encryption or an access-control boundary.

## Browser and server controls

The server binds to `127.0.0.1` by default. It rejects hostile Host and Origin
values, exposes no CORS permission, serves only known files under `public/` and
`src/`, rejects traversal, and does not expose filesystem details. Mutation APIs
require JSON, enforce body and media limits, validate complete state, and use
optimistic revisions. Responses set MIME types, `nosniff`, frame denial,
cross-origin opener isolation, a restrictive Permissions Policy, and this CSP:

```text
default-src 'self'; img-src 'self' blob:; media-src 'self' blob:;
style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none';
base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

The CSP permits local scripts/styles and locally created image/video blob URLs.
It blocks network connections, plugins, external bases, and framing. It is
defense in depth, not a substitute for safe rendering.

## MCP boundary

MCP is a separately versioned live operational contract, not a backup or a
complete portable expression of the workspace.

The MCP server is a local child process with the operating-system permissions of
the user who launches Codex. Configure only the required PostgreSQL/S3 variables and
review project-local Codex configuration before trusting it. Refloom never
silently edits user or project Codex configuration.

The exposed tool surface is deliberately narrower than the browser: reads are
bounded and progressively disclosed; mutations are additive except for explicit
reference-field enrichment; and destructive, backup-import, reorder, reset, and
general workspace-write operations are absent. Optimistic revisions and the
shared PostgreSQL revision lock reject stale concurrent writes.

Media reads accept only `refloom://media/<opaque-id>` resources derived from
registered blob-backed assets. The store verifies current authoritative
references again before reading bytes. MIME metadata and provenance accompany
the resource. Tools accept no filesystem paths, and URL assets are registered
without server-side network fetching. The bounded tools do not provide an
atomic, complete snapshot with all media or a workspace-replacement operation;
use `refloom.workspace-backup` for restore portability. Protocol responses are
the only stdout output; startup and malformed-input diagnostics go to stderr.

## Safe rendering and imports

User-controlled titles, notes, creators, URLs, aspects, and intents are inserted
as text, not interpreted as HTML. The repository check rejects common unsafe
rendering mechanisms and inline event handlers. URLs remain untrusted input;
users should verify a destination before opening or sharing it.

Backup decoding checks the format and version, validates workspace relationships
and factual signal constraints, rejects duplicate/corrupt binary records, and
requires every referenced blob. Imported data is still untrusted and must keep
using text-only rendering. Import replaces current data only after an explicit
confirmation.

## Website capture

Website capture is an open-world network action. One initial capture is visibly
default-on for a newly saved website Reference, with per-create and shared
Workspace opt-out controls; later capture remains explicit. The URL Reference
is committed before the network action. The UI and MCP can capture only an
existing Reference; neither surface can override its stored URL, browser
executable, proxy, or process dependencies. Capture modules
treat pages and DNS as hostile, reject non-public destinations, pin every
validated proxy connection, and run Chrome with fresh temporary state and
bounded resources. Redirects and subresources traverse the same proxy boundary.
These controls reduce SSRF, DNS-rebinding, session-leakage, and
resource-exhaustion risk; they are not a claim of perfect browser sandboxing.
The complete boundary is in `WEBSITE_CAPTURE.md`.

## Persistent data and provenance

The authoritative workspace is stored in PostgreSQL and media in the configured
private S3-compatible bucket. Database/object-store operators, credentials,
backups, and anyone with host access may read or remove them. Credentials stay
in environment configuration and must not be committed. The browser retains no
authoritative copy and there is no browser-database or filesystem recovery reader.

Source URLs, creator fields, capture times, capture methods, and asset provenance
are retained when provided. Provenance records user-supplied facts; it does not
prove ownership, authenticity, accuracy, permission, or license status.

## Backup sensitivity

A workspace backup is plain JSON containing all projects, briefs, notes,
activity, provenance, URLs, and base64 media. It is not encrypted. Store and
transmit it as sensitive material, review its source before import, and keep a
known-good current backup before replacing local data. Deleting data in Refloom
does not delete copies already downloaded, synchronized, or backed up elsewhere.

## Limits and reporting

There is no end-user authentication, multi-user authorization, encrypted vault, malware
scanner, URL reputation service, automatic redaction, hosted recovery, security
update channel, or legal/copyright determination in 0.1. The localhost server is
for local development and personal use, not direct Internet exposure. Security
reports should include reproduction steps, affected version, and impact while
avoiding unnecessary disclosure of real private workspace data.
