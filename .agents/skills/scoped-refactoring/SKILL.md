---
name: scoped-refactoring
description: Simplify code only when the user requests cleanup or a specific cleanup is necessary for the authorized change. Touching a file does not authorize unrelated refactoring; keep behavior changes separate.
---

# Scoped refactoring

State the concrete cleanup target and why it is in scope. Read callers and existing contracts. Establish a green behavioral baseline; if coverage is insufficient, add characterization tests before changing structure. Preserve quirks unless a behavior change is explicitly requested.

Make one behavior-preserving structural step, then run affected tests before a separate behavior change or further risky step. Do not refactor and change behavior in the same step. If the baseline fails, distinguish existing failures and avoid claiming equivalence without a usable check.

Prefer removing duplication, clarifying names, reducing nesting and separating mixed responsibilities. Extract a helper only when it clarifies the current code; preserve public interfaces unless changing them is part of the request. Avoid framework migrations, wholesale rewrites, formatting unrelated files and speculative extensibility.

Keep the diff easy to review. Preserve error semantics, ordering, side effects, cancellation and resource lifetime as well as return values. Stop when the stated cleanup is complete. Explain any behavior that could not be checked rather than declaring the refactor safe from inspection alone.
