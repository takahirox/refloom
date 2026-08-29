# Refloom 0.1 product slice

## Objective

Deliver the smallest coherent product in which a creative project can capture a
reference with almost no friction, progressively enrich it, select only the
relevant target/aspect for a board, export creative intent, and retain the
observable decisions that led to that export.

The slice must remain useful without AI, a hosted backend, login, or network
access. It should be installable and runnable with a recent Node.js runtime and
no third-party packages.

## Required user journey

1. Create and switch between projects with a title and optional brief.
2. Capture an image by file picker, drag/drop, or clipboard; alternatively save
   a URL immediately without waiting for metadata or screenshots.
3. Enrich a reference later with title, source URL, creator, notes, additional
   image assets, and video assets while preserving capture metadata.
4. Create a project-scoped selection that keeps Reference, Asset/Target,
   optional Moment, Aspect, and Intent conceptually distinct.
5. Compose selections into a board and filter or group them by aspect.
6. Export the board as a human-readable document and a versioned structured JSON
   package suitable for external tools or coding/design agents.
7. Record factual signals for capture, enrich, selection, board changes, and
   export. Never store an inferred taste statement as fact.
8. Delete user-owned projects/references with explicit confirmation and provide
   a complete local-data reset/export/import path.

## Conceptual model

- Project: immediate creative task and strongest context.
- Reference: source creative work being referenced.
- Asset: captured material such as image, video, or URL.
- Target: whole reference, asset, region/frame, moment, or interaction sequence.
- Moment: optional time/state-specific target.
- Selection: project-specific use of a target, aspect, and intent.
- Board: project-scoped composition of selections.
- Signal: observable event, not a preference inference.

## Acceptance criteria

- All required user journey steps are available in a polished responsive UI.
- Image/URL capture is immediate and required metadata is zero beyond the input.
- Binary assets are retained locally and survive reload.
- The domain layer validates imported data and prevents dangling selections.
- Structured export has a documented version and includes provenance.
- Accessibility includes keyboard operation, labels, focus states, semantic
  landmarks, reduced-motion support, and useful empty/error states.
- Automated tests cover domain invariants, import validation, cascade deletion,
  selection precision, and export shape.
- A deterministic repository check rejects syntax errors and missing required
  deliverables.
- Architecture, security/privacy, limitations, and follow-up roadmap are
  documented. Future rich automatic site capture, search/recommendation,
  collaboration, and AI providers are explicitly outside this local-first slice.

## Product constraints inherited from Issue #1

- Capture first; organize later.
- References are evidence, not instructions to copy.
- Decisions are factual; taste remains inferred and separate.
- Partial relevance is first-class.
- AI enhances but does not define the product.
- Preserve provenance whenever possible.
- Project intent outranks persistent context and personal/team history.
- Intelligence features surround the core workflow and must not be conflated
  with it.

