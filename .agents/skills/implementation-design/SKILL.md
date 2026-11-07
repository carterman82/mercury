---
name: implementation-design
description: Plan a change introducing a module/dependency, altering shared interfaces, or crossing state, persistence or process boundaries. Skip minor isolated edits even when they touch several files.
---

# Implementation design

Inspect the current boundary, callers, data flow and tests. Use dependency maps as leads, then verify against source. Establish the requested observable outcome, compatibility obligations and affected ownership/state. Keep a small change's plan to a few sentences; create a design artifact only when its complexity or user request warrants one.

Choose the smallest cohesive implementation at an existing boundary. Explain a material tradeoff only when more than one plausible approach exists. Reuse an installed dependency or existing pattern where it removes complexity. A new dependency or abstraction needs a concrete task benefit, not hypothetical reuse.

For shared APIs, identify caller updates and compatibility behavior. For persistence, identify schema/version/read/write migration and recovery requirements. For process or asynchronous boundaries, establish ownership, serialization, cancellation, error propagation and resource cleanup. Consider only the dimensions the task touches.

Separate behavior from external effects sufficiently to test it. Prefer explicit inputs/results and validated boundaries; avoid global mutable state and utility layers that obscure ownership. Keep security/permission checks at the actual enforced boundary.

Identify a first testable vertical slice and its verification, then implement incrementally. Do not turn planning into a prerequisite design document for a typo, rename or isolated condition. Record unresolved consequential decisions rather than silently changing user constraints.
