# Export schemas

Refloom 0.1 emits two portable JSON formats. Consumers must check both `format` and
`version` before reading the rest of a document. Timestamps are ISO 8601 strings;
identifiers are opaque strings and must not be parsed for meaning.

These formats are independent of both the PostgreSQL/S3 persistence schema and
the live MCP protocol/tool/resource contract. Their versions may
advance separately. MCP is not a backup: its bounded operational reads do not
constitute an atomic, complete, restorable workspace and its mutation surface
does not expose backup replacement.

## `refloom.creative-direction` version 1

This board-oriented interchange format contains:

- `format`: exactly `refloom.creative-direction`.
- `version`: exactly `1`.
- `exportedAt`: export timestamp.
- `project`: the board's project record.
- `board`: its board record, including ordered `selectionIds`.
- `selections`: ordered expanded entries. Each has `selection`, `target`,
  `reference`, and nullable `moment` and `asset` records.

Example (timestamps and optional fields are representative):

```json
{
  "format": "refloom.creative-direction",
  "version": 1,
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

This is a direction artifact, not a restorable workspace: entities unrelated to
the selected board and captured binary bytes are intentionally absent.

## `refloom.workspace-backup` version 2

This restore format contains:

- `format`: exactly `refloom.workspace-backup`.
- `version`: exactly `2`.
- `workspace`: workspace version 1 with boolean
  `settings.automaticWebsiteCapture` and arrays named `projects`, `references`,
  `assets`, `targets`, `moments`, `selections`, `boards`, and `signals`.
- `binaries`: records with exactly `id`, MIME `type`, original `name`, byte
  `size`, lowercase `sha256`, and canonical base64 `data`. Every asset locator
  `blob:<id>` must have one matching binary record and no orphan is allowed.

```json
{
  "format": "refloom.workspace-backup",
  "version": 2,
  "workspace": {
    "version": 1,
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

- Version 2 readers must accept optional entity fields being absent and must
  preserve fields they understand without deriving missing provenance.
- Refloom validates relationship integrity and rejects malformed JSON,
  unsupported format/version pairs, duplicate IDs, dangling relationships,
  corrupt binary records, and missing referenced binaries.
- Backup version 1, unknown versions, raw workspace JSON, and old file envelopes
  are rejected. There is no automatic browser/file-store migration. Producers introducing
  an incompatible shape must increment the relevant version; format names do
  not change for compatible revisions.
- Consumers should ignore unknown additive fields, but must not interpret that
  as permission to accept an unknown version.
- Importing a valid backup replaces the current authoritative workspace. Direction JSON
  cannot be imported as a backup.
- Version 1 accurately retains project-owned References. A future move to
  workspace-level reusable References requires a new workspace/domain major
  version and the deterministic backup migration, stable-ID/media preservation,
  reuse semantics, relationship validation, rollback/export, mixed-version
  rejection, and tests specified in `PRODUCT_SPEC.md`.
