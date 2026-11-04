# Mercury reuse roadmap

Recorded November 4, 2026. This document preserves the codebase review and tracks implementation. Status labels distinguish delivered increments from future work.

Mercury already uses Claude Agent SDK, MCP SDK, Playwright, Tree-sitter, SQLite, React, Zod, Vitest and Electron. Preserve its revision-checked writes, approval policy, acceptance evidence, cancellation, local-model scheduling, and billing-sensitive routing.

## 1. Repository search — initial implementation delivered

Replace partial gitignore matching and the first-300-files search in `src/main/workspace.ts` with bundled [ripgrep](https://github.com/BurntSushi/ripgrep). Preserve allowed roots, symlink restrictions, cancellation, bounded output and visible truncation. Verify nested ignores, negation rules, deep directories and matches beyond 300 files. Package target-native binaries.

## 2. Portable Agent Skills — initial implementation delivered

Implement the public [Agent Skills format](https://agentskills.io/specification): discover name/description first and load selected SKILL.md instructions/resources on demand. Start with project-local skill directories and host-controlled tools. Do not implicitly enable third-party hooks or grant permissions from skill metadata.

Curated sources: [Superpowers](https://github.com/obra/superpowers) for systematic debugging, test-driven development and verification; [Anthropic skills](https://github.com/anthropics/skills) for development/design/document examples. Check each skill's runtime requirements and license; Anthropic document skills are source-available rather than open source. Test workflows with Mercury before bundling them.

Included default: `.agents/skills/programmer/SKILL.md`. Project Main and workers receive a bounded metadata catalog and can use `list_project_skills` and `read_project_skill` to load instructions and relative reference files. Skills are selected by the model; scripts never run automatically.

## 3. MCP configuration and authentication — initial header-credential increment delivered

The existing MCP host rejects required headers, environment variables and launch arguments, and reconnects for each operation. Add native configuration, protected credentials, configurable launch plans and managed sessions using supported [MCP authorization](https://modelcontextprotocol.io/docs/tutorials/security/authorization).

Initial scope: explicitly configured remote headers through a native host interface, encrypted credential storage, and the existing installation/tool approval policy. Remaining work: OAuth, stdio argument/environment configuration and persistent session lifecycle.

First integrations to evaluate: [Context7](https://github.com/upstash/context7) for current library docs; [GitHub MCP](https://github.com/github/github-mcp-server) for repository/issues/PRs (start read-only); [Serena](https://github.com/oraios/serena) for symbol/reference navigation (start retrieval-only; validate language-server dependencies). Existing Playwright already supplies browsing, so Playwright MCP is an interoperability option.

## 4. Maintained provider adapters — initial Claude SDK increment delivered

Reduce handwritten request/SSE parsing behind the existing ModelProvider interface. [AI SDK Core](https://ai-sdk.dev/docs/introduction) and its [OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers) are candidates for broader consolidation. Official provider SDKs are a narrower migration option.

Initial scope: use the already compatible [official Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) for Claude streaming transport. Keep Mercury's event handling, watchdog, tool execution and routing. Disable automatic SDK retries to avoid duplicate work. Remaining work: evaluate AI SDK across API-key and local providers; subscription authentication and the Claude project gateway require separate handling.

## 5. Native coding-agent runtime adapters — proposed

The Codex bridge currently creates ephemeral threads and requests JSON descriptions of Mercury calls. Pilot one native runtime behind ProjectAgentRuntime: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [OpenCode server](https://opencode.ai/docs/server/) with its [SDK](https://opencode.ai/docs/sdk/), or modular [Pi](https://github.com/earendil-works/pi). Pi does not supply a built-in permission boundary. Codex dynamic tools and [AI SDK harness adapters](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview) are experimental. Evaluate [ACP](https://agentclientprotocol.com/get-started/introduction) for interoperable editor-to-agent communication; MCP covers tools/context. Compare one pilot before selecting a replacement.

## 6. Project change review — proposed

Add a lazy-loaded [Monaco](https://github.com/microsoft/monaco-editor) diff panel with changed-file selection and read-only before/after views. Current legacy comparison uses plain text blocks; current project chat lacks an equivalent source review surface. Define revision and checkpoint behavior before introducing editing or hunk acceptance. CodeMirror merge is an alternative if bundle cost dominates.

## 7. Evidence search, storage and long conversations — proposed

Normalize message/evidence/run-event records instead of repeatedly replacing whole-chat JSON. Use existing SQLite with [FTS5](https://www.sqlite.org/fts5.html) for ranked evidence retrieval before introducing vector services. Preserve immutable evidence IDs, timestamps, provenance and freshness limits. Add [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction) for dynamic-height histories; separately reduce IPC payloads to summaries/selected-chat data/deltas. Benchmark long histories and concurrent streams: these are inferred scalability risks, not measured regressions.

## 8. Task evaluations and instrumentation — proposed

Keep existing unit, packaged Electron and opt-in live tests. Add repeatable isolated coding tasks via [Promptfoo custom providers](https://www.promptfoo.dev/docs/providers/custom-api/) and [OpenTelemetry](https://opentelemetry.io/docs/languages/js/). Measure test-backed completion, unwanted edits/tool activity, repeated reads, cancellation, recovery, elapsed time and token usage. Prefer deterministic assertions; keep private source/prompts out of exported telemetry by default.

## Additional interface and maintenance recommendations

- [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview): simplify model catalog and file-preview loading/cache lifecycles over the desktop API. Keep streaming state event-driven.
- [Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog): focus trapping/restoration, Escape behavior and dialog semantics while keeping Mercury's design.
- Shared Zod IPC contracts: define method inputs/outputs once using the installed dependency; retain sender/frame checks and constrained preload access.
- React Testing Library/user-event and axe checks: complement existing Electron tests with focus, keyboard, asynchronous switching and approval-target tests.
- Consider a streaming Markdown renderer only after reproducing defects; retain current sanitization, safe links, image restrictions, math and code rendering.
- Add platform-specific execution backends behind the existing execution contract for cross-platform confinement. Validate actual filesystem/network semantics; containers are not automatically equivalent to Windows MXC.
- Avoid a wholesale IDE/UI rewrite, extra graph frameworks, terminal libraries without an interactive-terminal requirement, and multiple competing agent frameworks.

## Implementation order and verification

Start with 1–4, using separately testable increments. Next add change review and task benchmarks, then choose one provider/runtime pilot based on measured outcomes. Run type checking and relevant regression tests after integration; package and smoke-test any changed binary/runtime distribution before release. No integration is considered validated merely because its upstream documentation describes it.

### Verification of the initial implementation

- TypeScript and repository lint passed.
- Combined targeted provider/routing, skills/context, MCP, actual-ripgrep and core suites: 74 passed, one opt-in native test skipped.
- Full parallel regression run: 880 passed, seven failed, 11 skipped. Two failures identified outdated Claude fixtures without named SSE events; five were timeouts under concurrent load. Corrected the protocol fixtures, then reran all seven affected suites serially: 100 passed, two skipped. This is not a claim that a subsequent single full run was green.
- Search and command-state regressions additionally verify the internal 100001-file enumeration limit and inclusion of large binary assets in snapshots.
- Desktop packaging was started, then stopped when a pre-existing build targeting the same output directories was discovered. Packaged-app smoke verification and native macOS/Linux builds remain outstanding before release.

### Using the delivered features

- Project searches use the pinned platform-native ripgrep package. Release packaging includes a separate search runtime.
- Add project workflows under `.agents/skills/<name>/SKILL.md` or `.mercury/skills/<name>/SKILL.md`. The supplied `programmer` skill is available immediately in this repository; metadata is advertised automatically and full instructions load when selected.
- Discover a credential-requiring remote plugin in chat, open Settings → MCP connection setup, enter its required headers (for Authorization include the required scheme, such as `Bearer `), then return to chat for installation approval. OAuth-only and configurable stdio servers are not yet supported.
- Claude API calls now use official SDK streaming transport with retries disabled. OpenAI/subscription/local routes retain their existing adapters for the next migration increment.
