---
name: performance
description: Improve runtime speed or resource use when requested, when a performance regression is observed, or when a concrete bottleneck is measured. Avoid speculative optimization during unrelated changes.
---

# Performance

Define the user-visible metric and representative workload: latency, throughput, startup time, memory or resource use. Capture a baseline in the correct environment. Separate setup/warmup from steady-state work and account for caches, input size and variability. Do not report a single noisy measurement as a reliable improvement.

Profile or instrument enough to locate the actual cost. Prefer removing redundant work, excessive I/O, unnecessary serialization or poor algorithms before micro-optimizing syntax. Bound concurrency, caches and memory. Consider cancellation and cleanup; faster happy paths cannot justify corrupt state or unbounded resources.

Change one meaningful factor, preserve behavior with tests, and compare the same workloads/settings. Include relevant small and large inputs and failure paths so the optimization does not move cost elsewhere. Report observed results and variability; do not promise improvements across unmeasured machines or workloads.

Keep the readable approach unless a measured benefit warrants complexity. Document non-obvious constraints near the optimized code. If no bottleneck is established, report what is known and avoid speculative rewrites.
