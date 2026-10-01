# Review Guidelines

Review verifies that a change works and is the right response to its source
Issue. Apply the same standard to human-written and AI-generated changes:
**Complete, but no more.**

## Review Against the Issue

Read the source Issue first and use its problem and expected outcome as the
scope. Ask:

> Is this PR a complete and appropriately scoped solution to the Issue?

Clarify unclear requirements in the Issue rather than inventing new ones in
review. Follow the [development flow](development-flow.md), including its
English-language rule for repository collaboration and documentation.

## Check for Missing Work

Verify every requirement of an Issue the PR claims to resolve. Do not approve
closing the Issue while required work remains unresolved.

If the PR is intentionally partial, it must clearly state what it addresses
and what remains. Assess it against that stated scope and leave the source
Issue open.

## Check for Unnecessary Work

Check that each change and its complexity are justified by the Issue. Watch for:

- unnecessary abstractions or speculative extensibility
- unrelated refactoring
- new frameworks or subsystems without a demonstrated need
- compatibility machinery, configuration, or policy the Issue does not justify

Additional complexity is not automatically beneficial. Unjustified scope and
over-engineering are review failures. Prefer the smallest design that
completely solves the stated problem.

## Check the Result

Verify that behavior matches the expected outcome, the implementation fits the
existing architecture, required checks pass, and validation is sufficient for
the change. Update documentation when documented behavior changes.

## Review Outcome

A PR is ready to merge when it fully addresses the scope it claims to resolve,
adds no unjustified scope or complexity, and is correct and appropriately
validated. Request changes if any condition is unmet, then review the revision.
Partial PRs must not present the source Issue as resolved.

Adapted from [GitWeave's review guidelines](https://github.com/takahirox/gitweave/blob/main/docs/review-guidelines.md).
