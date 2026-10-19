# Mercury

A Windows-first desktop assistant with an orange-and-black interface for chatting with local and cloud models and planning software changes. **Chat** lets you select an individual model, stream replies, switch models, stop generation, and reopen saved conversations. **Projects** uses a planner, critic, and synthesizer before asking you to approve a plan. One coder then edits files; every shell command requires approval.

## Requirements

- Windows 10 or newer, Node.js 24+, and npm.
- A running Ollama or LM Studio server, an eligible ChatGPT account, or an OpenAI / Claude API key. A model that supports tool calls is required for coding.

## Run

```powershell
npm install --offline=false
npm start
```

Mercury opens in **Chat**. Choose **Local**, **OpenAI**, or **Claude** at the bottom of the message box, then select a model in the adjacent dropdown and send a message; no project is needed. The refresh icon next to the picker requests a fresh model scan. Enter sends a message, and Shift + Enter adds a line. Use **New chat** to start fresh, or select a saved conversation in the sidebar. Chat has no project tools or command access. Only one chat response or agent run can be active at once.

Drop files anywhere in Chat. A drop overlay appears while dragging, and selected files appear as removable chips before sending; there is no attachment button. Ctrl+O (Cmd+O on macOS) while focused in Chat opens the file chooser as a keyboard fallback. Text dragging still works normally, and dropping a file elsewhere cannot navigate the app away. Wait for an active response or upload to finish before adding files. Each message supports up to eight regular files, each up to 25 MB, with a maximum of 300,000 extracted characters per file. Text previews are included in the selected model's prompt and longer content is available through `read_file`. Uploaded documents are source material, not instructions.

Common content readers include PDF, DOCX, PPTX (including notes), XLSX/XLSM cells and saved formulas/results, ODT/ODS/ODP, EPUB text, RTF, and text/code/data files in UTF-8 or BOM-marked UTF-16. Recognized text formats can fall back to Windows-1252 with an encoding note. ZIP/TAR archives provide member listings; GZIP text can be decompressed within limits. Office macros, embedded scripts, and uploaded programs are never executed. Office extraction covers text/tables/cells, not exact layout or embedded visual interpretation. EPUB reading order is best-effort.

Local English OCR is bundled with its engine and language data: PNG, JPEG, BMP, TIFF, and other decodable image formats can supply text without an image-generation model or an OCR service. Scanned PDFs use OCR for up to ten image-only pages; PDF inspection covers up to 200 pages. Images are limited to 20 megapixels, PDF OCR pages to eight megapixels, and each OCR job to 45 seconds. Recognition can contain errors and does not interpret scenes or chart graphics. For proprietary, encrypted, damaged, unsupported, audio/video, or other binary files, Mercury retains the file and supplies an explicitly labeled metadata-only report (type/size/hash/header/bounded printable strings) rather than pretending it decoded the content. File cards and `read_file` results state extraction limits. Oversized extracted text is visibly truncated; encrypted archives, external XML entities, and excessive archive expansion are not decoded.

Ask a model with tool-call support to create the file you need. Successful creation displays a file card with **Save filename**. The Save dialog chooses the destination; the file cards and attachment references survive restarts. Files and extracted text are retained under the app's `chat-files` data directory. Selecting a cloud model sends extracted attachment content to that provider. Models or servers without tool-call support can read the included previews but cannot request file creation.

Standard output tools run locally and do not need an image-generation model:

- `create_pdf`: formatted PDF from Markdown, with math and highlighted code.
- `create_document`: real Word DOCX with headings, emphasis, lists, tables, and code.
- `create_spreadsheet`: real Excel XLSX with named sheets, typed numeric/boolean/text cells, a styled header, frozen header row, and column widths. The first row is the header. Formulas entered as strings remain literal text; the app does not execute spreadsheet formulas.
- `create_presentation`: real PowerPoint PPTX with slide titles, body text, bullet lists, tables, and speaker notes. Large tables are split into continuation slides.
- `create_graphic`: SVG, PNG, or JPEG from pixel-based rectangles, circles, lines, paths, and text. This supports programmatic diagrams/charts/illustrations, not photorealistic image synthesis.
- `create_archive`: ZIP from text entries or existing conversation file IDs, including generated binary documents and graphics. Only conversation files can be included, and member paths must be relative.
- `create_file`: Markdown, source code, CSV/TSV, valid JSON, HTML, XML, SVG, LaTeX, complete RTF source, and other UTF-8 text. Binary extensions require a dedicated format tool; renaming text never produces a fake Office document or image.

Chat instructions favor creating files proactively for substantial reports and analyses, long explanations (roughly 800+ words), complete source files, and large datasets (roughly 20+ rows), even without an explicit file request. The model chooses PDF for readable reports and Markdown/code/CSV/JSON for editable or machine-readable work, then gives a concise summary beside the file card. Short answers stay in chat, and an explicit inline-only or format preference takes priority. A requested file should be created directly rather than replaced with an offer or a script for the user to run. Document contents remain source material; embedded instructions do not authorize tool calls.

