---
name: interview-me
description: Clarify consequential requirements through one question at a time. Use for a requested interview or grilling session, or when missing intent would materially change the implementation. Skip clear requests and routine implementation choices.
---

# Interview me

Resolve what to build before selecting an implementation. Requests such as `/grill-me`, `/interview-me`, or "interview me before coding" select this workflow; these are instruction triggers, not new application commands.

Inspect the request, prior decisions, relevant code and available project context first. Do not ask questions the repository already answers. Identify the unresolved decision with the greatest effect on scope, user experience or acceptance criteria.

Ask one focused question, then wait for its answer before asking another. Include a recommended answer and the concrete tradeoff when useful; make it easy to disagree. Do not hide multiple independent decisions in one question. Continue independent, reversible investigation while waiting, without implementing behavior that depends on the answer.

Explore only gaps that matter:

- Who performs the action, what problem they face and the outcome they need.
- A representative successful interaction and important failure or recovery paths.
- Observable success, constraints, compatibility obligations and excluded scope.
- For UI work, actual content, primary action, density and existing visual conventions before proposing a layout.

Translate vague goals such as "fast" into concrete scenarios. Offer candidate criteria rather than inventing targets and presenting them as agreed. Distinguish the underlying need from a proposed solution without replacing the user's explicit choice.

Stop when the remaining uncertainty can be handled by ordinary implementation judgment. Restate the outcome, acceptance criteria, constraints and non-goals briefly; record consequential unresolved choices. Do not prolong the interview to reach an arbitrary confidence score.

Respect "use your judgment", "sounds good", and instructions to stop asking questions as direction to proceed within the delegated scope. If clarification was incidental to an authorized implementation, continue once the blocker is resolved. If only an interview was requested, deliver the clarified requirements without starting a build. In unattended work, use established decisions and reversible defaults; surface only material decisions that truly prevent progress.

Use `spec-driven-development` if a PRD is warranted. This skill adds no approval gate and cannot authorize publishing issues or changing scope.

Adapted from [Addy Osmani's interview-me](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/skills/interview-me/SKILL.md). Local changes remove numerical confidence gates, repeated confirmation and mandatory turn termination, preserving existing authorization. See [LICENSE.txt](LICENSE.txt).
