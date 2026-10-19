# Local Plan Agent development plan

## Goal

Build a Windows desktop coding assistant that uses local models and gives planning a first-class review step. A user opens a project, describes a task, reviews a plan prepared by three agents, approves it, then watches one coding agent implement and verify the change.

The prototype uses Electron, React, TypeScript, SQLite, Ollama, and LM Studio. Models run through external local servers; the app does not download or host models. Agent requests run sequentially. A default model and optional planner, critic, synthesizer, and coder overrides are saved per app.

## Prototype behavior

1. **Workspace:** open a local folder, create sessions, browse prior sessions, and inspect conversation, plan, changes, and command results. Ordinary folders and dirty Git worktrees are supported.
2. **Planning:** planner, critic, and synthesizer take turns with read and search tools. They produce a structured plan with assumptions, steps, checks, and open questions. The user can edit the plan, ask for another planning cycle, and export Markdown.
3. **Approval:** implementation approval applies to an exact plan revision. Editing the plan invalidates that approval. Open questions must be resolved before execution.
4. **Implementation:** one coding agent edits text files using content hashes to detect concurrent changes. Shell commands show their exact text and working directory for approval. Repeated approval can be remembered for the same command in the active session.
5. **Recovery:** sessions, plan revisions, messages, changes, and command results are stored in SQLite outside the project. An unfinished run is marked interrupted at startup and requires explicit resume. Uncertain file writes and commands are never replayed automatically.

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
- A selected coder model must pass a tool-call check before implementation.
- File edits reject stale hashes, escaping paths, and direct `.git` paths while preserving existing user work.
- Denied commands do not run; approved commands show output and exit status; Stop cancels active generation or a command process tree.
- A session can be reopened after the app restarts, and interrupted work does not replay automatically.
- Connection loss, malformed model output, context limits, and unavailable models produce visible errors without switching to a cloud provider.

Run `npm run typecheck`, `npm test`, `npm run package`, and `npm run test:e2e` to verify the prototype. See [README.md](README.md) for setup and known limitations.

## Future backlog

The next feature set will be chosen after prototype use. Candidates include additional platforms, stronger command isolation, app updates, distribution and licensing, broader model compatibility checks, and richer planning controls.

Cloud models and subscription-backed tools remain separate opt-in integrations. ChatGPT plan use in a commercial app requires official partner access. Claude subscription use can be explored through an unmodified, user-authenticated Claude Code installation under Anthropic's published terms. Neither connection belongs to the local-only prototype.
