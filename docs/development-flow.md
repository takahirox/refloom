# Development Flow

The default flow for Refloom, including AI-assisted development, is:

```text
Issue
  ↓
Implementation
  ↓
Pull Request
  ↓
Review
  ↓
Revision if needed
  ↓
Merge
  ↓
Required post-merge verification, if any
```

## 1. Start with an Issue

Describe the problem, expected outcome, and relevant context using the
[Issue template](../.github/ISSUE_TEMPLATE/issue.md). The Issue defines the scope.
If requirements are unclear, clarify the Issue before implementation instead
of inventing requirements during the change.

By default, completion criteria should be executable and verifiable by an AI
agent. Require human checks, such as physical-device testing, subjective
evaluation, or external approval, only when there is a necessary reason to do so.

When human work is required, state why it is necessary and what result is
expected. Distinguish optional additional validation from mandatory completion
criteria.

Mandatory pre-merge acceptance criteria must be achievable and verifiable
before merge. Record required checks possible only after merge separately as
post-merge verification; they must not be prerequisites for pre-merge PR
approval. This distinction preserves implementation requirements and
applicable pre-merge tests.

For example, when deployment is triggered by merge, validate code/configuration,
local builds, and applicable automated tests before merge. Verify deployment
and the newly published site after merge. Report that post-merge verification
as pending until performed, then record the actual results.

## 2. Implement and Open a Pull Request

**Complete, but no more.** Prefer the smallest change that fully satisfies the
Issue. Avoid unrelated or speculative work, including unjustified abstractions
and refactoring.

Use the [PR template](../.github/pull_request_template.md) to explain what
changed, the resulting outcome, validation, and related Issues. Run the
repository's required checks and validation appropriate to the change; see
[Run and verify](../README.md#run-and-verify) and
[Fleet verification requirements](../.fleet/project.yaml). Record results and
any validation gaps in the PR. Choose validation using the
[test and CI principles](#test-and-ci-principles).

Report pre-merge validation results separately from required post-merge
verification, which remains pending until performed. Never report an
unperformed check as passed.

A PR should only claim to close an Issue when it fully addresses that Issue.
For intentionally partial work, state what is covered and what remains, link
the Issue without closing language, and leave it open.
If required post-merge verification remains pending, state that explicitly and
leave the Issue open until it is satisfied; this does not prevent PR approval
once implementation and pre-merge acceptance are complete.

## 3. Review Before Merge

Every PR should be reviewed against its source Issue using the
[review guidelines](review-guidelines.md). Review must check both missing
requirements and unnecessary scope, as well as correctness and validation.

## 4. Revise Until Review Passes

Address missing work, unnecessary complexity, correctness problems, or
insufficient validation, then validate the revised change and review again.
Partial work must be assessed against its explicitly stated scope without
presenting the source Issue as resolved.

## 5. Merge

Merge after review passes and the required pre-merge checks pass for the
reviewed change.
Close an Issue only when its requirements are fully satisfied.

## 6. Perform Required Post-merge Verification

Perform the separately recorded post-merge checks after merge, such as verifying
a merge-triggered deployment and the newly published site. Keep them pending
until performed, record their actual results and any remaining gaps, and address
failures. Close the Issue only when required post-merge verification is also
satisfied.

## Test and CI Principles

**Detect the required failures at the lightest appropriate layer, without
redundant execution.** Preserve required correctness, regressions, and meaningful
integration coverage when redistributing checks.

1. **Prefer the lightest meaningful layer.** Use the fast `npm test` suite for
   calculations, branches, data combinations, and injected capture/service
   boundaries. Reserve real Chromium/WebGL, PostgreSQL/S3, and Visparse checks
   for behavior requiring those environments. Add tests that catch a concrete
   defect rather than mirror the implementation.
2. **Choose combinations deliberately.** Select representative capture modes,
   viewports, media formats, analysis states, and HTTP/MCP/browser paths that
   exercise distinct processing. Exhaust combinations where interactions require
   them; avoid automatically multiplying every dimension. Retain required
   regressions and integration assertions when moving coverage to lighter tests.
3. **Match validation to the change.** Use the scope guidance below for fast
   feedback and applicable regression validation before merge. Keep mandatory
   pre-merge checks applicable to the change, identify optional validation, and
   record genuinely post-merge-only deployment/publication checks separately.
4. **Reuse work and avoid duplicate execution.** Reuse builds, fixtures, and
   downloads with keys reflecting their inputs and dependencies; preserve test
   isolation, including the integration runner's isolated volumes and cleanup.
   If CI is added, avoid equivalent push/PR runs for the same revision and cancel
   superseded runs when safe while preserving deployment ordering. Parallelize
   independent work only with measured resource use; more workers may not help.
5. **Review value and cost together.** For each new or expanded test, identify
   the additional defect it detects, whether existing coverage already provides
   that assurance, and its execution and maintenance cost. Watch repeated fresh
   Chromium, container, or Python/Visparse setup, large fixtures, long capture
   loops, and Cartesian-product growth.
6. **Maintain an execution-time budget.** No measured normal-CI baseline or
   timing target is recorded yet. Establish one from actual test/CI performance
   work, monitor growth, and investigate overruns by revisiting structure and
   duplication while retaining meaningful assertions and required coverage.
   Track elapsed feedback time, total runner/computation time, and queue time
   separately. Fleet's worker wall-time budget is not a measured CI baseline;
   these principles introduce no benchmark, hardware, or additional merge gate.

### Applying the principles to current checks

There are no checked-in GitHub Actions workflows. Commands live in
[`package.json`](../package.json); [Fleet](../.fleet/project.yaml) declares
required `test` (`node --test`) and `check` (`node scripts/check.mjs`) verification.
`npm test` explicitly selects `test/*.test.js` and is narrower than Fleet's test
command. Preserve applicable mandatory verification and Issue acceptance criteria;
use the following to choose validation for the change, without treating every
available command as mandatory for every edit.

| Change | Relevant validation |
| --- | --- |
| Documentation only | Markdown structure, links/anchors, consistency, and `git diff --check` can suffice; application suites are not needed solely for prose. |
| Browser UI | Fast UI/domain tests and `npm run check`; use browser integration for behavior, rendering, and interactions requiring a real browser. |
| Core/runtime, HTTP/MCP, persistence, capture, or analysis | Fast regression tests and `npm run check`; use `npm run test:integration` for affected PostgreSQL/S3 and Chromium/WebGL boundaries, and `npm run test:analysis` for the real Visparse boundary. |
| CI/build or container packaging | Validate changed configuration and applicable tests/builds before merge; use integration and `npm run check:browser` for affected container/browser startup boundaries. |

`npm run test:integration` builds an isolated Compose environment and runs
`check:browser` before its integration suite; avoid repeating that same preflight
in the same environment. `npm run test:analysis` needs the configured Visparse
installation, uses an offline wrapper, and makes no live model calls. Follow the
[analysis verification guidance](REFERENCE_ANALYSIS.md#persistence-and-verification);
live model smoke validation remains optional and must respect available allowance.
Deployment verification belongs after merge only when it requires a
merge-triggered deployment, as described in steps 1 and 6 above.

## Repository Language

Write repository collaboration artifacts in **English**: Issues, PRs, review
comments, other repository discussions and comments, documentation, and code
comments intended to remain in the repository. This keeps the repository and
its history accessible to contributors and AI development/review agents.
This rule does not impose English on user-facing product content.

Adapted from [GitWeave's development flow](https://github.com/takahirox/gitweave/blob/main/docs/development-flow.md).
