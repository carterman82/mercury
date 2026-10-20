# Local Plan Agent development plan

## Goal

Build a Windows desktop coding assistant that uses local models and gives planning a first-class review step. A user opens a project, describes a task, reviews a plan prepared by the Planner model, approves it, then watches the Main model implement and verify the change. Main can delegate bounded analysis to a read-only Subagent in both chats and project implementation.

The prototype uses Electron, React, TypeScript, SQLite, Ollama, and LM Studio. Models run through external local servers; the app does not download or host models. Agent requests run sequentially. Three app-wide model settings replace the former default and role overrides: Planner plans project infrastructure and changes; Main handles chats, everyday tasks, and approved implementation; Subagent breaks down data and handles small analysis tasks for Main. Unset Planner and Subagent settings use Main.

## Prototype behavior

1. **Workspace:** open a local folder, create sessions, browse prior sessions, and inspect conversation, plan, changes, and command results. Ordinary folders and dirty Git worktrees are supported.
2. **Planning:** Planner uses read and search tools to inspect the project and produce a structured plan with assumptions, steps, checks, and open questions. The user can edit the plan, ask for another planning cycle, and export Markdown.
3. **Approval:** implementation approval applies to an exact plan revision. Editing the plan invalidates that approval. Open questions must be resolved before execution.
4. **Implementation:** Main edits text files using content hashes to detect concurrent changes. Shell commands show their exact text and working directory for approval. Repeated approval can be remembered for the same command in the active session.
5. **Recovery:** sessions, plan revisions, messages, changes, and command results are stored in SQLite outside the project. An unfinished run is marked interrupted at startup and requires explicit resume. Uncertain file writes and commands are never replayed automatically.

## Model settings and delegation

- Model settings separates ChatGPT sign-in from API keys. Connect with Codex is an experimental app-server integration using an installed Codex binary and a separate Mercury-owned sign-in profile. Device boxes group local model servers by host; cloud accounts remain separate. Unavailable and empty saved servers are hidden while usable connections exist; only a completely empty catalog shows the no-models state. The saved catalog is restored immediately, with quiet background connection checks and an explicit Refresh action. Concurrency controls appear only for visible connected servers. Context limits remain attached to selected models.
- Main can call `delegate_task` with a task and explicit context in chats and approved project implementation. The configured Subagent runs in an isolated conversation, with at most eight model turns and a 20,000-character result. It may read project files or authorized conversation files, but cannot edit, create artifacts, run commands, invoke plugins, or delegate recursively.
- Delegation is sequential and shares parent cancellation. Findings and errors appear in activity/history and return to Main, which owns the final response and all changes. Provider failures never trigger an automatic switch to another provider.
- Existing defaults migrate to Main (or the old coder override if no default exists), explicit planner overrides migrate to Planner, and Subagent initially uses Main. Historical role labels remain readable; approved/interrupted sessions retain pinned model assignments.

## Build milestones

- [x] Desktop foundation: Electron shell, project selection, settings, persistent sessions.
- [x] Local model adapters: Ollama native chat and discovery, LM Studio chat completion and native discovery, streaming, cancellation, model selection.
- [x] Planning workflow: sequential roles, project inspection, editable plan, revision approval, Markdown export.
- [x] Coding workflow: validated tool calls, guarded file edits, command approval, change history, interruption recovery.
- [x] Automated checks: core tests and a packaged Windows desktop workflow using a simulated local model server.
- [ ] Smoke test with an actual Ollama model and record the server/model versions.
- [ ] Smoke test with an actual LM Studio model and record the server/model versions.

## Acceptance checks

- Plan changes cannot reuse an earlier approval; planning tools cannot edit files or run commands.
- The selected Main model must pass a tool-call check before implementation.
- File edits reject stale hashes, escaping paths, and direct `.git` paths while preserving existing user work.
- Denied commands do not run; approved commands show output and exit status; Stop cancels active generation or a command process tree.
- A session can be reopened after the app restarts, and interrupted work does not replay automatically.
- Connection loss, malformed model output, context limits, and unavailable models produce visible errors without switching to a cloud provider.

Run `npm run typecheck`, `npm test`, `npm run package`, and `npm run test:e2e` to verify the prototype. See [README.md](README.md) for setup and known limitations.

## Future backlog

The next feature set will be chosen after prototype use. Candidates include additional platforms, stronger command isolation, app updates, distribution and licensing, broader model compatibility checks, and richer planning controls.

Cloud models and subscription-backed tools remain separate opt-in integrations. ChatGPT sign-in and OpenAI/Claude API keys use separate account connections. Codex sign-in uses Codex-managed ChatGPT authentication through a Mercury-owned app-server profile and OS credential store; it stays distinct from direct delegated ChatGPT authorization and API keys. Its experimental structured-response bridge returns tool requests to Mercury for normal validation and approvals.
