# Roadmap

This document distinguishes the completed 0.1 core from possible future work.
Items below the first section are directions, not promises or implemented
capabilities. It sequences hypotheses under the durable principles in
`PRODUCT_SPEC.md`; it is not the authoritative product specification. Issues
are finite implementation or research work, so closing Issues #1, #2, #3, or
#4 does not mean the product vision is complete.

## Completed core slice: 0.1

- Local project creation, switching, briefs, deletion, and full reset.
- Immediate image, clipboard, drag/drop, and URL reference capture.
- Later enrichment with descriptive fields and additional image/video assets.
- Explicit reference, asset/target, optional moment, aspect, and intent model.
- Project boards with ordering, aspect filtering/grouping, and removal.
- Human-readable Markdown and versioned creative-direction JSON export.
- Factual activity signals without stored preference inference.
- Revisioned local file persistence and media lifecycle, read-only migration
  from legacy IndexedDB, validated full backup/import, and cascade deletion.
- Keyboard-accessible responsive UI, safe text rendering, security headers,
  domain/storage tests, and HTTP contract tests.
- Opt-in controlled-Chrome capture of bounded initial and deterministic scroll
  screenshots, with progressive Asset/Target/Moment persistence and UI/MCP use.

## Future: richer experience capture

Video, semantic transition detection, hover/click/drag sequences, assisted user
recording, mobile device emulation, and provenance-aware media processing.

## Future: discovery and intelligence

Search, similarity, clustering, recommendation, pattern surfacing, and explicit
user-controlled preference hypotheses. Intelligence must remain distinguishable
from observed facts and must not replace the core workflow.

## Future: persistent contexts

Personal and team history, reusable constraints, cross-project memory, and
context precedence controls. Workspace-level reusable References are part of
this direction; project intent should continue to outrank durable context.
Removing the version-1 `projectId` ownership model is gated by the major-version,
deterministic migration, relationship, media, rollback/export, mixed-version
rejection, and test requirements in `PRODUCT_SPEC.md`.

## Future: collaboration and hosted sync

Accounts, shared workspaces, roles, review, comments, conflict resolution,
encrypted transport, hosted storage, synchronization, and recovery. These would
require a new privacy, authorization, retention, and operations design.

## Future: AI providers

Optional provider integrations for enrichment or synthesis, with provenance,
consent, cost, model disclosure, data-boundary controls, and useful non-AI
fallbacks. Refloom 0.1 sends no data to an AI provider.

## Future: legal and copyright policy

Policy and product work for rights metadata, attribution workflows, takedown,
retention, jurisdictional obligations, and responsible similarity/copying
guidance. Refloom does not determine whether captured or exported material may
lawfully be used.
