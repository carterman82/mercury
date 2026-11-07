# Browser-side model verification

Apply only when inspected task files establish browser-side inference. An ordinary website needs its relevant UI checks, not page/model/inference criteria. A Python program using a remote API needs native/command checks instead.

Inspect current tool schemas; these browser capabilities vary by context. For a local UI, use an existing owned server from `project_server_status` or `start_project_server` when available. Do not substitute public-page browsing tools that cannot reach the local application.

Preserve three separate browser requirements with `stage` equal to `page`, `model`, and `inference`:

1. Open the actual page after edits and observe it without script errors. Record page evidence.
2. Observe the explicit loaded-model indicator with `browser_read` using the requirement's `selector` and `expectedText`. Loading, fallback, placeholder or error text is not readiness. Mark only the model criterion passed with that current evidence before submitting a question.
3. Keep the loaded page. Use `browser_fill` with the actual input selector, test `text`, `submit:true`, and a `responseSelector` identifying only the assistant reply. Then `browser_read` with that same reply selector after generation. Require a new non-placeholder reply after submission; echoed input, stale content and status text are insufficient.

`browser_wait` alone supplies no selected observation. Use post-interaction read/screenshot evidence IDs as required by the active contract. Do not reopen the page between readiness and inference: that destroys the observed ready state. If required interaction or local browser tools are unavailable, report verification blocked rather than inventing a pass.
