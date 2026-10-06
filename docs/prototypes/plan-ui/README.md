# Plan execution UI prototypes

Open [02-card.html](02-card.html) directly in a browser. No server, install, or
network connection is needed. All data is simulated. Nothing touches a real run.

The selected option is the progress strip, now implemented in the extension.
See [native screenshots and verification](../../ui-validation.md).
These HTML alternatives remain design fixtures, not live controls.

## Three options

| Option | Persistent UI | Trade-off |
| --- | --- | --- |
| [01 — Progress strip](01-strip.html) | Two content lines; an extra warning line when needed | Least space; inspect for task details |
| [02 — Task card](02-card.html) | Four to six content lines | Alternative: current task, accepted count, reason, next action |
| [03 — On-demand inspector](03-inspector.html) | Footer status only | Quietest; open the inspector for context |

Line counts describe normal terminal widths. Narrow browser previews wrap.
A native renderer must fit terminal columns explicitly.

The surrounding page is a comparison harness, not a proposed Pi web UI.
Only the terminal content maps to Pi. Buttons stand in for slash commands
in regular terminal mode. They do not imply clickable widgets are supported there.

Use the scenario selector to test missing worktree, working, review, retry,
external prerequisite, unknown worker, stopping, paused, cancelled, and complete.
The reported incident inspires the missing-worktree fixture. It is not a live
snapshot of that run.

## Proposed interaction contract — not implemented in the extension

- `/exec hide`: remove this extension's widget **and** footer segment immediately.
  Keep the visibility preference across reload. Controller updates cannot undo it.
- `/exec show`: restore the chosen layout without starting or resuming execution.
- `/exec clear`: dismiss the selected run's display, not its recovery evidence.
  No confirmation or `--apply`. Other runs are unaffected.
- `/exec status`: open a read-only inspector in TUI. Retain textual status in
  non-TUI modes. Escape closes only the inspector.
- Pause/cancel: persist user intent first, disable new dispatch, request worker
  cancellation, then reconcile exit in the background. Show “Pausing” or
  “Cancelling” until exit is confirmed. Hiding remains available throughout.
- Record deletion is a different operation from clearing the display.
  Never discard an unresolved operation identity to remove a widget.

The prototype has one fixture run per option: hide and clear therefore have
the same visible effect. Native implementation needs a session/repository view
preference plus per-run dismissal, separate from execution state. A new run must
not resurrect a dismissed old run. Explicit hide stays hidden even on errors.
Notifications, if retained, must not recreate the widget.

The prototype stores visibility in browser local storage, separately per option.
Theme, scenario, and narrow-width controls are preview-only.

## Information hierarchy

1. Human-readable plan title and honest state.
2. Accepted implementation tasks, not an invented time-completion percentage.
3. Current task or blocker.
4. One useful next action.
5. Technical evidence in the inspector only.

Twelve accepted tasks can still mean “Reviewing”, not “Complete”. A controller
heartbeat is not worker activity. A deleted worktree is not proof of worker exit.
“No deadline” is not proof of end-to-end unbounded execution. Missing usage or
progress stays unknown. Never manufacture zero cost or an ETA.

## Mapping to Pi

The installed Pi extension API supports all three layouts:

- `ctx.ui.setWidget(key, componentFactory)`: themed, width-aware strip/card.
- `ctx.ui.setWidget(key, undefined)` and `ctx.ui.setStatus(key, undefined)`:
  remove the two independent display surfaces.
- `ctx.ui.setStatus(key, text)`: footer-only mode without replacing Pi's footer.
- `ctx.ui.custom(factory, { overlay: true })`: keyboard-first inspector.
  Close through the factory's `done()` callback. Do not call an overlay handle's
  `hide()` to finish a custom interaction.
- Theme tokens: `accent`, `success`, `warning`, `error`, `muted`.
  Keep symbols/text alongside colors.
- `truncateToWidth`, `visibleWidth`, and `wrapTextWithAnsi`: column-safe output.
  Use a compact fallback at small widths. No CSS layout inside Pi.
- Guard terminal components with `ctx.mode === "tui"`. `ctx.hasUI` alone also
  includes supported RPC UI interactions.
- Render from a cached observation snapshot. Rendering must not read the
  filesystem, query providers, change run state, or repair projections.

References:
[Pi UI guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md),
[extension contracts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[widget example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/widget-placement.ts).

These are HTML behavior prototypes, not a native Pi implementation. Native
verification still needs regular/fullscreen mode, theme changes, wide Unicode,
resize, multiple runs, reload, late async projection responses, and RPC coverage.

## Browser verification

Chromium checked all three options across ten scenarios, at desktop and
390-pixel mobile widths. Checks cover hide/show/clear, hide persistence on reload,
updates while hidden, pending cancellation, command input, Tab, Escape, and
horizontal overflow. Screenshots cover dark desktop, the inspector, and light
mobile. No page errors occurred. Test scripts and screenshots are temporary
artifacts outside this repository. No browser dependency was added.
