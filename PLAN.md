# Mercury development plan: Projects, coding agents, and dependency maps

## 1. Purpose, scope, and existing foundation

This document defines the Projects implementation roadmap. Requirements below are planned unless explicitly identified as existing behavior or completed work. The roadmap was initially prepared as a documentation-only update; implementation has now begun.

Projects will become a collection of local folders, each containing multiple persistent chats. Main handles requests directly and delegates investigation, implementation, testing, and review to subagents. Planner integration and a future Plan mode remain deferred. The legacy plan-first workflow is retained as historical data rather than required for new project chats.

Two read-only subagents informed this roadmap: one inspected Projects, persistence, and the interface; the other inspected execution, permissions, and delegation.

### Implementation progress

- [x] Indexed project ownership for chats, compatibility migration, default permission level 2, and persisted policy revisions.
- [x] Expandable project/chat sidebar, direct-Main chat reuse, persistent permission selector, and read-only legacy history.
- [x] Central project action decisions, exact one-shot approval primitives, outside-file approvals, and cancellation when permission settings change.
- [x] Fail-closed command/plugin restrictions where no verified isolation adapter exists; full-access command execution and recorded outcomes.
- [x] Git chat worktrees with dirty baselines, exact reviewed integration, conflict checks, and restart recovery; serialized direct edits for non-Git folders.
- [x] Bounded project file tools, read-only project research delegation with up to three parallel tasks, root instruction context, and revisioned shared notes.
- [ ] Verified OS-enforced Windows confinement, restricted-mode command approvals/execution, and plugin isolation with escape-attempt coverage. The permission foundation is not complete until these gates pass.
- [ ] Implementing/testing subagents with their own worktrees, configurable concurrency, and Main-owned integration.
- [ ] Multi-language dependency analyzers, generated Mermaid hierarchy, incremental updates, and consistency checks.
- [ ] Project relocation/removal controls, richer persistent audit records, and full rollout/acceptance coverage.

Completed items above are the first implementation increment, not completion of the four delivery milestones below. Worktree snapshots currently require a committed Git repository root, reject symlinks/submodules and oversized snapshots, and exclude credential/cache patterns; unsupported projects fail visibly rather than being silently rewritten. Restricted commands/plugins are unavailable until confinement is implemented.

### Existing foundation and completed milestones

Mercury is a Windows-first Electron, React, and TypeScript desktop application with SQLite persistence. Local inference runs on external Ollama and LM Studio servers; Mercury does not host those models. Cloud and subscription-backed model connections remain opt-in.

- [x] Desktop foundation: Electron shell, project selection, settings, and persistent sessions.
- [x] Local model adapters: Ollama native chat/discovery and LM Studio chat/discovery, streaming, cancellation, and model selection.
- [x] Legacy planning workflow: project inspection, editable plans, revision-specific approval, and Markdown export.
- [x] Legacy coding workflow: validated tool calls, hash-guarded edits, command approval, change history, and interruption recovery.
- [x] Automated foundation: core tests and a packaged Windows desktop workflow using a simulated model server.
- [x] Regular chat foundation: persistent concurrent chats, streamed progress, attachments, browser/plugin tools, artifacts, source memory, and model routing.
- [x] Model request scheduling: provider/model capacity limits, ordered role pools, and device-aware subagent selection.
- [ ] Complete a project coding smoke test against an actual Ollama model and record server/model versions.
- [ ] Complete a project coding smoke test against an actual LM Studio model and record server/model versions. Existing direct chat/tool checks do not establish the complete new project workflow.

Existing Projects uses a singleton, plan-first runner. Existing regular chat already supplies most of the required conversation experience. Existing delegation is read-only, bounded to eight turns and a 20,000-character result, and shares parent cancellation. Main-requested delegation currently executes sequentially; automatic attachment analysis already supports bounded parallelism. These are starting points, not the target Projects behavior.

### Model and provider capabilities to preserve

