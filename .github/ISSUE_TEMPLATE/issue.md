---
name: Issue
about: Report a problem or propose a change
title: ""
labels: ""
assignees: ""
---

<!-- Write in English. The Issue defines the scope; clarify unclear requirements before implementation. -->

## Problem

Describe the problem.

## Expected outcome

Describe what should be true when the Issue is resolved.

Default to completion criteria an AI agent can execute and verify. Require human
checks only when necessary; explain why and the expected result, and distinguish
optional validation from mandatory criteria. See the
[Issue-authoring guidance](https://github.com/takahirox/refloom/blob/main/docs/development-flow.md#1-start-with-an-issue).

### Pre-merge acceptance criteria

List mandatory acceptance criteria that can be achieved and verified before
merge. Preserve implementation requirements and applicable pre-merge tests.
For a merge-triggered deployment, validate code/configuration, local builds,
and applicable automated tests before merge.

### Required post-merge verification

Record checks possible only after merge separately, or state that none apply.
These checks must not be prerequisites for pre-merge PR approval. For the
deployment example, verify deployment and the newly published site after merge.
Report required post-merge verification as pending until performed, then record
the actual results; do not imply that pending checks passed.

## Context

Add relevant context, examples, logs, or related Issues.
