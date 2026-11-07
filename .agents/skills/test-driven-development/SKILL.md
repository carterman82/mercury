---
name: test-driven-development
description: Test-first red-green-refactor for new executable behavior and confirmed bug fixes before implementation. Also use when the user requests /ttd, /tdd or TDD. Exclude prose-only and declarative-only changes.
---

# Test-driven development

Adapted from [Superpowers TDD](https://github.com/obra/superpowers/tree/main/skills/test-driven-development), copyright Jesse Vincent, under the [MIT license](LICENSE.txt). Mercury adaptations preserve existing user work and proportionate task scope.

1. Define one observable behavior at a public boundary.
2. Write a focused test before implementing that behavior. Run it with the verified runtime and `purpose:"test"`.
3. Confirm the failure demonstrates the missing behavior, not a broken fixture, import, environment or syntax. An existing accurate failing regression can supply this red state.
4. Make the smallest implementation that satisfies the behavior. Run the test and affected regressions to establish green.
5. Only then perform necessary, behavior-preserving cleanup as a separate step; run tests again. Repeat for the next behavior.

Preserve existing user code. Never delete prior work to manufacture a test-first history. For legacy cleanup, establish characterization tests and a green baseline instead. Documentation, static configuration and generated outputs need appropriate validation rather than artificial failing tests. If tests cannot execute, report that limitation; do not fabricate red/green evidence.

Use `behavioral-testing` for assertion/fixture choices and `verification` for final checks. Retain the actual red reason, green outcome and remaining untested behavior.
