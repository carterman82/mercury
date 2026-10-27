# Mercury Projects: Claude Agent SDK delivery plan

## Scope and retained foundation

Projects contain persistent chats associated with local folders. Main acts directly; Planner and a future Plan mode remain deferred. Ordinary chats retain their existing runtime. Legacy plans, approvals and change history remain available read-only.

Preserve completed desktop/chat capabilities: SQLite history, streaming and reasoning where supplied, cancellation, file attachments and artifacts, browser and source-memory tools, model discovery, protected credentials, provider queues, subscription-first routing, Main/Subagent model pools and device-aware selection. Local inference remains on external Ollama/LM Studio servers. OpenAI API, direct ChatGPT, experimental Codex app-server and Claude API connections remain distinct.

Subagents contributed the gateway/provider boundary, native execution and dependency analyzers. Implementation and release acceptance are distinct: SDK installation and mocked tests do not establish provider parity or confinement.

## Current implementation

- Indexed project/chat ownership, default permission level 2, persistent selector, expandable sidebar, shared revisioned notes and ordinary-chat separation.
- Git chat worktrees capture eligible dirty tracked/untracked source without changing the original branch/index. Exact review tokens and source hash checks protect integration. Ordinary folders use serialized hash-checked edits. Missing Git is handled separately from an invalid repository.
- `ProjectAgentRuntime` runs project Main and workers through pinned `@anthropic-ai/claude-agent-sdk` 0.3.310. Ordinary chats retain their existing loop. The former Mercury Project tool loop is removed from that path.
- Authenticated loopback gateway binds each route to project/chat/agent and the exact selected model. SDK processes receive only ephemeral gateway credentials, never provider credentials.
- Mercury custom tools own filesystem, command, plugin, artifact, browser, notes, source-memory, map and integration operations. SDK filesystem/shell/delegation tools, skills, plugins and unrelated settings are disabled. Tool handlers enforce authorization.
- Persisted SDK sessions and assignments distinguish completed, interrupted, failed and accepted work. Restart marks unfinished work interrupted; no commands or approvals replay automatically.
- Pinned Microsoft MXC 1.0.1 adapter verifies assets, probes exact policies and rejects weaker/audit/unrestricted fallback. Restricted execution requires supported native Windows containment.
- Implementing/testing workers have explicit owned paths and separate Git checkouts; investigation/review workers are read-only. Concurrency defaults to three, configurable 1–8, subject to provider capacity. Recursive delegation is unavailable.
- JS/TS compiler and Tree-sitter WASM analyzers generate dependency graphs/Mermaid hierarchy for JS/TS, Python, Java, C#, Go, Rust, C/C++ and recognized configuration. A read-only map browser reports freshness, coverage and unresolved references.

## 1. SDK runtime and provider compatibility

### Runtime boundary

The SDK owns Project inference/tool iteration and session management. Mercury translates SDK events into answer text, tool activity, reasoning where supplied, worker progress, errors, request state and elapsed time. Stop, downgrade and shutdown cancel owned work and await cleanup. Inference retries must never replay completed tools.

Use isolated SDK configuration directories and an explicit environment. Package SDK modules, peers and the native executable outside ASAR; do not rely on a globally installed Claude environment. SDK permission callbacks cannot grant Mercury permissions.

Store runtime/version, session reference and a fingerprint of owning project/chat/worker, workspace, model, instructions and tools. Resume only compatible completed identities. Existing history or incompatible sessions begin from bounded saved context as historical evidence; model changes must not replay earlier actions. Preserve attachments, evidence, notes and worktree associations.

### Gateway

- Listen only on loopback; independent unpredictable run credentials and opaque model aliases.
- Bind helpers/compaction to the same authorized exact model; never silently switch to Claude or another paid route.
- Preserve provider capacity, request cancellation and existing subscription-first routing. Hold native response leases until body completion/cancellation.
- Forward native Anthropic Messages to Claude and compatible local endpoints. Explicitly unsupported local endpoints use the existing adapter through normalized translation.
- Translate text, schemas, tool calls/results, images, supported documents, stop reasons, errors and usage for OpenAI/Codex and other local endpoints. Reject unsupported required semantics; never fabricate signed thinking blocks. Normalize reused local tool-call IDs so later SDK actions are not mistaken for completed tools.
- Serve Messages and a scoped model catalog. Return unsupported for exact token counting where unavailable; context estimates are not exact counts.
- Disable unsupported optional SDK features; pin compatibility fixtures to the SDK/runtime pair before upgrades.