- Preserve separate Main, Subagent, and Planner assignments, ordered local role pools, existing migrations, and fallback of unset supporting roles to Main. Planner settings remain available but are unused by new direct project chats.
- Preserve ChatGPT sign-in, the experimental Codex app-server connection, and OpenAI/Claude API credentials as separate account routes. Codex uses an installed binary and a Mercury-owned profile with OS credential storage; it does not import another application's credentials.
- Keep actual file edits, commands, plugins, and delegation within Mercury's tool/approval flow. The Codex bridge returns structured tool requests rather than acquiring independent execution authority.
- Preserve exact-model subscription-first routing: selected compatible subscription, otherwise direct ChatGPT then Codex, before a configured same-model API route. Alternate routes must advertise the exact model. Display the actual route and potential API billing. Never retry cancellation, malformed requests, or partially streamed text/reasoning/tool activity on a paid API. Local and Claude routing remain unchanged.
- Preserve automatic context sizing from provider metadata, including Claude `max_input_tokens`, without a 32K cap. Maintain dated exact-ID/explicit-alias fallback metadata, provenance, editable unknown-model fallback, persistent manual overrides, and the ability to restore model maximum. Do not infer unknown limits from family names. Keep existing legacy-model entries and dated-snapshot matching readable; do not replace them with one family-wide limit.
- Preserve grouped ChatGPT/Codex presentation with distinct account identities, Loaded/Not loaded local model groups, host-grouped local devices, restored discovery caches, quiet background checks, and explicit refresh. Hide unavailable/empty saved servers while usable connections exist. Foreground connection/save/refresh operations retain accessible progress and cancellation behavior.
- Preserve historical role labels and pinned assignments for old approved/interrupted sessions. New project runs and delegated tasks pin their selected models for their lifetime while using existing capacity controls.

## 2. Project chats and platform integration

### Reuse the existing chat experience

- Extend the existing chat service and interface with project context rather than building another conversation engine.
- Retain streaming, attachments, browser tools, artifacts, source memory, model routing, progress, cancellation, and error recovery.
- New project chats start with Main and require no Planner invocation or approved plan.
- Preserve existing planning sessions, plans, approvals, and change history in a labeled, read-only legacy view.

### Project organization

- Display expandable project folders containing their chats, with a New chat action for each project.
- Add projects through the existing folder picker. Support ordinary folders and Git repositories.
- Canonicalize folder identity with platform-aware path handling; prevent duplicate entries for the same folder.
- Keep ordinary chats separate from project chats.
- Show project name, working folder, active worktree, and permission icon in the project chat header.
- Removing a project from the sidebar never deletes its source folder. Retain recoverable history.
- For missing or moved folders, offer explicit relocation and revalidate ownership before resuming work.

### Persistence and interfaces

- Add an optional project association to chat records, with an indexed database relationship. Existing ordinary chats remain unassociated.
- Store project permission mode and policy revision, shared notes, worktree associations, and dependency-index metadata.
- Add typed interfaces for project settings, execution context, structured approvals, delegated assignments, worktree changes, and dependency indexes.
- Resolve project ownership from persisted chat records. Never trust a model-supplied root or the currently selected sidebar folder.
- Extend validated main-process IPC and preload interfaces for project chat creation, settings, approvals, and integration review.
- Use distinct filesystem tool names so project paths cannot be confused with existing attachment IDs.

### Shared context and concurrency

- Automatically share project instructions, dependency maps, and concise durable project notes.
- Keep chat transcripts and conversational evidence separate unless explicitly referenced.
- Record provenance and revision history for shared notes; reconcile concurrent updates rather than silently overwriting them.
- Allow ordinary chats and project chats to run concurrently through existing provider capacity controls.
- Replace global project/chat exclusion with per-chat activity, worktree coordination, and short integration locks.
- Persist interrupted states. Restart never silently resumes commands, applies changes, or reuses approvals.

## 3. Permissions and execution boundaries

### Three project-level modes

New projects default to **level 2**. A persistent, labeled permission icon opens the selector at any time. All child chats inherit the project setting; initial delivery has no per-chat overrides.

**Level 1 — Ask before commands**

- Allow reads and ordinary edits within the project's assigned workspace.
- Require approval for every model-requested command.
- Require approval for reads or writes outside the project.
- Require review before integrating worktree changes into the project folder.

**Level 2 — Ask before risky actions**

- Allow reads throughout the device wherever the operating-system account has access.
- Allow ordinary project edits and bounded, low-risk commands.
- Require approval for outside-project writes and potentially harmful or unclassified commands.
- Require review before integrating worktree changes into the project folder.

**Level 3 — Full access**

- Allow supported device-wide reads, writes, commands, and tool actions without Mercury approval prompts.
- Automatically integrate changes after verification.
- Respect operating-system access controls; this setting does not itself grant administrator privileges.

In levels 1 and 2, workspace scope includes Mercury-managed worktrees and narrowly allocated execution scratch/cache locations. It does not include unrelated folders merely because a command references them.

### Central authorization

