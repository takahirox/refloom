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
Close the fully implemented Issue
  ↓
Required post-merge verification, if any
```

This lifecycle supersedes older instructions to keep an implemented Issue open
solely for post-merge verification. Preserve historical test results and evidence;
this change does not retroactively mark any check as passed.

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

Require post-merge verification only when the actual change needs it. Documentation
edits do not acquire routine manual approval, physical-device, heavyweight model
download, or deployment gates. Existing applicable verification requirements
remain in force.

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

A PR should use the normal `Closes #N` reference when implementation is complete
and applicable mandatory pre-merge acceptance criteria are satisfied, even if
required post-merge-only verification is pending. Record those checks separately;
their pending status does not make the implementation partial.
For intentionally partial work, state what is covered and what remains, link
the Issue without closing language, and leave it open.

Missing implementation, mandatory pre-merge tests, required protections, and
genuinely necessary pre-merge human acceptance remain blockers. Do not defer
these to post-merge verification to claim completion.

## 3. Review Before Merge

Every PR should be reviewed against its source Issue using the
[review guidelines](review-guidelines.md). Review must check both missing
requirements and unnecessary scope, as well as correctness and validation.

ProjectWeave publication adds `Closes #N`, and its merge/close stages close the
source Issue. Review must not request removing that reference, keeping the Issue
open, or withholding approval solely because a post-merge-only check is pending.
Doing so makes review and publication undo each other in repeated
Review -> Fix -> Publish -> Review rounds.

## 4. Revise Until Review Passes

Address missing work, unnecessary complexity, correctness problems, or
insufficient validation, then validate the revised change and review again.
Partial work must be assessed against its explicitly stated scope without
presenting the source Issue as resolved.

## 5. Merge

Merge after review passes and the required pre-merge checks pass for the
reviewed change.
Close the fully implemented Issue after successful merge, including when required
post-merge-only checks remain pending. Closure records implementation and pre-merge
acceptance; it does not claim that pending or unperformed checks passed.

## 6. Perform Required Post-merge Verification

Perform the separately recorded required post-merge checks after merge and Issue
closure, such as verifying a merge-triggered deployment and the newly published
site. Record actual results and supporting evidence in the merged PR, closed
Issue, or a linked validation report. Report unperformed, pending, and
environment-blocked checks honestly, including any remaining gaps. An unavailable
test environment alone is not evidence of a product defect.

If verification finds an actual defect, check for an existing equivalent Issue
first. Use it if present; otherwise create a new linked Issue with reproduction
steps, the affected revision, expected and actual behavior, and links to the
original Issue and PR. Do not reopen the original Issue solely for post-merge
follow-up. Preserve historical results and add new evidence without rewriting
the earlier outcomes.

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