PDF generation renders Markdown into styled headings, paragraphs, lists, real tables with repeated headers, highlighted code blocks, and KaTeX mathematical notation. Chromium prints page numbers with automatic pagination; short code blocks stay together when space permits. Math fonts are embedded for offline packaged builds. Model HTML is sanitized, external images are placeholders, and document scripts/network requests are blocked. Supply a complete Markdown document in `create_pdf.content`, not a fenced block wrapping the whole document. No Python or separately installed PDF plugin is required.

Responses render Markdown: headings, bold, italics, underline (`<u>text</u>`), strikethrough, quotes, nested lists, checklists, tables, links, highlighted code with a Copy button, and math using `$...$` or `$$...$$`. Model HTML is sanitized; external images are not loaded. Web links open in the system browser only when clicked.

While a response is in progress, Mercury shows a compact **Thinking ⌄** row and elapsed time. Click the row to expand the live reasoning; it starts collapsed and stays as you leave it while the answer arrives. Models can return reasoning through Ollama's `thinking`, LM Studio's `reasoning_content`, or a leading `<think>` block. Mercury does not fabricate reasoning for models that do not provide it. Reasoning is saved with the response and excluded from later conversation prompts. Stop works during both thinking and answering.

Chat interrupts repeated thinking (six repetitions of a twelve-word phrase within its recent reasoning), thinking beyond 30,000 characters, or two minutes without an answer or tool-call progress. It retries that generation once with instructions to answer directly, preserving the original partial reasoning and showing a recovery notice. For Ollama, the retry also requests disabled thinking where the model supports it (`low` for GPT-OSS). Other providers receive the direct-answer instruction without unsupported API switches. If recovery also stalls, the response ends with an actionable error rather than retrying indefinitely. Stop always cancels without retrying; already completed file actions are not replayed. Instructions treat acknowledgments such as “lit” or “thanks” as brief conversational replies instead of new analysis/file requests.

Open **Model settings** to configure the default project model. The app scans running Ollama and LM Studio servers on this computer, saved connections, and reachable Tailscale, WireGuard, and ZeroTier peers on their standard ports (`11434` and `1234`). Role overrides and context settings are under **Agent models and context**. Choose **Other…** in a model dropdown to add a custom address or port, including servers the scan misses. An optional API token can be entered there and is stored using Windows protected storage. The shared LM Studio server at `http://100.80.53.57:1234` is included in this prototype's saved connection defaults.

Open **Model settings → Cloud accounts** to connect an account. **Continue with ChatGPT** opens the system browser for the official OAuth flow; eligible accounts can grant ChatGPT plan usage. You can add multiple ChatGPT accounts, reconnect them, or disconnect them. Access and refresh tokens stay in the main process and are encrypted with Windows protected storage. OpenAI API keys are also supported with separate API billing.

Claude connects using a **Claude Console API key**, with separate API billing; this option does not sign into a Claude chat subscription. The app discovers models from each account instead of hardcoding model names, so Fable, Astra, or other models appear only when the account's model catalog exposes them. Cloud models support streamed text and tool calls for project agents. Interrupted or failed cloud streams are reported as failures, including usage limits received after streaming starts.

