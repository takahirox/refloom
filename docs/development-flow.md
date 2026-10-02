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

## 2. Implement and Open a Pull Request

**Complete, but no more.** Prefer the smallest change that fully satisfies the
Issue. Avoid unrelated or speculative work, including unjustified abstractions
and refactoring.

Use the [PR template](../.github/pull_request_template.md) to explain what
changed, the resulting outcome, validation, and related Issues. Run the
repository's required checks and validation appropriate to the change; see
[Run and verify](../README.md#run-and-verify) and
[Fleet verification requirements](../.fleet/project.yaml). Record results and
any validation gaps in the PR.

A PR should only claim to close an Issue when it fully addresses that Issue.
For intentionally partial work, state what is covered and what remains, link
the Issue without closing language, and leave it open.

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

Merge after review passes and the required checks pass for the reviewed change.
Close an Issue only when its requirements are fully satisfied.

## Repository Language

Write repository collaboration artifacts in **English**: Issues, PRs, review
comments, other repository discussions and comments, documentation, and code
comments intended to remain in the repository. This keeps the repository and
its history accessible to contributors and AI development/review agents.
This rule does not impose English on user-facing product content.

Adapted from [GitWeave's development flow](https://github.com/takahirox/gitweave/blob/main/docs/development-flow.md).
