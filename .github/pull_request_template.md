<!-- Write in English. Prefer the smallest change that fully satisfies the Issue. -->

## Summary

Describe what changed and why it is needed for the Issue.

## Outcome

Describe the result, including before/after behavior when useful.
If this is partial work, state what is addressed and what remains unresolved.

## Validation

Describe the checks run and their results, including any validation gaps.
Separate mandatory pre-merge results from genuinely required post-merge-only
checks, or state that none apply. Report pending, unperformed, or environment-blocked
checks accurately; Issue closure does not mean they passed. Follow the
[post-merge evidence and defect guidance](https://github.com/takahirox/refloom/blob/main/docs/development-flow.md#6-perform-required-post-merge-verification).

## Related Issue(s)

Link relevant Issues. Use `Closes #...` when implementation and applicable mandatory
pre-merge acceptance are complete. Preserve it even if post-merge-only checks are
pending; these do not make implementation partial or block approval. Close the
Issue after successful merge, then perform those checks. Use `Related to #...`
for intentional partial work, state the remaining scope, and leave the Issue open.