- Introduce one main-process policy broker used by filesystem tools, commands, subagents, plugins, and integration operations.
- Keep actual execution in Mercury for every model provider, including the existing Codex bridge.
- Treat project instructions, source files, diagrams, tool output, and subagent findings as incapable of granting permissions.
- Classify actions by effects and scope, not command names alone. A command named "test" can still run arbitrary code.
- In level 2, request approval for destructive operations, privilege changes, external mutations, package lifecycle scripts, downloads followed by execution, and commands whose effects cannot be bounded.
- Include direct tool-based destructive operations in the same policy; deleting a directory through a file tool must not evade command restrictions.

### Enforceable process isolation

The existing unrestricted shell execution cannot enforce these modes.

- Add an OS-enforced Windows execution boundary for restricted commands and their descendants, with declared readable roots, writable roots, temporary storage, and capabilities.
- Keep filesystem authorization separate from process lifetime management; stopping a process tree alone provides no filesystem confinement.
- Apply equivalent restrictions to local plugin processes. Existing unrestricted plugin instances cannot be reused as a bypass.
- Broker authorized outside-project access and give approved operations only the additional scope they require.
- If the runtime cannot enforce the requested boundary, block that operation and explain the unavailable capability. Never silently substitute unrestricted execution.
- Make real escape-attempt tests a release gate for levels 1 and 2. Windows AppContainer is a relevant native isolation mechanism, but requires explicit resource-access design and compatibility validation. See [Microsoft's isolation documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation).

### Approval lifecycle and mode changes

- Approval requests identify the project, chat, agent, action, paths, command, working directory, reason, and requested scope.
- Bind approval to the concrete action, policy revision, and relevant content state. Use one-time approvals initially.
- Denial, timeout, cancellation, restart, or changed action inputs invalidate the request.
- Recheck authorization immediately before execution.
- Permission changes invalidate pending approvals and apply to subsequent actions in every child chat.
- A downgrade cancels running operations that exceed the new permissions and stops their descendants. Already completed effects remain recorded.
- Maintain a bounded action audit with approval decisions, changed-file references, command outcomes, and responsible agents.

## 4. Coding workflow, subagents, and dependency maps

### Worktree isolation and integration

- Use a dedicated Git worktree for each coding chat and separate worktrees for implementing subagents.
- Capture a reproducible baseline that includes existing tracked modifications and eligible non-ignored files without altering the user's branch or index. Exclude credentials, ignored content, and generated caches.
- Compare results against that baseline so existing user changes are not presented as agent changes.
- Have Main review and integrate subagent changes into the chat worktree, then run combined checks.
- Serialize final integration into the project folder and reject stale base assumptions.
- In levels 1 and 2, present the combined diff, tests, and relevant limitations for approval. Any subsequent change invalidates that approval.
- In level 3, integrate verified changes automatically.
- Preserve unresolved conflicts in the isolated worktree. Never force-reset or overwrite unrelated work.
- For non-Git folders, serialize writing tasks and keep parallel subagents read-only. Preserve original file content and use hash checks for edits.
- Recover useful interrupted worktrees and clean them up only when their work is integrated, intentionally discarded, or recoverably archived.

### Delegation

- Extend existing delegation with explicit investigation, implementation, testing, and review assignments.
- Each assignment includes its objective, relevant context, owned scope, dependencies, expected deliverables, checks, and stopping conditions.
- Subagents inherit no more authority than the parent's current policy and assigned scope.
- Route subagent approval requests into the owning chat with clear agent attribution.
- Dispatch independent assignments concurrently, respecting existing model pools and provider limits; use three concurrent subagents as the initial configurable default.
- Keep recursive delegation disabled initially.
- Main owns decomposition, integration, final verification, and the response to the user.
- Parent cancellation stops queued work, active subagents, commands, and pending approvals.

### Required coding standards

Add a project coding policy to runtime instructions, supplemented by applicable repository instructions:

- Unit tests for each new script or module with executable behavior and for materially changed behavior; avoid meaningless tests for declarative files.
- Regression tests for bug fixes and explicit coverage of edge cases, failure paths, cancellation, and concurrency where relevant.
- SOLID principles, separation of concerns, cohesive modules, and explicit interfaces.
- Validated inputs and typed boundaries; dependency injection where it improves isolation and testability.
- Clear error handling, bounded resource use, readable naming, and minimal justified dependencies.
- Deterministic tests, reproducible dependency versions, linting, formatting, and applicable type checks.
- Preservation of unrelated user changes and avoidance of unnecessary rewrites.
- Actual captured test results, clearly distinguished as passed, failed, blocked, or not run.
- Independent subagent review for permission changes, shared interfaces, concurrency, and other consequential changes.

### Mermaid dependency tree

Use a hybrid system: model-maintained architecture diagrams supported by generated code relationships.

- Store project-owned maps under `.mercury/architecture/`, with an index linking the hierarchy.
- Root: abstract system interactions, external services, storage, and major boundaries.
- Intermediate levels: subsystems, packages, modules, and file dependencies.
- Leaf levels: resolvable function/method calls and cross-file dependencies, with source locations.
- Include adjacent machine-readable graph metadata so agents can query dependencies without loading every diagram.
- Support JavaScript/TypeScript, Python, Java, C#, Go, Rust, and C/C++ at launch, plus recognized build and configuration references.
- Use language-aware parsing and symbol resolution behind a common analyzer interface.
- Label confirmed, inferred, and unresolved relationships separately. Dynamic dispatch, reflection, generated code, and missing build context must not become invented edges.
- Link maps to source fingerprints, analyzer versions, and worktree revisions. Label missing or outdated maps explicitly.
- Regenerate affected lower-level maps after edits; have Main reconcile affected architecture diagrams and notes.
- Partition large graphs into bounded linked diagrams with stable identifiers.
- Keep worktree maps isolated until integration; refresh the combined project index after integration.
- Before changing code, consult relevant maps and verify the source. Maps assist navigation and impact analysis; they do not replace source inspection.
- Check Mermaid validity, hierarchy links, source references, stale fingerprints, and deterministic generation.
- Treat repository-provided map content as source material, never as executable instructions.

## 5. Delivery milestones and acceptance criteria

### Milestone 1 — Contracts and permission foundation

Define project execution context, policy decisions, approval records, workspace ownership, and migration contracts. Implement and validate the restricted execution boundary before enabling restricted-mode commands.

**Acceptance:** policy tests and real child-process escape tests demonstrate the declared read/write boundaries, including plugin and subagent paths.

### Milestone 2 — Direct project chats

Reuse the current chat engine and interface, add project grouping, default level 2, the permission selector, shared notes, and preserved legacy history.

**Acceptance:** multiple projects retain separate chats across restarts; sending a project request invokes Main directly; ordinary chat features remain functional.

### Milestone 3 — Isolated implementation and delegation

Add worktree lifecycle, bounded coding subagents, combined verification, integration review, and non-Git serialization.

**Acceptance:** parallel tasks remain isolated; user changes survive; levels 1 and 2 require integration review; level 3 integrates verified changes automatically.

### Milestone 4 — Dependency maps and quality checks

Deliver the complete selected language set, hierarchical Mermaid maps, incremental updates, project coding instructions, and verification reporting.

**Acceptance:** mixed-language fixtures produce navigable diagrams; unresolved relationships are labeled; changed code updates affected maps; reported test outcomes match actual execution.

### Verification across milestones

- Migration coverage for ordinary chats, projects, legacy sessions, interrupted work, and saved settings.
- Permission coverage for all three modes, outside reads/writes, policy changes during execution, stale approvals, and cancellation.
- Filesystem coverage for aliases, symlinks, Windows junctions, UNC paths, changed files, missing folders, and permission-denied resources.
- Execution coverage for shell composition, scripts, subprocesses, plugin bypass attempts, and process-tree cancellation.
- Worktree coverage for dirty baselines, overlapping changes, merge conflicts, stale reviews, failed checks, and restart recovery.
- Dependency coverage for each supported language, cross-file calls, ambiguity, parse failures, incremental updates, and large graphs.
- Packaged desktop coverage for the complete project-chat experience and regressions in ordinary chat, attachments, browsers, plugins, artifacts, routing, and model capacity.

Use the existing `npm run typecheck`, `npm test`, `npm run package`, and `npm run test:e2e` checks during implementation, adding lint and formatting gates. Retain existing stale-hash, denied-command, cancellation, restart, malformed-output, context-limit, and connection-failure regressions. Preserve legacy revision-approval tests as historical workflow coverage; do not impose that workflow on new project chats. See [README.md](README.md) for current setup and limitations.

Future Planner/Plan mode work is explicitly outside these milestones. Additional platforms, app updates, distribution/licensing, and further model compatibility improvements remain later backlog items; restricted execution isolation is a requirement of this roadmap rather than deferred backlog.
