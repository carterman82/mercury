---
name: environment-discovery
description: Establish the correct runtime, dependencies, working directory and task target before executing code when these are unknown or after environment failures. Reuse verified environments; do not repeat setup for each command.
---

# Environment discovery

Read applicable instructions, manifests, lockfiles, runtime version files, task entrypoint and existing test commands. Identify the actual project/subproject root, selected backend, expected runtime version, environment and dependency manager. Inspect scripts before executing them. A lockfile is evidence of intended dependencies, not proof they are installed.

For mixed/native/model projects, call `inspect_project_target` with the actual affected project-relative `entryPoint`. Native Python, GGUF/ONNX and remote model clients do not imply browser inference. Unknown classification requires inspection, not a guess from the user's wording.

For Python, use Mercury's deterministic `discover_project_python` tool before choosing an interpreter. Inspect project environments and constraints; metadata and its recommended path are not verified executable versions. If the inventory is unresolved and launcher registrations could help, `includeLauncher:true` requests the fixed approved launcher listing. Missing PATH entries, Store aliases, inaccessible roots and isolated launch failures do not prove Python is absent. Do not invent paths or loop through guessed commands.

Use an existing compatible project environment when verified. When dependency setup is needed, Main uses `setup_project_python_environment` with an absolute installed `interpreter`, project-local `environmentPath`, exact package specs, `expectedVersion` when known and relevant `imports`. Use the returned interpreter for subsequent tests, without activation or mixing site-packages. A denial/timeout ends setup; report the blocker rather than changing interpreters or retrying through another installer. Never install a runtime or replace an environment as an implicit workaround.

For other runtimes, use manifest/version constraints and the existing package manager. Verify the executable version and relevant dependency availability through normal execution tools; do not download tooling merely because one command failed. Preserve lockfiles and avoid global installation. Reuse deterministic discovery tools rather than recreating their logic in ad hoc scripts.

Prefer `run_project_process` with separate `executable` and `args` for explicit interpreters and paths with spaces. Use `cwd` for the subproject, not an embedded shell directory change. Mercury's Windows command shell is cmd.exe; do not send PowerShell/Bash syntax to it. Use stdin for script source instead of quote/base64 reconstruction. Discovery uses `purpose:"inspect"`; tests and smoke checks use `purpose:"test"`.

Retain a short execution record: verified executable/version, environment, working directory, relevant dependency check, intended test command and unresolved limitations. Setup success is not application success. Recheck only when runtime/dependency inputs change or execution contradicts the record.
