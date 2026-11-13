---
name: frontend-ui-engineering
description: Build user-facing components with intentional hierarchy, accessible interactions, responsive layout and complete UI states. Use for interface implementation or visual/accessibility defects; skip backend-only changes.
---

# Frontend UI engineering

Inspect the renderer, components, styles, tokens and user references. Establish the screen's purpose, primary action, realistic content and important states before choosing a layout. Preserve the visual language unless a redesign is requested. Do not substitute generic cards, hero sections or effects for the actual workflow.

Reuse typography, spacing, colors, icons and interaction patterns. Make hierarchy/density suit long names, code, localization and errors. References can inform structure; do not copy branding or add remote fonts/assets and dependencies without a concrete need and authorization.

Keep state near its owner and derive values rather than synchronizing duplicates. Share state when consumers need it; do not add stores, context or component systems to meet nesting or line-count rules. Preserve fetching/cache patterns and handle stale results, cancellation and unmount cleanup at their actual boundaries.

Implement relevant initial, loading, empty, populated, error, retry, success, disabled and permission-limited states. Avoid contradictory states; explain blocked actions in user terms. Reserve space where loading would shift content. Use optimistic updates only when failure can reconcile without losing edits or duplicating effects.

Use native semantic controls with labels or accessible names. Verify keyboard operation, visible focus and logical order. Dialogs need semantics, focus containment when modal, an expected dismissal route and focus restoration. Keep background content inert where required; an `open` attribute alone does not implement modal behavior. Announce meaningful asynchronous changes without flooding assistive technology.

Do not convey status through color alone. Check text/control contrast, zoom/reflow and reduced-motion preferences where relevant. Adapt to supported window sizes and input methods; desktop minimum sizes can differ from mobile breakpoints. Avoid clipped primary controls and required information hidden behind hover-only interactions.

Verify the actual UI when supported: primary action, an important failure/recovery path, keyboard navigation and relevant sizes with representative content. Check runtime errors and inspect alignment, overflow and hierarchy. Use existing Playwright/Electron tools; do not require a new browser service. Automated accessibility checks supplement manual and screen-reader verification. Report checks that could not be performed.

Use `verification` for completion and `performance` for concrete performance concerns. A screenshot establishes appearance, not working interactions or conformance to an accessibility standard.

Adapted from [Addy Osmani's frontend-ui-engineering](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/skills/frontend-ui-engineering/SKILL.md). Local changes preserve React/design conventions, avoid fixed component-size rules and correct incomplete modal examples. See [LICENSE.txt](LICENSE.txt).
