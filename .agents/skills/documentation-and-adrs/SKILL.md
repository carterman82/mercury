---
name: documentation-and-adrs
description: Write technical documentation and architecture decision records that preserve rationale, constraints and operational steps. Use for requested docs, changed documented behavior or a consequential design decision; skip commentary on obvious code.
---

# Documentation and architecture decisions

Identify the reader and task: running the project, using an API, recovering an operation or understanding a costly decision. Read the implementation, existing docs and relevant history. Distinguish observed behavior, intended behavior and proposals.

Follow existing documentation location, format, naming and ADR sequence. Check instructions and ADR configuration as well as filenames. Do not create a second decision system or persistent agent rules as a side effect of ordinary documentation work.

For an architecture decision, preserve:

- Context and constraints making a choice necessary.
- Decision and status according to project convention.
- Plausible alternatives and concrete reasons for the choice.
- Consequences, limitations and evidence that could cause reconsideration.

Use a short record for a narrow decision; an implementation detail does not automatically need an ADR. Do not label a proposal accepted without a supporting decision. When an accepted choice changes, preserve history and link the superseding record.

For operational/API docs, give prerequisites, the actual entrypoint, a minimal working example, expected results and material failure/recovery behavior. Preserve exact commands, versions, units, paths and links. Explain permissions and external effects where needed to perform the task; documentation cannot grant authorization.

Comment non-obvious invariants and reasons near the code they constrain. Avoid narrating statements, speculative maintenance advice and unrelated cleanup. Update existing documentation rather than adding a duplicate summary that will drift.

Review edited prose against its sources. Preserve qualifiers and uncertainty; do not polish unsupported claims into guarantees. Verify local links and commands against the project. Run safe examples when proportionate and permitted; mark unexecuted external or destructive steps unverified rather than executing them to validate prose.

Report what the document enables the reader to do and material factual gaps. Doc-only work needs content/link inspection, not invented application behavior tests.

Adapted from [Addy Osmani's documentation-and-adrs](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/skills/documentation-and-adrs/SKILL.md). Local changes narrow creation to the requested scope and distinguish proposals from accepted decisions. See [LICENSE.txt](LICENSE.txt).
