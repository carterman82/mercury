---
name: api-and-interface-design
description: Design or change shared API, IPC, plugin or module contracts with explicit validation, errors, compatibility and retry semantics. Use for meaningful consumer-facing boundaries, rather than every private helper or component prop.
---

# API and interface design

Inspect the provider, actual consumers, runtime validators and contract tests. Identify observable behavior callers depend on, including ordering, errors and undocumented quirks. Use `implementation-design` for the overall change; this workflow supplies the boundary contract.

Define inputs, outputs, optional versus absent values, failure variants and ownership before implementing. Follow existing naming and error conventions. Prefer types that rule out invalid state combinations. Separate transport DTOs from mutable internal records where exposing internals would create coupling.

Validate at trust boundaries, not merely where static types exist. IPC messages, model/tool arguments, older persisted records, external responses and plugin data can violate TypeScript declarations. Check shape, size and permitted values; enforce resource ownership and permissions in the receiving process. A renderer check is not an authorization boundary.

For asynchronous operations, define cancellation, deadlines, partial results, resource cleanup and late responses. Establish resource ownership and behavior when the caller disconnects. Bound list results, payloads and concurrency where they can grow; use deterministic ordering and stable pagination when needed.

For retried state changes, distinguish one intent from its attempts:

- Reuse the same idempotency key across retries of one intent; distinct intents need distinct keys.
- Claim the key atomically with uniqueness scoped to the correct principal and operation.
- Bind it to a normalized payload; reject the same key with different input.
- Define in-flight duplicates, completed-result replay and retention covering every supported retry/replay path.
- Treat a timeout as an unknown outcome. Reconcile or use downstream idempotency rather than repeating an external effect blindly. An internal key alone cannot guarantee exactly-once effects across another service.

Prefer compatible extension where it preserves consumers. Optional fields can still break strict validators; test both sides rather than assuming addition is safe. Use `deprecation-and-migration` for intentional breaking changes.

Verify through the real serialization/transport boundary where relevant: accepted inputs, malformed/unauthorized inputs, old-consumer behavior, failure variants, cancellation and concurrent duplicates. Avoid tests that only repeat internal type assertions. Document caller-visible guarantees and limits alongside the contract.

Adapted from [Addy Osmani's api-and-interface-design](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/skills/api-and-interface-design/SKILL.md). Local changes cover IPC/tool boundaries and avoid universal REST conventions or blanket trust in internal data. See [LICENSE.txt](LICENSE.txt).
