# Mercury

A Windows-first desktop assistant with an orange-and-black interface for chatting with local models and planning software changes. **Chat** lets you select an individual model, stream replies, switch models, stop generation, and reopen saved conversations. **Projects** uses a planner, critic, and synthesizer before asking you to approve a plan. One coder then edits files; every shell command requires approval.

## Requirements

- Windows 10 or newer, Node.js 24+, and npm.
- Ollama or LM Studio running locally or on a reachable private network, with a downloaded model. A model that supports tool calls is required for coding.

## Run

```powershell
npm install --offline=false
npm start
```

Mercury opens in **Chat**. Choose a model at the bottom of the message box and send a message; no project is needed. The refresh icon next to the picker requests a fresh model scan. Enter sends a message, and Shift + Enter adds a line. Use **New chat** to start fresh, or select a saved conversation in the sidebar. Chat has no project tools or command access. Only one chat response or agent run can be active at once.

Responses render Markdown: headings, bold, italics, underline (`<u>text</u>`), strikethrough, quotes, nested lists, checklists, tables, links, highlighted code with a Copy button, and math using `$...$` or `$$...$$`. Model HTML is sanitized; external images are not loaded. Web links open in the system browser only when clicked.

While a response is in progress, Mercury shows a compact **Thinking ⌄** row and elapsed time. Click the row to expand the live reasoning; it starts collapsed and stays as you leave it while the answer arrives. Models can return reasoning through Ollama's `thinking`, LM Studio's `reasoning_content`, or a leading `<think>` block. Mercury does not fabricate reasoning for models that do not provide it. Reasoning is saved with the response and excluded from later conversation prompts. Stop works during both thinking and answering.

Open **Model settings** to configure the default project model. The app scans running Ollama and LM Studio servers on this computer, saved connections, and reachable Tailscale, WireGuard, and ZeroTier peers on their standard ports (`11434` and `1234`). Role overrides and context settings are under **Agent models and context**. Choose **Other…** in a model dropdown to add a custom address or port, including servers the scan misses. An optional API token can be entered there and is stored using Windows protected storage. The shared LM Studio server at `http://100.80.53.57:1234` is included in this prototype's saved connection defaults.

Model discovery is shared between Chat and Settings and cached in SQLite across restarts. Successful lists are reused for 30 minutes; an empty result is retried after one minute. Refresh bypasses the cache. Changing connection details or credentials, or encountering a connection/model-availability error, invalidates it. Changing the default model or agent assignments does not trigger a rescan. Concurrent discovery requests share one scan.

For coding, select **Projects**, open a folder, describe a task, review the generated plan, and use **Approve and implement** when it is ready. File edits appear in **Changes**. Commands require approval showing the exact text and working directory.

## Build and checks

```powershell
npm run typecheck
npm test
npm run package
npm run make
```

For rapid testing of the latest source, use `npm start`; no installer is needed. `npm run package` creates `out/Mercury-win32-x64/Mercury.exe`, which can also be launched directly. `npm run make` creates an optional Windows installer. To build this update separately while an older copy is open, set `$env:LOCAL_PLAN_AGENT_BUILD_ID='mercury-refined'` in PowerShell, then run `npm run package`. The output will be `out/mercury-refined/Mercury-win32-x64/Mercury.exe`.

## Data and limitations

Chats, project sessions, and settings are stored in `state.sqlite`, outside the selected project. Mercury continues using `%APPDATA%/Local Plan Agent/` to preserve data and protected tokens from earlier builds. The app uses only the selected model server and makes no cloud fallback requests. It does not download models or start a model server. Tailscale peer discovery requires its command-line client; WireGuard host routes and Windows VPN neighbor entries are checked when available. VPNs that do not expose peer addresses require **Other…**.

Command approval controls whether this app launches a command; it is not an operating-system sandbox. Planning agents have only read/search tools. Coding edits require a file hash so changes made in another editor are not silently overwritten. The prototype handles UTF-8 text files up to 512 KB. Large or binary files need manual handling. After an interruption, resuming requires an explicit click and does not automatically replay an uncertain tool result.

The model/server combination matters: a tool-use check runs before implementation. Some models may produce a useful plan but lack reliable tool calling for coding. Live model compatibility and hardware performance must be checked on the target machine.

## Validation status

For the composer model picker, collapsed thinking, and discovery-cache update, TypeScript passes. Four new cache tests and updated desktop scenarios have been added. The current tests and packaging have not run: automatic approval review was at capacity. Run `npm test`, package using `LOCAL_PLAN_AGENT_BUILD_ID=mercury-refined`, then run `npx playwright test` with that same environment variable. Optionally set `LIVE_TAILSCALE_MODEL=1` for the shared-server check.

For the preceding rich-text update, all 19 core tests and the Windows package build passed; desktop tests were left unrun at the user's request. That build remains in `out/mercury-rich/Mercury-win32-x64/`.

The preceding Mercury release passed all four packaged desktop tests. The shared LM Studio API at `100.80.53.57:1234` completed both a streamed tool-call check and a regular chat with `qwen3.8-27b-mlx@4bit` on October 18, 2026. A full plan-to-code run against that shared model has not been performed.