Non-Claude routing is Mercury-maintained compatibility, not Anthropic-supported Claude Code gateway use. Full provider parity, actual account routing/billing, context pressure/compaction and all supported attachments remain release gates. Controlled HTTP fixtures do not prove every real model supports SDK behavior.

References: [custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools), [gateway guidance](https://code.claude.com/docs/en/llm-gateway), [Ollama compatibility](https://docs.ollama.com/api/anthropic-compatibility), [LM Studio compatibility](https://lmstudio.ai/docs/developer/anthropic-compat).

## 2. Mercury permissions and Windows confinement

All child chats inherit the project's current mode/revision; no per-chat overrides initially. New projects default to level 2.

1. **Ask before commands:** workspace reads/ordinary edits are allowed. Every command and outside read/write requires review. Final integration requires review.
2. **Ask before risky actions:** OS-permitted device-wide reads and workspace edits are allowed. Only fixed host-validated inspection operations run automatically. Scripts, installations, destructive/unknown effects, outside writes, network access and additional capabilities require review. Final integration requires review.
3. **Full access:** Main can perform supported device-wide operations within OS user rights without Mercury prompts and integrate verified changes automatically. This does not grant administrator privileges. Workers remain confined to assigned write paths even in level 3.

Workspace scope includes managed worktrees and narrow scratch/cache storage, not arbitrary directories mentioned by a command. Resolve ownership from persisted chat records, never a model root or the selected sidebar folder.

The main-process policy broker serves filesystem tools, commands, plugin actions, workers and integration. Source, diagrams, repository instructions, tool output and agent claims cannot grant permissions. Classify effects/scope rather than command names; a test script can run arbitrary code.

Restricted operations declare read/write roots, private temporary storage and explicit capabilities to the pinned native MXC executor. Require `base-container`, reject DACL augmentation, audit/permissive operation, warning-bearing probes and unrestricted fallback. Unsupported hosts or requests stay blocked with an explanation.

Networking is denied by default. Some Node/.NET workloads require reviewed Win32 initialization (`win32k`); that capability is included in the exact request, with clipboard and injection disabled. Compatibility failures never silently grant it.

Restricted local plugin installation uses the same adapter, explicitly reviewed download access, disabled lifecycle scripts and private storage. Startup/calls create fresh confined processes; package code is read-only, writable workspace/state is explicit and network is denied. Remote plugin actions retain attributed operation approvals. Full-access Main and ordinary-chat plugin behavior preserve their respective policies.

Approvals bind actor, action, paths, command/CWD, policy revision, capabilities and relevant content state. One-time grants expire on denial, cancellation, restart, changed inputs or policy changes. Recheck immediately before execution. Downgrades stop affected workloads and descendants; completed effects remain recorded. Preserve bounded tool/check outcomes and responsible agents.

`npm run prepare:mxc` verifies the official release archive SHA-256, extracts pinned x64 executable/library assets and creates an integrity manifest. Include Microsoft's license. Probe real host support; OS version alone is insufficient. [Microsoft MXC](https://github.com/microsoft/mxc)

## 3. Coding workers and integration

Assignments persist objective, kind, context, owned paths, requested checks, model, status, findings, verification activity, SDK session and workspace. Capture model pool candidates when queued. Main owns decomposition, review, combined verification and the final response.

- Fork each coding/testing worker from Main's current state into separate managed storage. Preserve dirty baselines and exclude secrets, ignored content and caches.
- Enforce owned paths in file handlers and native process policies. Workers receive no plugins, recursive delegation or original-project integration tools.
- Read-only workers cannot run arbitrary commands or mutate maps. Non-Git projects keep parallel workers read-only and serialize Main writes.
- Review complete bounded worker diffs and actual command results. Reject out-of-scope files, oversized incomplete reviews, stale tokens, conflicts and source changes; preserve isolated work for correction.
- Accept exact reviewed revisions into Main's checkout, regenerate maps and run combined checks. Final integration into the original folder is separate.
- Serialize final integration; reject stale assumptions. Levels 1/2 require human approval of combined diff/checks; further changes invalidate approval. Level 3 integrates verified results automatically.
- Stop cancels queued/active assignments, commands and approvals. Restart preserves recoverable work without executing it. Cleanup only integrated, intentionally discarded or recoverably archived worktrees.

Coding instructions require behavioral unit tests for new executable modules/materially changed behavior; regression tests; relevant edges, failures, cancellation and concurrency; SOLID/separation of concerns; cohesive modules and typed/validated interfaces; useful dependency injection; clear errors and bounded resources; readable names and minimal dependencies; reproducible versions and deterministic checks; formatting/lint/type checks; preservation of unrelated changes; actual passed/failed/blocked/not-run outcomes. Require independent review for consequential permissions/concurrency/shared interfaces. Avoid meaningless tests for declarative files.

## 4. Generated dependency maps

One graph schema covers files, methods/symbols, imports, calls, source locations, confidence, unresolved references, fingerprints and analyzer versions. Use the TypeScript compiler for JS/TS and pinned Tree-sitter WASM grammars with language-specific resolution for Python, Java, C#, Go, Rust and C/C++. Inspect build/configuration relationships without executing imports, macros, scripts or plugins.

Store `.mercury/architecture/index.md`, model-maintained `system.mmd`, linked subsystem/file/method diagrams, graph JSON and an artifact manifest. Root diagrams describe abstract boundaries and external interactions; leaves show resolvable methods and source locations. Structural edges are deterministic; explanations remain model-maintained. Label confirmed/inferred/unresolved relationships; do not invent reflection, dynamic dispatch, overloads or missing build context.

Source fingerprints and generated-artifact hashes establish freshness. Cache unchanged parsing, rebuild affected relationships after edits/renames/deletions, and refresh after worker acceptance/final integration. Keep worker maps isolated; read-only workers use memory-only indexes. Stable IDs and bounded partitions handle large graphs. Report source/coverage limits.

Expose refresh/query through the SDK bridge. Consult relevant maps before edits and verify source. Validate Mermaid, hierarchy links, source locations and deterministic output. The read-only viewer blocks configuration directives/click actions, uses strict Mermaid settings, strips unsafe SVG and validates local map paths. Repository diagrams never grant authority.

## 5. Delivery and acceptance gates

Preserve a runnable app at each stage, in order:

1. **SDK/gateway:** real SDK text/multi-step tool sessions, exact-model routing, errors, cancellation and saved identity. Complete real provider/category, model switch, restart, attachments and context-pressure checks before declaring parity.
2. **Tools/confinement:** prove built-ins/plugins/workers cannot bypass the broker. Real outside reads/writes, shell/descendant/redirection, junction/link, registry/network, cancellation, downgrade and helper-failure tests. Include confined plugin startup and package immutability.
3. **Workers:** simultaneous implementation through exact review/acceptance/final integration; owned-path rejection, provider pools, attributed approvals, conflicts, stale reviews, interrupted recovery and non-Git behavior.
4. **Maps/desktop:** every selected language, cross-file methods, ambiguity/cycles/malformed source, incremental/deterministic output and partitioning; packaged WASM/SDK/MXC; strict map rendering; two-worker packaged workflow and ordinary-chat regressions.

Run `npm run typecheck`, full `npm test`, native tests with `MERCURY_LIVE_MXC=1`, `npm run package` and focused packaged Playwright tests. Run `npm run lint` and `npm run format:check` for the scoped Project quality gates without mass rewriting unrelated legacy files. Record actual outcomes and remaining limitations in README.

Live commercial provider/account parity and context-pressure checks cannot be inferred from controlled fixtures, SDK installation or a fake model. Broader host compatibility, arbitrary plugin package compatibility, relocation/removal controls and richer audit browsing remain separately tracked limitations. Planner/Plan mode is outside these milestones.
