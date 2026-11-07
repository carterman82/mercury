---
name: systematic-debugging
description: Investigate an observed error, failing test, crash or incorrect result before changing code. Use evidence to isolate causes; completed-diff review belongs to code-review.
---

# Systematic debugging

Capture the exact failing entrypoint, inputs, environment, expected/actual behavior and actual output. Reproduce with the smallest realistic case. If execution fails before application code, resolve environment uncertainty before editing application logic.

Trace the failure through relevant callers and state transitions. Form competing hypotheses and choose a bounded observation that distinguishes them. Change one diagnostic variable at a time. Successful connectivity does not prove correct protocol/authentication/output handling; a timeout does not identify its cause. Preserve selected providers/endpoints and user data.

Use actual diagnostic commands or `probe_project_endpoint` when appropriate. Before debugging edits, record `record_project_diagnosis` with symptom, hypothesis, evidenceIds, testToConfirm, proposedChange and affectedPaths when offered. Source inspection alone is not execution evidence. State what is confirmed and what remains uncertain.

Once isolated, capture the failing behavior in a focused regression and make the smallest root-cause fix. Do not add broad retries, swallowed exceptions, alternate backends or dependency upgrades to hide a failure. Test the original path and related failure behavior after the fix; a different successful path is insufficient.

If an experiment contradicts the hypothesis, update it rather than accumulating speculative patches. If blocked, give the observed evidence, remaining hypotheses and specific missing check. Do not repeat a denied action or call an unexecuted fix verified.