Official integration references: [ChatGPT sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [ChatGPT models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), and [Claude authentication](https://platform.claude.com/docs/en/manage-claude/authentication).

Model discovery is shared between Chat and Settings and cached in SQLite across restarts. Successful lists are reused for 30 minutes; an empty result is retried after one minute. Refresh bypasses the cache. Changing connection details or credentials, or encountering a connection/model-availability error, invalidates it. Changing the default model or agent assignments does not trigger a rescan. Concurrent discovery requests share one scan.

For coding, select **Projects**, open a folder, describe a task, review the generated plan, and use **Approve and implement** when it is ready. The agent can read and create Markdown, source code, JSON, and other UTF-8 text files, read selectable text from normal PDFs, and create simple text PDFs. File edits appear in **Changes**. Commands require approval showing the exact text and working directory.

## Built-in capabilities and plugins

Mercury includes Playwright as a runtime dependency for browser automation and end-to-end tests. The coding agent can request an approved Playwright command (for example, `npx playwright test`) when browser verification is appropriate. Browser commands are never run silently.

The agent also has a `discover_plugins` capability. It searches the built-in capability registry and declarative project-local manifests in `.mercury/plugins/*/plugin.json`, matching their names, descriptions, and optional `keywords` against the task. Discovery is informational only: it never downloads, activates, or executes a plugin. A minimal manifest looks like:

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "description": "Helps with a particular kind of task.",
  "keywords": ["task", "automation"]
}
```

## Build and checks

```powershell
npm run typecheck
npm test
npm run package
npm run make
```

For rapid testing of the latest source, use `npm start`; no installer is needed. `npm run package` creates `out/Mercury-win32-x64/Mercury.exe`, which can also be launched directly. `npm run make` creates an optional Windows installer. To build this update separately while an older copy is open, set `$env:LOCAL_PLAN_AGENT_BUILD_ID='mercury-refined'` in PowerShell, then run `npm run package`. The output will be `out/mercury-refined/Mercury-win32-x64/Mercury.exe`.

## Data and limitations

Chats, project sessions, and settings are stored in `state.sqlite`, outside the selected project. Mercury continues using `%APPDATA%/Local Plan Agent/` to preserve data and protected tokens from earlier builds. The app sends requests only to the selected local server or cloud provider. It makes no automatic cloud fallback requests. Selecting a cloud model sends the conversation and, for project agents, relevant project context and tool results to that provider. It does not download models or start a model server. Tailscale peer discovery requires its command-line client; WireGuard host routes and Windows VPN neighbor entries are checked when available. VPNs that do not expose peer addresses require **Other…**.

Command approval controls whether this app launches a command; it is not an operating-system sandbox. Planning agents have only read/search tools. Project coding edits require a file hash so changes made in another editor are not silently overwritten; project workspace tools retain their 512 KB text/simple-PDF limit. Chat's broader readers and native document tools operate on conversation attachments up to 25 MB with the extraction limits described above. After an interruption, resuming project work requires an explicit click and does not automatically replay an uncertain tool result.

The model/server combination matters: a tool-use check runs before implementation. Some models may produce a useful plan but lack reliable tool calling for coding. Live model compatibility and hardware performance must be checked on the target machine.

## Validation status

The common-format update passes TypeScript and 60 unit tests, including native Office round-trips, PNG/JPEG OCR, unknown binary handling, Unicode decoding, archive boundaries, and oversized/XML-entity extraction fallbacks. A packaged desktop regression creates and saves DOCX/XLSX/PPTX/PNG/ZIP, then re-uploads them with an image-only PDF and an unknown binary to verify extraction, bundled OCR, and visible metadata-only status. The updated build is `out/mercury-file-formats/Mercury-win32-x64/Mercury.exe`. File creation still requires a selected model/server that can return tool calls; the extraction and file-generation engines themselves run locally.

The drag-and-drop/thinking update passes TypeScript, 52 unit tests, and two focused packaged desktop regressions. The desktop checks use native disk-backed dropped files and exercise PDF generation/re-upload/persistence, detection and cancellation of a real open repeating stream, one direct-answer recovery, and manual Stop on a following response. Unit coverage includes reasoning budgets/timeouts, allowing progressing tools to finish, rejection of late cancelled chunks, and avoiding duplicate file creation during recovery. The updated build is `out/mercury-drop-thinking/Mercury-win32-x64/Mercury.exe`.

The formatted-file update passes TypeScript and 43 unit tests. Its packaged desktop regression creates a report without an explicit PDF request and checks Markdown rendering, title sizing, all rows of a long table, repeated table headers, code-block pagination, PDF re-upload, and file-card persistence. All four printed pages were rendered for visual inspection. The updated build is `out/mercury-formatted-files/Mercury-win32-x64/Mercury.exe`. Model behavior still depends on the selected model's tool-call support; the fixture validates the app's instructions and execution path rather than benchmarking a live Qwen model.

The chat-file fix passes TypeScript and 40 unit tests. A packaged desktop regression verifies uploading an IVP problem, receiving and executing a PDF tool call, saving the real PDF, re-uploading it through PDF.js, and restoring the generated file card after a restart. The updated build is `out/mercury-chat-files/Mercury-win32-x64/Mercury.exe`. This fixture verifies the app integration; a live response from a particular Qwen/server configuration is not part of this check.

The cloud-provider update passes TypeScript and 34 unit tests, including OAuth identity validation, refresh rotation, account disconnect behavior, model discovery, streamed tool calls, and interrupted responses. The packaged desktop checks pass (3 passed; optional live Tailscale check skipped), including provider selection, account settings, chat switching and history, and the plan-to-code workflow. The runnable build is `out/mercury-cloud/Mercury-win32-x64/Mercury.exe`. Real ChatGPT sign-in and cloud inference require a live account check.

For the preceding rich-text update, all 19 core tests and the Windows package build passed; desktop tests were left unrun at the user's request. That build remains in `out/mercury-rich/Mercury-win32-x64/`.

The preceding Mercury release passed all four packaged desktop tests. The shared LM Studio API at `100.80.53.57:1234` completed both a streamed tool-call check and a regular chat with `qwen3.8-27b-mlx@4bit` on October 18, 2026. A full plan-to-code run against that shared model has not been performed.

If browser sign-in shows `3p_delegated_access_policy_denied`, the error indicates a delegated-access policy rejection; the exact account, workspace, or integration cause is not established by this code alone. Mercury cannot override OpenAI eligibility restrictions. Use **Cancel sign-in**, then **Use an OpenAI API key (separate billing)** to explicitly configure API billing. Browser-only failures may not reach the local callback, so cancellation is available while waiting. The updated build is `out/mercury-auth-fix/Mercury-win32-x64/Mercury.exe`; 36 unit tests and TypeScript pass.
