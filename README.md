# bg-window

A Hermes Desktop plugin that runs `/btw` and `/bg` (`/background`) in a small collapsible side chat docked above the composer, instead of dropping the answers into the chat transcript.

## How it works

1. A `composer.middleware` handler catches `/btw <question>`, `/bg <prompt>` and `/background <prompt>` before the app's slash handler, calls `prompt.btw` or `prompt.background` itself, and cancels the normal submit. The "task started" line never lands in chat.
2. `ctx.onEvent('btw.complete')` and `ctx.onEvent('background.complete')` pick up answers for task ids the plugin started and show them in the window, tagged `btw` or `bg`. Follow-ups typed in the window go to the same kind of task.
3. On apps that include `ctx.claimSideTask` ([NousResearch/hermes-agent#125968](https://github.com/NousResearch/hermes-agent/pull/125968)), the plugin claims each task id so the core never appends its `[bg …]` / `[btw …]` transcript line. On older apps it falls back to a `MutationObserver` that hides those lines. The fallback only affects the display, since the gateway never writes them to the stored session.

The window is plain DOM (no `react-dom`), 340px wide, pinned bottom-right with its right edge aligned to the composer. You can collapse it, and the collapsed state and recent tasks persist across reloads through plugin storage.

## Install

Copy `desktop/plugin.js` to `~/.hermes/desktop-plugins/bg-window/plugin.js`. The app hot-reloads plugins on save.

## Test

```
node test/unit.test.mjs
```

## License

MIT
