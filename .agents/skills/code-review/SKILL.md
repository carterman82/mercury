---
name: code-review
description: Review a completed substantive diff or an explicitly requested code review for actionable defects. Especially use for permissions, shared interfaces, concurrency or persistence; observed failures use systematic-debugging first.
---

# Code review

Read the request, applicable contracts, actual diff and relevant unchanged callers. Review the final revision, not a worker's summary. Where supported, use an independent read-only reviewer with a bounded scope; Main owns integration and final verification.

Prioritize correctness and execution failures, then security/data integrity, performance regressions and maintainability. Follow concrete input/state paths. Check boundary validation, errors, resource cleanup, cancellation, stale results, compatibility and tests where affected. Do not require broad audits or unrelated cleanup merely because a file is security-sensitive.

For each finding, provide the location, triggering scenario, observable consequence and severity. Distinguish reproduced evidence from a reasoned scenario. Avoid speculative claims, style preferences already handled by tooling, and lists of generic best practices. Say when no actionable defects were found without implying proof of correctness.

Keep review and debugging distinct: review examines completed changes; debugging investigates an observed failure. Read-only review does not authorize edits. When implementing is already authorized, Main may fix in-scope findings, rerun affected checks and request renewed review where the fix changes the reviewed boundary.
