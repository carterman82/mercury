---
name: security-and-hardening
description: Threat-model and harden a concrete trust boundary, permission flow, credential path or dependency risk. Use for requested security work or material attack-surface changes; ordinary completed-diff review uses code-review.
---

# Security and hardening

Scope assets, attacker-controlled inputs and receiving authority. Trace an abuse case through the enforcement point before proposing controls. Trust follows who can write a value, including local files, settings, plugin metadata, process arguments, fetched content and model output.

Inspect relevant Mercury boundaries: renderer to preload/IPC, gateway to provider, model to tool, Main to worker, plugin to host, and filesystem/process/network operations. A prompt, type assertion or disabled control cannot enforce permissions. Validate at the receiver, bind actions to the correct project/principal and recheck authorization where state can change before execution.

Consider impersonation, tampering, missing audit evidence, disclosure, resource exhaustion and privilege escalation. Prioritize reachable paths; explain attacker prerequisites, consequence and mitigation. A checklist item without a triggering scenario is not a confirmed vulnerability.

Apply relevant controls:

- Parse and bound inputs; parameterize queries/process arguments; escape or sanitize output for its actual context.
- Resolve paths and symlinks, verify authorized roots/targets and account for check/use races. Before destructive mutation, establish ownership and expected object identity; a self-written marker or path shape alone proves neither.
- For public-network fetches, constrain protocols/destinations, validate redirects and all resolved IPv4/IPv6 addresses, and prevent rebinding between validation and connection. Preserve authorized local-provider networking through its separate policy.
- Keep secrets out of renderer data, model context, logs, errors and source control. Use the existing credential mechanism rather than assuming environment variables are always appropriate.
- Bound sizes, time, concurrency, retries and recursive work. Check cancellation and late callbacks that may outlive authorization.
- Review dependency provenance, lockfile changes and install scripts when supply-chain risk is in scope. Evaluate advisory reachability and fix compatibility; avoid forced upgrades and unrelated installations.

For personal data, establish purpose, minimal fields, access and retention. Track deletion/export across stores in scope. Do not claim legal compliance from a checklist or promise backup deletion without a supported lifecycle.

Keep reviews read-only unless fixes are authorized. For fixes, use inert abuse/regression fixtures and verify denial plus legitimate use through the enforced boundary. Avoid live exploit traffic, credential rotation or production-policy changes without authorization. Never print discovered secrets in findings.

Report location, exploit prerequisites, observed or inferred consequence, evidence and limits. Passing a scanner or unit test does not prove the application is secure.

Adapted from [Addy Osmani's security-and-hardening](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/skills/security-and-hardening/SKILL.md). Local changes target desktop/agent boundaries, retain existing permissions and replace broad mandatory audits with scoped checks. See [LICENSE.txt](LICENSE.txt).
