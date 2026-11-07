---
name: verification
description: Choose proportionate checks and establish evidence before reporting a coding task finished. Distinguish implemented work from verified behavior, and native/CLI checks from UI and browser-model checks.
---

# Verification

Translate the requested result into observable outcomes and choose checks before implementation. Preserve saved requirements; do not weaken or delete them to obtain a pass. Use actual task entrypoints and `inspect_project_target` where classification is unclear.

- Documentation/declarative-only work: inspect the rendered/resulting content or relevant configuration validity. Do not invent behavioral tests for plain prose.
- Executable logic, CLI or native app work: run focused behavioral/regression tests and exercise the changed entrypoint or integration boundary. Builds, typechecks, lint and imports support verification but do not prove behavior.
- User-visible UI behavior: run relevant automated tests and exercise the affected interaction in the actual UI when supported. Observe the result after interaction and check relevant errors. A screenshot proves appearance, not interaction; browser checks are conditional on UI work, not on every coding task.
- Browser-side model inference only: read [browser-model.md](references/browser-model.md). Native models and remote clients do not require browser model stages.

Run checks with the verified environment and correct cwd. Record test/smoke commands with `purpose:"test"`; use `purpose:"build"` for builds and `purpose:"inspect"` for static checks. Check exit status and output for skipped tests, empty collection or application errors. Server startup, package installation and a mocked response do not prove the real user path works.

After the final relevant edit, run affected tests and the changed behavior smoke check. Broaden to dependent suites for shared interfaces/state, then the repository-required checks. Respect explicit full-suite requirements. Reuse successful checks until a later change invalidates them; if evidence tracking invalidates observations, obtain fresh evidence. Do not repeat an unchanged failing command without new information. Separate pre-existing failures from regressions and report both accurately.

Use exact returned evidence IDs with task tools; never invent them or substitute file hashes. A requirement marked `passed` needs successful current evidence after relevant mutations. `complete_project_requirements` records implemented work and limitations; it does not mean tests passed. Preserve that distinction when execution is blocked. Report checks as passed, failed, blocked or not run, with the remaining practical limitation. Do not claim overall verification while required behavior remains untested.
