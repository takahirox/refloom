# Export schemas

Refloom 0.1 emits two portable JSON formats. Consumers must check both `format` and
`version` before reading the rest of a document. Timestamps are ISO 8601 strings;
identifiers are opaque strings and must not be parsed for meaning.

These formats are independent of both the PostgreSQL/S3 persistence schema and
the live MCP protocol/tool/resource contract. Their versions may
advance separately. MCP is not a backup: its bounded operational reads do not
constitute an atomic, complete, restorable workspace and its mutation surface
does not expose backup replacement.

## `refloom.creative-direction` version 2

This board-oriented interchange format contains:

- `format`: exactly `refloom.creative-direction`.
- `version`: exactly `2`.
- `exportedAt`: export timestamp.
- `project`: the board's project record.
- `board`: its board record, including ordered `selectionIds`.
- `selections`: ordered expanded entries. Each has `selection`, `target`,
  `reference`, and nullable `moment` and `asset` records.

Example (timestamps and optional fields are representative):

```json
{
  "format": "refloom.creative-direction",
  "version": 2,
  "exportedAt": "2026-08-29T00:00:00.000Z",
  "project": {
    "id": "project_demo",
    "title": "Launch page",
    "brief": "A calm, editorial introduction",
    "createdAt": "2026-08-28T12:00:00.000Z",
    "updatedAt": "2026-08-28T12:00:00.000Z"
  },
  "board": {
    "id": "board_demo",
    "projectId": "project_demo",
    "title": "Direction",
    "selectionIds": ["selection_demo"],
    "createdAt": "2026-08-28T12:10:00.000Z",
    "updatedAt": "2026-08-28T12:10:00.000Z"
  },
  "selections": [
    {
      "selection": {
        "id": "selection_demo",
        "projectId": "project_demo",
        "targetId": "target_demo",
        "aspect": "Typography",
        "intent": "Use a restrained scale contrast",
        "createdAt": "2026-08-28T12:08:00.000Z",
        "updatedAt": "2026-08-28T12:08:00.000Z"
      },
      "target": {
        "id": "target_demo",
        "projectId": "project_demo",
        "referenceId": "reference_demo",
        "assetId": "asset_demo",
        "kind": "asset",
        "detail": {},
        "createdAt": "2026-08-28T12:06:00.000Z",
        "updatedAt": "2026-08-28T12:06:00.000Z"
      },
      "moment": null,
      "reference": {
        "id": "reference_demo",
        "projectId": "project_demo",
        "title": "Magazine study",
        "sourceUrl": "https://example.test/study",
        "tags": ["editorial", "typography"],
        "capturedAt": "2026-08-28T12:05:00.000Z",
        "captureMethod": "url",
        "createdAt": "2026-08-28T12:05:00.000Z",
        "updatedAt": "2026-08-28T12:05:00.000Z"
      },
      "asset": {
        "id": "asset_demo",
        "projectId": "project_demo",
        "referenceId": "reference_demo",
        "kind": "url",
        "locator": "https://example.test/study",
        "capturedAt": "2026-08-28T12:05:00.000Z",
        "provenance": { "sourceUrl": "https://example.test/study" },
        "createdAt": "2026-08-28T12:05:00.000Z",
        "updatedAt": "2026-08-28T12:05:00.000Z"
      }
    }
  ]
}
```

Every expanded Reference includes canonical `tags`. Markdown creative-direction
exports render the same values on a separate `Reference tags:` line; Reference
tags do not replace or derive a Selection's project-specific Aspect or Intent.

This is a direction artifact, not a restorable workspace: entities unrelated to
the selected board and captured binary bytes are intentionally absent.

## `refloom.workspace-backup` version 3

This restore format contains:

- `format`: exactly `refloom.workspace-backup`.
- `version`: exactly `3`.
- `workspace`: workspace version 2 with boolean
  `settings.automaticWebsiteCapture` and arrays named `projects`, `references`,
  `assets`, `targets`, `moments`, `selections`, `boards`, and `signals`. Every
  Reference carries its canonical `tags` array.
- `binaries`: records with exactly `id`, MIME `type`, original `name`, byte
  `size`, lowercase `sha256`, and canonical base64 `data`. Every asset locator
  `blob:<id>` must have one matching binary record and no orphan is allowed.

```json
{
  "format": "refloom.workspace-backup",
  "version": 3,
  "workspace": {
    "version": 2,
    "settings": {
      "automaticWebsiteCapture": true
    },
    "projects": [],
    "references": [],
    "assets": [],
    "targets": [],
    "moments": [],
    "selections": [],
    "boards": [],
    "signals": []
  },
  "binaries": [
    {
      "id": "media_demo",
      "type": "image/png",
      "name": "reference.png",
      "size": 1,
      "sha256": "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      "data": "AA=="
    }
  ]
}
```

The minimal workspace above must include a matching blob-backed Asset before it
can be imported; the binary is shown only to document the record shape.

## Compatibility rules

- Optional entity fields may be absent, but workspace version 2 References must
  carry canonical `tags`; readers must not synthesize missing required fields or
  derive missing provenance.
- Refloom validates relationship integrity and rejects malformed JSON,
  unsupported format/version pairs, duplicate IDs, dangling relationships,
  corrupt binary records, and missing referenced binaries.
- Backup versions 1 and 2, unknown versions, raw workspace JSON, and old file
  envelopes are rejected. There is no automatic browser/file-store migration. Producers introducing
  an incompatible shape must increment the relevant version; format names do
  not change for compatible revisions.
- The version-3 cutover requires a reset PostgreSQL database; pre-cutover
  database contents and old backups are not upgraded.
- Consumers should ignore unknown additive fields, but must not interpret that
  as permission to accept an unknown version.
- Importing a valid backup replaces the current authoritative workspace. Direction JSON
  cannot be imported as a backup.
- Workspace version 2 accurately retains project-owned References. A future move to
  workspace-level reusable References requires a new workspace/domain major
  version and the deterministic backup migration, stable-ID/media preservation,
  reuse semantics, relationship validation, rollback/export, mixed-version
  rejection, and tests specified in `PRODUCT_SPEC.md`.
