# hook-flow

Watch Claude Code's agent loop as it runs.

hook-flow is a Claude Code plugin that opens a side pane and shows what happens between pressing Enter and getting an answer: each hook event as it fires, a flow chart of the loop lighting up box by box, a timeline of every span in the turn, and the tokens and dollars it cost. Click any step to read what it is and what a plugin could do there.

It was built as a learning tool and as reference material for a post on [legible.co](https://legible.co). It only observes: it never changes what Claude Code does, and it adds nothing to the model's context.

## Install

In a Claude Code terminal session:

```
/plugin install hook-flow --marketplace legibleco/hook-flow
```

Answer `y` to add the marketplace, press Enter to install at user scope, and accept the default settings. Then open the pane:

```
/flow
```

The pane also opens by itself at the start of a session when the terminal is wide enough.

**Requires** Claude Code 2.1.294 or later, in a terminal (built and tested on 2.1.294–2.1.296). hook-flow is a *mod*, a plugin built on Claude Code's function hooks, so older versions can't load it. Hover and wheel zoom need a terminal that reports mouse movement; everything else works from the keyboard.

## What you'll see

**Flow chart.** The loop as boxes: prompt → context → turn start → model ⇄ tool call → permission → transcript → turn done, plus side boxes for subagents, compaction, slash commands and UI. A box glows when one of its events fires, the arrow between two boxes lights as the loop moves along it, and each box keeps a count.

**Explainer.** Click a box (or press `e`) and the bottom of the pane turns into a two-column guide: the steps on the left, and on the right what this step is, which events it covers, what a hook here can do, a short code example, and what the step has seen this session.

**Timeline.** Press `v`. The latest turn is laid out in time, one row per step, each event a bar from when its hook started to when it returned. Hover a bar to light it and everything that ran inside it; click to pin it and see its timing, data size and the plugins on it. The wheel zooms around the pointer.

**Replay.** Press `t` to play the last turn back on the flow chart, one step at a time.

**Header and stats.** A running dollar odometer and context gauge, a table of every event with a sparkline, count, average time and size, the plugins that took part in the last tool call, and tokens per model request.

## Keys

The pane takes keys once it has focus: click it, or press `ctrl+x tab`. A green **keys** badge shows when it has them, and `esc` hands them back.

| Where | Key | Does |
| --- | --- | --- |
| Anywhere | `p` / `r` / `u` / `v` | pause, reset counts, count UI events, switch flow ⇄ timeline |
| Flow chart | `e`, or click a box | open the explainer |
| | `t` | replay the last turn |
| Explainer | `↑` `↓` | step through the boxes |
| | `1`–`8`, `a` `c` `s` `i` | jump to a box |
| | `x` | close |
| Timeline | hover, click | light a span, pin it |
| | wheel, `z` / `o` / `f` | zoom in, out, fit the whole turn |
| | `↑` `↓`, `b` / `n` | step through the turn's spans |
| | `e` / `x` | explain the pinned span's step, unpin |

## Settings

Set at install, or later in `/config`:

| Setting | Default | |
| --- | --- | --- |
| Count UI events | off | Also count `ui.*` events (renders, presses, scrolls). They're noisy, and while this is on every draw on screen calls into the plugin. |
| Cost alert ($) | 0.5 | Flash the odometer and show a toast when one turn costs at least this much. |

## How it works

Claude Code raises an event at every step of its loop, and a plugin hooks one with `on(event, hook)`. Each hook gets `($, e, next)`: the engine interface, the event's input, and `next`, which runs everything beneath it. hook-flow hooks every event that isn't UI with one hook that notes the time, calls `next(e)`, and measures again when it returns. That's all a span is: a hook's start and finish around `next`. Simplified:

```ts
on('!ui.*', async ($, e, next) => {
  const startedAt = Date.now()
  flow.hit(next.event, startedAt)            // light the box
  const result = await next(e)               // the rest of the loop runs here
  measure(next.event, startedAt, e, result)  // time, size, plugins
  return result                              // unchanged
})
```

The pane is drawn by a `ui.render` hook. The flow chart and timeline are drawn by a small surface module, `chart.tsx`, which receives mouse clicks and hovers and posts them back to the hooks module.

| File | |
| --- | --- |
| `hooks/register.tsx` | The hooks: the observer above, token and cost tracking, the `/flow` command, and the pane |
| `hooks/flow.ts` | The flow chart: boxes, arrows, which event lights which box |
| `hooks/timeline.ts` | The timeline: span layout in lanes, zoom, hit-testing |
| `hooks/explain.ts` | The explainer text for each box |
| `hooks/chart.tsx` | The surface module that draws the chart and timeline and reports the pointer |
| `hooks/register.test.ts` | Tests, run against Claude Code's own engine |

Everything stays on your machine. The plugin makes no network calls, and nothing it records reaches the model.

## Changing it

Clone the repository and, from its folder, start a session with your copy loaded; it reloads when you save:

```
claude --plugin-dir .
```

Check a change with:

```
claude plugin validate .
claude plugin test .
```

Claude Code writes the API's type definitions into `.claude-plugin/types/` the first time it loads the plugin. After that, `npx -p typescript tsc -p .` type-checks it, and an editor gets completions. Those files are generated, so they're not checked in.

[AGENTS.md](AGENTS.md) has the conventions for changing the code with a coding agent.

## License

[MIT](LICENSE)
