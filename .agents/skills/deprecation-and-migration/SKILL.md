---
name: deprecation-and-migration
description: Replace or retire an interface, dependency, persisted schema or feature while preserving consumers and recoverability. Use for explicit migrations and removals; ordinary behavior-preserving cleanup belongs to scoped-refactoring.
---

# Deprecation and migration

Identify the replacement, why the change is authorized and what behavior must survive. Inventory callers, persisted versions, configuration, jobs and external consumers where evidence exists. No code-search matches does not prove a public interface or stored format is unused.

Establish the baseline, compatibility window, deliberate differences and evidence needed to cut over. Prefer staged replacement or an adapter when consumers cannot move together; a fully controlled local-only change may not need a distributed rollout.

For persisted data or mixed-version deployments, consider expand/contract:

1. Introduce a compatible representation before requiring it.
2. Define write ownership and synchronization while both representations exist. Cover concurrent updates and interrupted writes rather than assuming dual writes stay consistent.
3. Backfill with bounded, resumable operations and explicit checkpoints or idempotency. Verify counts and semantic equivalence, not just command success.
4. Switch reads or consumers after compatibility and recovery checks pass.
5. Remove the old path after supported readers/writers no longer depend on it and the rollback window closes.

An additive schema change is not automatically safe: inspect engine/version behavior, locks, rewrites, disk needs and transaction constraints. Test representative data volumes where these risks matter. Separate destructive cleanup from compatibility deployment when old code may still run.

State the actual recovery strategy. A down migration can restore structure without restoring deleted data. For irreversible changes, establish usable backup/restore or forward repair with stated data-loss limits; reverting code does not restore the database. Rehearse restart, partial failure and recovery in isolation.

For dependencies, read version-specific migration notes, inspect the lockfile and update callers. Avoid unrelated upgrades and forced remediation. Preserve authorization boundaries for installation, real-data changes and production operations.

Remove obsolete code, tests, flags and docs only within scope and after replacement coverage exists. Preserve historical decision records. If external consumers cannot be observed, report the limit and retain required compatibility rather than declaring zero usage.

Finish with evidence for old data, new writes, mixed versions where supported, interruption and recovery. Distinguish a prepared migration from one applied to a live system.

Adapted from [Addy Osmani's deprecation-and-migration](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/skills/deprecation-and-migration/SKILL.md). Local changes qualify additive-schema safety and distinguish schema rollback from data recovery. See [LICENSE.txt](LICENSE.txt).
