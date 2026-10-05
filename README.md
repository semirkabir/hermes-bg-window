# bg-window

A Hermes Desktop plugin that runs `/bg` (`/background`) tasks in a small collapsible window docked above the composer, instead of dropping the results into the chat transcript.

## How it works

1. A `composer.middleware` handler catches `/bg <prompt>` and `/background <prompt>` before the app's slash handler, calls `prompt.background` itself, and cancels the normal submit. The "Background task started" line never lands in chat.
2. `ctx.onEvent('background.complete')` picks up answers for task ids the plugin started and shows them in the window.
3. On apps that include `ctx.claimSideTask` ([NousResearch/hermes-agent#125968](https://github.com/NousResearch/hermes-agent/pull/125968)), the plugin claims each task id so the core never appends its `[bg <id>]` transcript line. On older apps it falls back to a `MutationObserver` that hides those lines. The fallback only affects the display, since the gateway never writes them to the stored session.

The window is plain DOM (no `react-dom`), 340px wide, pinned bottom-right with its right edge aligned to the composer. You can collapse it, and the collapsed state and recent tasks persist across reloads through plugin storage.

## Install

Copy `desktop/plugin.js` to `~/.hermes/desktop-plugins/bg-window/plugin.js`. The app hot-reloads plugins on save.

## Test

```
node test/unit.test.mjs
```

## Status

The plugin covers `/background` today. `/btw` uses the same claim, so pointing it at `btw.complete` is the obvious next step.

## License

MIT
