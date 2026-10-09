# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A Claude Code plugin (a "mod": a plugin of function hooks) that visualizes the agent loop in a side pane. It is a shared example for readers, not a product: keep it small, readable and accurate.

## Layout

The repository root is the plugin, and `.claude-plugin/marketplace.json` makes it installable with `/plugin install hook-flow --marketplace legibleco/hook-flow`.

- `.claude-plugin/plugin.json`: the manifest, including the `userConfig` settings
- `hooks/hooks.json`: names the hooks module
- `hooks/register.tsx`: every hook, the module's state, and the pane's `ui.render`
- `hooks/flow.ts`, `hooks/timeline.ts`, `hooks/explain.ts`: pure modules that take no `$`; keep them that way so they test without the engine
- `hooks/chart.tsx`: a `Client` surface module; it draws rows of `[text, color]` runs and posts `frame`, `click` and `hover` messages that `ui.message` answers
- `types/index.d.ts`: the `$.state` contract; every `$.state` key the module uses is declared here

## Commands

```
claude plugin validate .   # what the engine would load or refuse
claude plugin test .       # hooks/*.test.ts against the real engine
npx -p typescript tsc -p . # needs .claude-plugin/types/, written when Claude Code first loads the plugin
claude --plugin-dir .      # a session with this copy loaded; it reloads on save
```

Run validate and test after every change. Both must pass. The one expected validate warning says `CLAUDE.md` at the plugin root isn't loaded as context for the installed plugin; that's intended, since it's only there to point Claude Code at this file when someone works in the repository.

## Rules the engine enforces

- `$` may only be passed to top-level functions. A helper that needs `$` is a top-level `function`, not a closure.
- Atom refs are literals: `atom({ plugin: 'hook-flow', key: 'tick' } as const, 0)`.
- The module has no DOM and no Node. Everything outside it goes through `$`.
- JSX compiles against the global `h`. Elements come from `$.ui.resolve(e)`, or `surface.elements` in `chart.tsx`, which has no `Raster`, `Image` or `Client`.
- `Button` hotkeys are one digit or lowercase letter. Check new ones against the keys table in the README.

## Conventions

- **Redraw by atom, not by invalidate.** Redraw with `update($, tick, n => n + 1)`, which redraws only the pane. `$.ui.invalidate('ui.render')` would redraw every site the plugin hooks.
- **Don't observe yourself.** The observer skips events the plugin raises itself (`next.origin.plugin === 'hook-flow'`) and the pane's own `ui.render` and `ui.message`, or it would feed back on its own redraws.
- **One focus.** The chart has no key listener on purpose. A click on it asks for the pane's focus with `$.ui.open({ focus: true })`, so the pane's `isFocused`, which the keys badge reads, is the only focus there is.
- **One Client.** Both views draw through the one `Client` keyed `chart`, so switching views keeps it mounted.
- **Keep the explainer honest.** The "A hook here can" lines in `explain.ts` must match the API. Check them against the event declarations in `.claude-plugin/types/claude-code/index.d.ts` when changing them.
- **Match the comment style.** Comments are short and say why. Match the surrounding code's naming and density.
- **Keep the docs in step.** Update the README's keys and settings tables when the behavior they describe changes.

## Testing notes

- A test file imports its own copy of the modules. The plugin under test is a separate instance, so assert on what the mounted pane shows rather than on imported module variables.
- In a test, a submitted prompt's turn stays open, so the timeline's axis keeps stretching. Locate a bar again before each pointer event, as the existing timeline tests do.
- Anything the plugin calls that nothing answers in a test needs a stub, e.g. `on('tool.call', () => ({ result: {}, text: 'ok' }))`.
