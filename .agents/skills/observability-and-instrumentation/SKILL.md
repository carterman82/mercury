---
name: observability-and-instrumentation
description: Add structured logs, metrics, traces and operational diagnostics for a concrete investigation need. Use when telemetry cannot explain retries, queues or cross-process work, or when instrumentation is requested; skip unrelated logging changes.
---

# Observability and instrumentation

Start with the operational question: which action failed, where time went, whether retries recovered or why a queue stopped. Use `systematic-debugging` for an active failure and `performance` for optimization; this skill improves the evidence those workflows use.

Inspect existing logging, tracing, retention and export conventions. Reuse installed facilities. Do not introduce a vendor, remote exporter or dependency merely to follow an example.

Choose the smallest useful signal:

- Structured events explain an execution: stable event name, outcome, duration and bounded error classification.
- Metrics explain aggregate rate, errors, latency and saturation. Histograms expose tail latency that averages hide.
- Spans explain timing and causality across meaningful operations when tracing is available or warranted.

Carry correlation context from the actual entrypoint through queues, workers and process boundaries. Distinguish chat/task/assignment identities from retry attempt identities. For shared sinks, record the initiating path explicitly rather than guessing from timestamps. Validate and bound incoming correlation values; identifiers are not authorization or proof of identity.

Allowlist fields. Keep provider keys, tokens, raw prompts, document contents, command environments and personal data out of diagnostic payloads unless an explicitly authorized, protected diagnostic mode requires them. Redact error objects and nested causes before serialization. Prefer safe error codes to dumping requests or responses.

Bound cost and volume. Use finite metric labels such as operation and outcome; raw URLs, task IDs, paths and messages create unbounded series. Define sampling/retention where relevant. Close spans on success, failure and cancellation. Ordinary telemetry failures should not fail the operation; preserve separate mandatory audit requirements.

For requested alerts, define a meaningful symptom, justified threshold/duration, owner and short runbook. Use a test sink or dry run for notification checks; instrumentation does not authorize contacting people or changing live alert routes.

Verify actual output for a successful path and controlled failure. Check correlation across the relevant boundary, redaction, label bounds and cancellation cleanup. Distinguish local emission from confirmed collection/delivery; a log call or passing mock does not prove receipt by a remote backend.

Adapted from [Addy Osmani's observability-and-instrumentation](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/skills/observability-and-instrumentation/SKILL.md). Local changes use existing telemetry and project identities, narrow activation and avoid unrequested live notifications. See [LICENSE.txt](LICENSE.txt).
