# Privacy and security

## Threat model

Refloom 0.1 assumes one person running the application on a device and browser
profile they control. Relevant risks include malicious or malformed imported
backups, untrusted reference text and URLs, accidental local-data loss, exposure
of sensitive backups, another local process reaching the HTTP server, and a
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

## Local data and provenance

Workspace JSON and media are stored unencrypted below the configured local data
directory and are exchanged only with the same-origin localhost companion.
Filesystem permissions, backups, and anyone with account access may read or
remove them. The default `data/` directory is Git-ignored but users must still
avoid committing or synchronizing it. IndexedDB is retained only as a legacy
migration/recovery copy and is never deleted automatically.

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

There is no authentication, multi-user authorization, encrypted vault, malware
scanner, URL reputation service, automatic redaction, hosted recovery, security
update channel, or legal/copyright determination in 0.1. The localhost server is
for local development and personal use, not direct Internet exposure. Security
reports should include reproduction steps, affected version, and impact while
avoiding unnecessary disclosure of real private workspace data.
