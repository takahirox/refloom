# Refloom

Refloom 0.1 is a dependency-free, local-first workspace for turning visual and
interactive references into project-specific creative direction. It preserves
the distinction between a source reference, the exact target or moment being
used, the relevant aspect, and the creator's intent.

## Prerequisites

- Node.js 22 or newer
- A current browser with IndexedDB support

No package installation, account, hosted backend, or AI provider is required.

## Run and verify

```sh
npm start
```

Open `http://127.0.0.1:4173`. The server binds only to localhost by default.
Set `PORT` to choose another port.

```sh
npm test
npm run check
```

`npm test` runs the domain, storage, formatting, and HTTP integration tests.
`npm run check` verifies required deliverables, JavaScript syntax, and safe
rendering constraints.

## End-to-end workflow

1. Create a project and optional brief.
2. Capture an image by picker, drop, or clipboard, or save a URL immediately.
3. Enrich the reference later with provenance, notes, and more image or video
   assets.
4. Select an exact reference target or moment, name the relevant aspect, and
   state the intended use.
5. Compose and arrange selections on the project board; filter by aspect.
6. Download the board as Markdown or `refloom.creative-direction` JSON.
7. Review factual capture, enrichment, selection, board, and export activity.

Project and reference deletion and the full reset action require confirmation.

## Local data and backups

The workspace and captured binary assets live in the browser's IndexedDB for
this origin. The selected project identifier lives in `localStorage`. Refloom
does not upload or synchronize them, but browser data clearing, private browsing
policies, profile loss, or changing the origin can make them unavailable.

Download workspace backups regularly. A backup contains the complete workspace,
provenance, source URLs, notes, and base64-encoded captured media, so treat it as
sensitive. Import replaces the current workspace after confirmation; export a
current backup and inspect the source of any file before importing it.

## Accessibility

The interface uses semantic landmarks, associated labels, keyboard-operable
controls, visible focus states, status announcements, responsive layouts, and a
reduced-motion mode. Report accessibility problems with the browser and input
method needed to reproduce them.

## 0.1 scope

Included: local project/reference capture and enrichment, precise selections,
boards, factual activity signals, Markdown/JSON direction export, validated
backup/import, cascade deletion, and local reset.

Not included: automated site or experience capture, search or recommendations,
persistent personal/team contexts, collaboration, hosted sync, AI providers, or
legal/copyright policy automation. See [docs/ROADMAP.md](docs/ROADMAP.md).

Technical boundaries and formats are documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/EXPORT_SCHEMA.md](docs/EXPORT_SCHEMA.md), and
[docs/PRIVACY_SECURITY.md](docs/PRIVACY_SECURITY.md).
