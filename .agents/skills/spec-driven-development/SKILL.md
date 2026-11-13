---
name: spec-driven-development
description: Turn a substantial feature idea into a scoped PRD or specification with testable acceptance criteria and an implementation sequence. Use when a spec is requested or a significant feature has unresolved requirements; skip small, already clear changes.
---

# Spec-driven development

Use `/spec`, `/to-spec`, or a request for a PRD as instruction triggers. Read existing requirements, conventions, interfaces and decisions before drafting. Reuse the project's specification location and format; do not create a parallel requirements system.

Separate established requirements, evidence from current code, proposed defaults and unresolved decisions. Clarify consequential gaps; use `interview-me` if a live interview is needed. A spec makes assumptions visible rather than converting them into requirements.

Scale the artifact to the work. A cohesive feature needs one concise spec. When an initiative contains capabilities that can ship and be verified independently, identify their responsibilities, consumers and dependencies before detailing each. Do not split modules to meet a file-count limit or merge valid separate modules just because they collaborate.

Cover the applicable elements:

- Problem, intended users, objective and explicit non-goals.
- User journeys and behavior, including empty, failure, cancellation and recovery states where relevant.
- Inputs, outputs, ownership and contracts at affected boundaries.
- Constraints: existing stack, compatibility, permissions, data handling and relevant performance targets.
- Acceptance criteria describing observable outcomes, each with an appropriate verification method.
- Dependencies, rollout or migration needs, risks and unresolved choices.

Keep requirements distinct from implementation proposals. "Cancel stops further writes and preserves completed results" is behavior; a particular cancellation library is an implementation choice unless required. Do not invent benchmark numbers, integrations or features to fill a template.

Use `implementation-design` for the technical approach. Order work by dependencies and identify a first end-to-end, testable slice. Each task names its result and verification; infrastructure-only steps do not prove the feature works. Use existing TDD and verification workflows when implementation is authorized.

A spec-only request ends with the spec and material open questions. A request to design and build authorizes proceeding with settled decisions; do not insert repeated approval stops between phases. Pause only for an unresolved decision or permission actually required by the task. Do not publish issues, commit or deploy merely because an upstream workflow does so.

Update the spec when authorized scope or decisions change. Preserve links between requirements, tasks and evidence. Distinguish specified, implemented and verified outcomes.

Adapted from [Addy Osmani's spec-driven-development](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/skills/spec-driven-development/SKILL.md). Local changes replace mandatory phase approvals and fixed artifact paths with existing conventions and authorization. See [LICENSE.txt](LICENSE.txt).
