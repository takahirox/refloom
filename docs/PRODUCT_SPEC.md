# Refloom product specification

This is the authoritative living specification for Refloom's long-term product
direction. It separates durable principles from implemented 0.1 behavior and
future hypotheses. The 0.1 slice is described in `PRODUCT_SLICE.md`; the roadmap
sequences hypotheses rather than redefining this specification.

## Durable product principles

Refloom helps people turn references into creative direction without collapsing
evidence, interpretation, and intent into one object. Its core vocabulary is:

- **Context**: the project, brief, constraints, and eventually explicit personal
  or team history within which a decision is made. Immediate project intent
  outranks persistent context.
- **Reference**: a reusable source work or piece of evidence, with provenance.
  Long-term, References belong to the workspace and may be reused across
  projects; they are not instructions to copy.
- **Target/Moment**: the exact source-linked part, region, frame, interaction, or
  state under consideration. Targets and Moments remain attached to their
  source Reference rather than to an interpretation.
- **Aspect**: the quality being considered, such as typography, motion, layout,
  tone, or pacing.
- **Signal/Decision**: a Signal records an observable event or fact. A Decision
  expresses a context-specific intended use. Refloom must not present inferred
  taste or preference as fact.

Reference tags are optional and non-exclusive. They describe the Reference and
its broad usefulness, and remain distinct from the project-specific Aspect and
Intent recorded by a Selection.

Selections bind a source-linked Target and optional Moment to an Aspect and
intent. Selections, Boards, Signals, and Decisions remain project- or
context-specific even when their Reference is reusable.

Human creative judgment is authoritative. Refloom preserves provenance,
supports partial relevance, and helps people articulate decisions; it does not
automatically turn similarity or model output into direction. Capture should be
fast, organization may be progressive, and enrichment must not erase original
source facts.

The core is local-first and useful without AI, an account, a hosted service, or
a network connection during the core workflow. AI may later assist enrichment,
discovery, or synthesis only with explicit data boundaries, provenance, and a
useful non-AI path.

Agent and capture capabilities are bounded adapters around this core. They use
explicit, narrow operations; progressively disclose data; preserve revision and
provenance constraints; and do not gain arbitrary filesystem, destructive, or
workspace-replacement authority. Initial open-world website capture is visibly
default-on with per-create and shared-Workspace opt-out controls. It runs only
after a URL Reference is committed, accepts that existing Reference rather than
an arbitrary request URL, and is constrained by documented network, queue, and
resource limits. Later or repeated capture remains explicit.

## Current 0.1 behavior

Version 0.1 implements projects as the strongest available Context. Its version
1 domain stores `projectId` on References, Assets, Targets, and Moments, and its
validation and deletion behavior treat those records as project-owned. This is
a deliberate 0.1 simplification that keeps relationships, deletion, export, and
import deterministic while delivering one coherent local workflow. It is not a
permanent product principle.

Changing ownership now would alter domain relationships, cascades, imports,
exports, MCP assumptions, and existing saved work. A migration would therefore
add compatibility and data-loss risk without a requested user-facing migration
outcome. The documentation change for Issue #2 does not refactor the version-1
domain or migrate data.

The authoritative 0.1 workspace is held in normalized PostgreSQL tables and
media in a private S3-compatible bucket, coordinated by one revision row. The
browser has no authoritative persistence or legacy reader. Version 0.1 also includes
bounded website screenshot capture and a bounded local stdio MCP interface.
These are implemented capabilities, not claims that richer experience capture
or general agent autonomy is complete.

## Independently versioned contracts

These boundaries are separate contracts and must not share an implied version:

- **Persistence schema**: deterministic SQL migrations, normalized entity rows,
  the global revision, and registered media metadata. It is authoritative
  runtime state and is not a portable interchange format.
- **`refloom.workspace-backup`**: the portable, complete restore expression for
  a supported workspace version, including referenced media. Import validates
  it and replaces authoritative state only after confirmation.
- **`refloom.creative-direction`**: the portable, board-scoped expression of
  direction. It deliberately omits unrelated workspace entities and binary
  media and is not restorable as a workspace.
- **Live MCP contract**: protocol version, tool/resource schemas, pagination,
  mutation authority, errors, and revision coordination for a running store.
  It is an operational interface, not a serialized copy of the workspace.

Each contract evolves and rejects unsupported incompatible versions
independently. Compatible additive fields may be ignored where that contract
allows it, but an unknown major or format version must not be guessed. MCP is
not backup: it exposes bounded reads and mutations, omits full replacement and
many records in any single response, and cannot guarantee a restorable atomic
snapshot with all referenced media.

## Future Reference ownership migration gate

Workspace-level reusable References remain the intended model, but project
ownership may be removed only when one migration decision record and its
implementation satisfy all of these prerequisites:

1. Introduce a new workspace envelope/domain major version; version 1 remains
   readable only through an explicit migration path, never reinterpretation.
2. Define a deterministic `refloom.workspace-backup` migration and fixtures for
   every supported version-1 shape.
3. Preserve stable IDs, provenance, timestamps, and every referenced media byte,
   or document and test an unavoidable mapping.
4. Specify cross-project deduplication and reuse semantics, including whether
   apparently identical sources merge, alias, or remain distinct and how users
   control that choice.
5. Validate all Reference–Asset–Target–Moment and
   Context–Selection–Board–Signal/Decision relationships before commit.
6. Provide a rollback/export strategy that leaves the original backup
   recoverable and permits export before replacement.
7. Reject mixed-version state rather than partially migrating or silently
   accepting both ownership models.
8. Add automated migration, relationship, media-preservation, ID-stability,
   deduplication, failure-atomicity, rollback/export, and mixed-version tests.

Until those gates are met, version-1 project ownership is the compatibility
boundary and new code must not simulate workspace reuse by weakening validation.

## Planning documents and completion

This product specification is living: it changes when durable product decisions
change. `ROADMAP.md` sequences validated and unvalidated hypotheses. GitHub
issues are finite implementation or research items with explicit acceptance
criteria. Closing Issues #1, #2, #3, or #4 means only that each issue's bounded
work is complete; it does not mean the product vision is complete.
