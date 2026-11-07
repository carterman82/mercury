---
name: behavioral-testing
description: Design meaningful tests for new or changed behavior, regressions, edge cases and external effects. Use when choosing assertions, fixtures or test boundaries; test-driven-development controls implementation order and verification controls final checks.
---

# Behavioral testing

Derive cases from the user contract and callers, not from the implementation's branches. For each proposed test, identify a realistic incorrect behavior that would fail it. Assert public outputs, errors, state transitions or durable effects; tests that merely reproduce a calculation or match source wording provide little protection.

Select the highest-value applicable cases: normal behavior, empty/boundary inputs, invalid inputs and failures. For asynchronous state, consider cancellation during work, stale/out-of-order results, cleanup and concurrent access. Test only relevant risks; do not manufacture a universal case matrix.

Choose the lowest boundary that catches the defect. Use real local code and temporary fixtures where practical. Mock only expensive, nondeterministic or unavailable external boundaries, and keep their contract realistic. An integration bug needs a test across the affected boundary; unit mocks of both sides can conceal it. A fake service test cannot establish live service compatibility.

Keep arrange, action and observable assertions clear. Use controlled clocks/events rather than arbitrary sleeps. Isolate filesystem/network/state and restore it on failure. Assert that the fixture reaches the intended condition so a failed setup cannot produce a false pass. Do not weaken assertions or change expected behavior merely to make implementation pass.

For a bug, the regression should fail against the original behavior for the intended reason and pass after the fix. For legacy code, capture existing externally observable behavior before refactoring. Keep test utilities outside production APIs; introduce production interfaces only when they improve the real design.

Use the existing framework and commands. Do not add a framework or dependency for a test that existing tools can express. Record meaningful coverage gaps; a coverage percentage alone is not correctness evidence.
