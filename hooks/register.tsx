import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TraceEntry } from 'claude-code'

import type { Snapshot } from '../types'
import { EXPLAIN, NODE_BY_KEY } from './explain'
import type { ChartProps } from './chart'
import { FLOW_COLUMNS, FLOW_ROWS, Flow, NODES, nodeAt, nodeOf } from './flow'
import { LABEL_WIDTH, follow, heightOf, insideOf, layout, seconds, spansAt, timelineRows, wholeOf, zoomBy } from './timeline'
import type { Span, Window } from './timeline'

const PANE = 'hook-flow'
const SECONDS = 12
const BARS = '▁▂▃▄▅▆▇█'
const EIGHTHS = ' ▏▎▍▌▋▊▉█'

// The pane reads `tick`, so a write redraws the pane alone; $.ui.invalidate
// would redraw every site this plugin hooks, every site on screen with UI on.
const tick = atom({ plugin: 'hook-flow', key: 'tick' } as const, 0)
const snapshot = atom({ plugin: 'hook-flow', key: 'snapshot' } as const, null as Snapshot | null)

export type EventStats = {
  n: number
  ms: number
  bytes: number
  lastAt: number
  perSecond: Map<number, number>
  plugins: Set<string>
}
export type Step = { input: number; output: number; cached: number }
export type Turn = { usd: number; tokens: number }
export type Seen = { event: string; node: string; detail: string; at: number }
export type Call = { tool: string; ms: number; links: { plugin: string; ms: number; outcome: string }[] }

export const stats = new Map<string, EventStats>()
export const steps: Step[] = []
export const turns: Turn[] = []
export const flow = new Flow()
let view: 'flow' | 'timeline' = 'flow'
let selected: string | undefined
export const seen = new Map<string, Seen>()
export const history = new Map<string, Seen[]>()
let recording: Seen[] = []
export let lastTurnSteps: Seen[] = []
let replay: { steps: Seen[]; index: number; flow: Flow; timer: Timer } | undefined
let lastCall: Call | undefined
export let spans: Span[] = []
let isRecordingSpans = false
let turnDepth = 0
let nextSpanId = 1
let hoveredId: number | undefined
let hoverCount = 0
let pinnedId: number | undefined
let zoom: Window | undefined
let paneOffset = 0
// The pane's rows above the chart: the odometer, then the buttons.
const CHART_TOP = 2
let sessionUsd: number | undefined
let shownUsd = 0
let flashUntil = 0
let contextPercent: number | undefined
let isDirty = false
let isPaused = false
let lastActivityAt = 0
let chartColumns = 0
let odometer: Timer | undefined

export const sizeOf = (value: unknown): number => {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

export const record = (event: string, ms: number, bytes: number, plugins: string[], now: number) => {
  const one = stats.get(event) ?? {
    n: 0, ms: 0, bytes: 0, lastAt: 0, perSecond: new Map<number, number>(), plugins: new Set<string>(),
  }
  const second = Math.floor(now / 1000)
  one.n += 1
  one.ms += ms
  one.bytes += bytes
  one.lastAt = now
  one.perSecond.set(second, (one.perSecond.get(second) ?? 0) + 1)
  for (const old of one.perSecond.keys()) if (old <= second - SECONDS) one.perSecond.delete(old)
  for (const plugin of plugins) one.plugins.add(plugin)
  stats.set(event, one)
  lastActivityAt = now
  isDirty = true
}

export const sparkline = (values: readonly number[]): string => {
  const top = Math.max(...values, 0)
  return values.map(v => (v === 0 ? ' ' : BARS[Math.min(7, Math.floor((v / top) * 7.999))])).join('')
}

// A horizontal bar `width` cells wide at most, in eighths of a cell.
export const bar = (value: number, top: number, width: number): string => {
  const eighths = top <= 0 ? 0 : Math.round((Math.min(value, top) / top) * width * 8)
  return '█'.repeat(Math.floor(eighths / 8)) + (eighths % 8 ? EIGHTHS[eighths % 8] : '')
}

const recentSeconds = (one: EventStats, now: number) => {
  const second = Math.floor(now / 1000)
  return Array.from({ length: SECONDS }, (_, i) => one.perSecond.get(second - SECONDS + 1 + i) ?? 0)
}

const short = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`

const duration = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`)

const pad = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)

export const reset = () => {
  stats.clear()
  steps.length = 0
  turns.length = 0
  lastCall = undefined
  isDirty = true
}

const measure = (event: string, startedAt: number, e: unknown, result: unknown, trace: readonly TraceEntry[]) => {
  const plugins = trace.map(link => link.plugin).filter(p => p !== 'engine' && p !== 'hook-flow')
  const bytes = sizeOf(e) + sizeOf(result)
  record(event, Date.now() - startedAt, bytes, plugins, Date.now())
  return { bytes, plugins }
}

// The spans of the turn in progress, or of the last one: a prompt starts a
// fresh set, and the turn that answers it completing closes it.
export const startSpan = (event: string, detail: string, now: number): Span | undefined => {
  const node = nodeOf(event)
  if (!node || node === 'ui') return undefined
  if (event === 'prompt.submit') {
    spans = []
    isRecordingSpans = true
    turnDepth = 0
    hoveredId = undefined
    pinnedId = undefined
    zoom = undefined
  }
  if (!isRecordingSpans || spans.length >= 600) return undefined
  if (event === 'turn.start') turnDepth += 1
  const span: Span = { id: nextSpanId++, event, node, detail, start: now, bytes: 0, plugins: [] }
  spans.push(span)
  return span
}

export const endSpan = (span: Span | undefined, bytes: number, plugins: string[], now: number) => {
  if (!span) return
  span.end = now
  span.bytes = bytes
  span.plugins = plugins
  if (span.event === 'turn.complete') {
    turnDepth -= 1
    if (turnDepth <= 0) isRecordingSpans = false
  }
}

export const toSnapshot = (): Snapshot => ({
  events: [...stats].map(([event, one]) => ({
    event, n: one.n, ms: one.ms, bytes: one.bytes, lastAt: one.lastAt,
    perSecond: [...one.perSecond], plugins: [...one.plugins],
  })),
  steps: [...steps],
  turns: [...turns],
  isPaused,
})

export const fromSnapshot = (saved: Snapshot) => {
  reset()
  for (const one of saved.events) {
    stats.set(one.event, { ...one, perSecond: new Map(one.perSecond), plugins: new Set(one.plugins) })
  }
  steps.push(...saved.steps)
  turns.push(...saved.turns)
  isPaused = saved.isPaused
}

// Flips the UI option. The engine reloads the module with the new value,
// which drops module variables, so the counts go to $.state first.
async function toggleUi($: EngineInterface, isOn: boolean) {
  await update($, snapshot, () => toSnapshot())
  const row = (await $.config.list()).find(one => one.key.endsWith('.watchUi') && one.key.startsWith('hook-flow'))
  const done = row && (await $.config.set({ key: row.key, value: !isOn }))
  if (!done || 'deny' in done) {
    await update($, snapshot, () => null)
    $.ui.toast(`hook-flow: couldn't switch UI events${done && 'deny' in done ? `: ${done.deny}` : ''}`)
  }
}

// A box's count: every event it stands for, from the per-event stats; in a
// replay, the steps replayed so far.
export const countOf = (id: string): number => {
  let n = 0
  if (replay) {
    for (const step of replay.steps.slice(0, replay.index + 1)) if (step.node === id) n += 1
    return n
  }
  for (const [event, one] of stats) if (nodeOf(event) === id) n += one.n
  return n
}

const keyOf = (id: string) => EXPLAIN[id]?.key ?? ''

// The last thing each box saw, and the steps of the turn in progress: a
// prompt starts a recording, the turn's completion files it for replay.
export const note = (event: string, detail: string, now: number) => {
  const node = nodeOf(event)
  if (!node) return
  const step: Seen = { event, node, detail, at: now }
  seen.set(node, step)
  history.set(node, [step, ...(history.get(node) ?? [])].slice(0, 5))
  if (node === 'ui') return
  if (event === 'prompt.submit') recording = []
  recording.push(step)
  if (recording.length > 400) recording.shift()
  if (event === 'turn.complete') {
    lastTurnSteps = recording
    recording = []
  }
}

const activeFlow = () => replay?.flow ?? flow

// The chart and the timeline need their full width; narrower, neither shows.
const shownView = (columns: number) => (columns < FLOW_COLUMNS ? 'none' : view)

export const chartProps = (columns: number, now: number): ChartProps => ({
  // The keys that jump to a box only work, and only show, while explaining.
  rows: activeFlow().rows(columns, now, countOf, selected ? keyOf : undefined, selected),
  isHot: activeFlow().isHot(now),
})

const nodeColor = (id: string) => NODES.find(n => n.id === id)?.color ?? 0xdfe6e9
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`

// The span the timeline lights: the one under the pointer, else the pinned one.
const focusSpan = () => spans.find(s => s.id === (hoveredId ?? pinnedId))

const readout = (focus: Span | undefined, now: number): string => {
  if (spans.length === 0) return 'Waiting for a prompt…'
  if (!focus) return `${spans.length} events · hover a bar · click to pin`
  const stack = focus.id === hoveredId && hoverCount > 1 ? `×${hoverCount} ` : ''
  const t0 = spans[0]?.start ?? focus.start
  return `${stack}${focus.event}${focus.detail ? ` · ${focus.detail}` : ''} · ${seconds((focus.end ?? now) - focus.start)} · +${seconds(focus.start - t0)}`
}

export const shapeOf = (columns: number, now: number) => layout(spans, columns, now, zoom)

// Zooms the timeline around a point of its field (a fraction), by default
// the pinned span when it shows, else the middle.
export const zoomTimeline = (factor: number, columns: number, now: number, anchor?: number) => {
  const shape = shapeOf(columns, now)
  const pinned = spans.find(s => s.id === pinnedId)
  const mid = pinned ? ((pinned.start + (pinned.end ?? now)) / 2 - shape.t0) / (shape.t1 - shape.t0) : 0.5
  zoom = zoomBy(zoom, shape.whole, factor, anchor ?? Math.max(0, Math.min(1, mid)))
}

export const zoomOf = () => zoom

// The timeline's rows and, beneath them, a line on the span in focus.
export const timelineProps = (columns: number, now: number): ChartProps => {
  const focus = focusSpan()
  const rows = timelineRows(spans, shapeOf(columns, now), columns, now, focus)
  rows.push([[pad(readout(focus, now), columns), focus ? nodeColor(focus.node) : 0x7f8c8d]])
  return { rows, isHot: isRecordingSpans }
}

// Moves the pin along the turn, in the order the spans started.
export const pinFrom = (by: number) => {
  if (spans.length === 0) return
  const at = spans.findIndex(s => s.id === pinnedId)
  const next = at < 0 ? (by > 0 ? 0 : spans.length - 1) : Math.max(0, Math.min(spans.length - 1, at + Math.sign(by)))
  pinnedId = spans[next]?.id
  const pinned = spans[next]
  if (pinned) zoom = follow(zoom, pinned, Date.now())
}

const NARROW = 52
const WIDE = 72

// Opens or closes explain mode on a box; the pane asks for more room while
// it explains, and gives it back after (a width the person dragged wins).
function select($: EngineInterface, id: string | undefined) {
  const wasOpen = selected !== undefined
  selected = selected === id ? undefined : id
  const isOpen = selected !== undefined
  if (wasOpen !== isOpen) {
    $.ui.open({ id: PANE, title: 'Hook flow', columns: isOpen ? WIDE : NARROW }).catch(() => undefined)
  }
  return update($, tick, n => n + 1)
}

// The boxes in loop order, as their keys run: what ↑ and ↓ step through.
export const ORDER = Object.keys(EXPLAIN)

export const stepFrom = (from: string | undefined, by: number): string => {
  const at = from === undefined ? -1 : ORDER.indexOf(from)
  const next = (at + Math.sign(by) + ORDER.length) % ORDER.length
  return ORDER[next] ?? ORDER[0] ?? 'prompt'
}

// Where explain mode opens: the box that fired last, else the prompt.
const latestBox = () => {
  let best: Seen | undefined
  for (const one of seen.values()) if (one.node !== 'ui' && (!best || one.at > best.at)) best = one
  return best?.node ?? 'prompt'
}

function stopReplay() {
  replay?.timer.cancel()
  replay = undefined
}

// Plays the last finished turn back one step every 450 ms on a chart of its
// own, so each step lights in order; pressing again stops it.
function toggleReplay($: EngineInterface) {
  if (replay) {
    stopReplay()
    return update($, tick, n => n + 1)
  }
  if (lastTurnSteps.length === 0) {
    $.ui.toast('hook-flow: no finished turn to replay yet')
    return
  }
  view = 'flow'
  const steps = lastTurnSteps
  const played = new Flow()
  const timer = $.clock.every(450, () => {
    if (!replay) return
    replay.index += 1
    const step = replay.steps[replay.index]
    if (!step) {
      stopReplay()
    } else {
      replay.flow.hit(step.event, Date.now())
    }
    void update($, tick, n => n + 1)
  })
  replay = { steps, index: -1, flow: played, timer }
  return update($, tick, n => n + 1)
}

// Rolls the shown total toward the real one, a few redraws a second.
function rollOdometer($: EngineInterface) {
  if (odometer) return
  odometer = $.clock.every(60, () => {
    const target = sessionUsd ?? 0
    shownUsd += (target - shownUsd) * 0.3
    if (Math.abs(target - shownUsd) < 0.0005) {
      shownUsd = target
      odometer?.cancel()
      odometer = undefined
    }
    void update($, tick, n => n + 1)
  })
}

export const register: Register = (on, options) => {
  const isWatchingUi = options.watchUi === true
  const costAlert = typeof options.costAlert === 'number' ? options.costAlert : 0.5

  // Every event but the ui.* ones, timed and sized; our own $ calls are left
  // out, so the widget never counts itself.
  on('!ui.*', async ($, e, next) => {
    const isOwn = isPaused || next.origin.plugin === 'hook-flow'
    const startedAt = Date.now()
    let span: Span | undefined
    if (!isOwn) {
      flow.hit(next.event, startedAt)
      const detail = next.is('tool.call', e) ? e.tool
        : next.is('turn.step', e) ? `${e.model} · ${e.messageCount} messages`
        : next.is('prompt.submit', e) ? `${e.text.length} characters`
        : next.is('agent.spawn', e) ? (e.subagentType ?? 'agent')
        : next.is('command.run', e) ? `/${e.command}`
        : ''
      note(next.event, detail, startedAt)
      span = startSpan(next.event, detail, startedAt)
    }
    const result = await next(e)
    if (!isOwn) {
      const { bytes, plugins } = measure(next.event, startedAt, e, result, next.trace)
      endSpan(span, bytes, plugins, Date.now())
      if (next.is('tool.call', e)) {
        lastCall = {
          tool: e.tool,
          ms: Date.now() - startedAt,
          links: next.trace.map(link => ({ plugin: link.plugin, ms: link.ms, outcome: link.outcome })),
        }
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // The ui.* events, only while the option is on: registered at all, this
  // hook makes every site on screen call into the module as it draws.
  if (isWatchingUi) {
    on('ui.*', async ($, e, next) => {
      const isOwn =
        isPaused ||
        next.origin.plugin === 'hook-flow' ||
        (next.is('ui.render', e) && e.requestId === PANE) ||
        (next.is('ui.message', e) && e.requestId === PANE)
      const startedAt = Date.now()
      if (!isOwn) {
        flow.hit(next.event, startedAt)
        note(next.event, next.is('ui.render', e) ? e.component : '', startedAt)
      }
      const result = await next(e)
      if (!isOwn) {
        measure(next.event, startedAt, e, result, next.trace)
      }
      return result
    }).catch(($, e, next) => next(e))
  }

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage && !isPaused) {
      const u = result.usage
      steps.push({
        input: u.input_tokens + u.cache_creation_input_tokens,
        cached: u.cache_read_input_tokens,
        output: u.output_tokens,
      })
      if (steps.length > 200) steps.shift()
      contextPercent = (await $.session.usage()).context.percent ?? contextPercent
      isDirty = true
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = await $.session.usage()
    const usd = usage.cost?.usd ?? sessionUsd ?? 0
    const tokens = steps.reduce((sum, s) => sum + s.input + s.output, 0)
    const spent = usd - (sessionUsd ?? usd)
    turns.push({ usd: spent, tokens })
    if (turns.length > 100) turns.shift()
    sessionUsd = usd
    contextPercent = usage.context.percent
    if (spent >= costAlert) {
      flashUntil = Date.now() + 3000
      $.ui.toast(`hook-flow: that turn cost $${spent.toFixed(2)}`)
    }
    rollOdometer($)
    isDirty = true
    return done
  })

  on('session.start', async ($, e, next) => {
    const saved = await read($, snapshot)
    if (saved) {
      fromSnapshot(saved)
      await update($, snapshot, () => null)
    }
    const usage = await $.session.usage()
    sessionUsd = usage.cost?.usd
    shownUsd = sessionUsd ?? 0
    contextPercent = usage.context.percent
    await $.command.register({ name: 'flow', description: 'Show the hook-flow pane: every hook event, tokens and $' })
    // The table redraws at most twice a second, and keeps sliding its
    // sparklines while anything happened in the window they show.
    $.clock.every(500, () => {
      const isSliding = Date.now() - lastActivityAt < SECONDS * 1000
      if (isDirty || isSliding || Date.now() < flashUntil + 500) {
        isDirty = false
        void update($, tick, n => n + 1)
      }
    })
    void $.ui.open({ id: PANE, title: 'Hook flow', columns: selected ? WIDE : NARROW })
    return next(e)
  })

  // The charts' posts: a frame request answered with fresh rows; on the flow
  // chart a click opens the box under it; on the timeline a hover lights the
  // span under it and a click pins it.
  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    const data = e.data as { kind?: string; x?: number; y?: number } | null
    const now = Date.now()
    // A click on the chart asks for the pane's keys, so the pane's own focus
    // (which the badge shows, and Escape hands back) is the only one there is.
    // Claude Code grants it over an empty prompt; otherwise the keys stay put.
    if (data?.kind === 'click') void $.ui.open({ id: PANE, title: 'Hook flow', focus: true }).catch(() => undefined)
    // One Client draws both views, so switching keeps it; the view says which.
    if (shownView(chartColumns) === 'timeline') {
      const isAt = typeof data?.x === 'number' && typeof data.y === 'number'
      const under = isAt && data.x! >= 0 ? spansAt(shapeOf(chartColumns, now), data.x!, data.y!) : []
      if (data?.kind === 'hover') {
        hoveredId = under[0]?.id
        hoverCount = under.length
      }
      if (data?.kind === 'click' && under[0]) {
        pinnedId = pinnedId === under[0].id ? undefined : under[0].id
        await update($, tick, n => n + 1)
      }
      return { props: timelineProps(chartColumns, now) }
    }
    if (data?.kind === 'hover') return {}
    if (data?.kind === 'frame') return { props: chartProps(chartColumns, now) }
    if (data?.kind === 'click' && typeof data.x === 'number' && typeof data.y === 'number') {
      const id = nodeAt(data.x, data.y, chartColumns)
      if (id) await select($, id)
      return {}
    }
    return next(e)
  })

  // In explain mode the scroll keys step through the boxes instead of
  // scrolling; the wheel (it carries a pointer) still scrolls the pane.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    // The wheel over the timeline zooms it around the pointer: up in, down out.
    if (e.pointer && e.by !== 0 && shownView(chartColumns) === 'timeline') {
      const now = Date.now()
      const shape = shapeOf(chartColumns, now)
      const row = e.pointer.row + paneOffset - CHART_TOP
      const x = e.pointer.column - LABEL_WIDTH
      if (row >= 0 && row < heightOf(shape) && x >= 0) {
        zoomTimeline(e.by < 0 ? 0.7 : 1 / 0.7, chartColumns, now, x / shape.field)
        await update($, tick, n => n + 1)
        return {}
      }
    }
    if (e.pointer !== undefined || e.by === 0) return next(e)
    if (!selected && shownView(chartColumns) === 'timeline' && spans.length > 0) {
      pinFrom(e.by)
      await update($, tick, n => n + 1)
      return {}
    }
    if (!selected) return next(e)
    selected = stepFrom(selected, e.by)
    await update($, tick, n => n + 1)
    return {}
  })

  on('command.run', { command: 'flow' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Hook flow', columns: selected ? WIDE : NARROW })
    return { text: 'Hook flow pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const count = await read($, tick)
    const now = Date.now()
    const width = Math.max(30, e.props.bodyColumns)
    const nameWidth = width - SECONDS - 18
    const callRows = lastCall ? Math.min(4, lastCall.links.length) + 1 : 1
    const hasChart = e.surface === 'terminal'
    const hasKeys = e.props.isFocused
    const shown = shownView(width)
    const shape = shapeOf(width, now)
    paneOffset = e.props.scroll.offset
    const chartRows = shown === 'flow' ? FLOW_ROWS : shown === 'timeline' ? heightOf(shape) + 1 : 1
    const pinned = shown === 'timeline' ? spans.find(s => s.id === pinnedId) : undefined
    const explainer = selected ? EXPLAIN[selected] : undefined
    const room = Math.max(3, e.props.scroll.bodyRows - 14 - callRows - (hasChart ? chartRows : 0))

    const rows = [...stats.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, room)
    const lastStep = steps.at(-1)
    const lastTurn = turns.at(-1)

    // The odometer: amber while it rolls, a blinking alert after a costly turn.
    const isFlashing = now < flashUntil
    const usd = sessionUsd === undefined ? '$—.———' : `$${shownUsd.toFixed(3)}`
    const usdColor = isFlashing ? 'red' : odometer !== undefined ? 'yellow' : undefined

    // The context gauge, green to amber to red as it fills toward compaction.
    const gaugeWidth = 14
    const pct = contextPercent ?? 0
    const gaugeColor = pct >= 80 ? 'red' : pct >= 60 ? 'yellow' : 'green'
    const filled = bar(pct, 100, gaugeWidth)

    const links = lastCall?.links.filter(l => l.outcome !== 'skipped').slice(0, 4) ?? []
    const slowest = Math.max(1, ...links.map(l => l.ms))
    const linkBar = Math.max(6, width - 22)

    let chartView
    if (hasChart) {
      chartColumns = width
      if (shown !== 'none') {
        const { Client } = $.ui.resolve(e)
        const props = shown === 'flow' ? chartProps(width, now) : timelineProps(width, now)
        chartView = <Client key="chart" module="./chart.tsx" props={props} width={width} height={chartRows} />
      } else {
        chartView = <Text dimColor>Widen the pane to see the chart.</Text>
      }
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold color={usdColor} inverse={isFlashing && count % 2 === 0}>{usd}</Text>
          <Text dimColor>ctx</Text>
          <Box flexDirection="row">
            <Text color={gaugeColor}>{filled}</Text>
            <Text dimColor>{'░'.repeat(Math.max(0, gaugeWidth - filled.length))}</Text>
          </Box>
          <Text color={gaugeColor}>{contextPercent === undefined ? '—' : `${pct}%`}</Text>
          {hasKeys
            ? <Text color="black" backgroundColor="green" bold>{' ⌨ keys · esc '}</Text>
            : <Text dimColor>{'click for keys'}</Text>}
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button key="pause" label={isPaused ? 'resume' : 'pause'} hotkey="p" plain
            onPress={() => { isPaused = !isPaused; return update($, tick, n => n + 1) }} />
          <Button key="reset" label="reset" hotkey="r" plain
            onPress={() => { reset(); return update($, tick, n => n + 1) }} />
          <Button key="ui" label={isWatchingUi ? 'ui: on' : 'ui: off'} hotkey="u" plain
            dimColor={!isWatchingUi} onPress={() => toggleUi($, isWatchingUi)} />
          {hasChart && (
            <Button key="view" label={`view: ${view}`} hotkey="v" plain
              onPress={() => {
                view = view === 'flow' ? 'timeline' : 'flow'
                return update($, tick, n => n + 1)
              }} />
          )}
        </Box>
        {chartView}
        {replay && (() => {
          const step = replay.steps[Math.max(0, replay.index)]
          const first = replay.steps[0]?.at ?? 0
          const title = step ? EXPLAIN[step.node]?.title ?? step.node : ''
          return (
            <Text color="yellow">
              {step
                ? `▶ ${replay.index + 1}/${replay.steps.length} · ${title}${step.detail ? ` · ${step.detail}` : ''} · +${duration(step.at - first)}`
                : `▶ replaying ${replay.steps.length} steps…`}
            </Text>
          )
        })()}
        {hasChart && shown === 'flow' && !explainer && (
          <Box flexDirection="row" gap={1}>
            <Button key="explain" label="? explain" hotkey="e" variant="primary" onPress={() => select($, latestBox())} />
            <Button key="replay" label={replay ? '■ stop' : '▶ replay'} hotkey="t" plain
              onPress={() => toggleReplay($)} />
          </Box>
        )}
        {hasChart && shown === 'flow' && (
          <Text dimColor italic>
            {!e.props.isFocused
              ? 'click a box to explain it, or ctrl+x tab then e'
              : explainer
                ? '↑↓ step · 1–8 a c s i jump · t replay · x close'
                : 'click a box or e to explain · t replay the last turn'}
          </Text>
        )}
        {hasChart && shown === 'timeline' && spans.length > 0 && (
          <Box flexDirection="row" gap={2}>
            <Button key="zoom:in" label="z zoom in" hotkey="z" plain
              onPress={() => { zoomTimeline(0.5, chartColumns, Date.now()); return update($, tick, n => n + 1) }} />
            <Button key="zoom:out" label="o out" hotkey="o" plain dimColor={!zoom}
              onPress={() => { zoomTimeline(2, chartColumns, Date.now()); return update($, tick, n => n + 1) }} />
            {zoom && (
              <Button key="zoom:fit" label="f fit" hotkey="f" plain
                onPress={() => { zoom = undefined; return update($, tick, n => n + 1) }} />
            )}
          </Box>
        )}
        {hasChart && shown === 'timeline' && !explainer && (
          <Text dimColor italic>
            {!e.props.isFocused
              ? 'hover a bar to light what ran inside it · click to pin · wheel zooms'
              : pinned
                ? '↑↓ or b n step through the turn · e explain · x unpin'
                : 'hover a bar · click to pin · wheel or z o zoom · ↑↓ step'}
          </Text>
        )}
        {explainer && selected ? (() => {
          // Explain mode: the boxes as a list on the left, the chosen one's
          // details on the right, in place of the stats below.
          const color = hex(NODES.find(n => n.id === selected)?.color ?? 0xffffff)
          const events = [...stats].filter(([event]) => nodeOf(event) === selected)
          const recent = history.get(selected) ?? []
          return (
            <Box flexDirection="row" gap={1} marginTop={1}>
              <Box flexDirection="column" width={19} flexShrink={0}>
                {ORDER.map(id => NODES.find(n => n.id === id)).filter(n => n !== undefined).map(node => {
                  const one = EXPLAIN[node.id]
                  const n = countOf(node.id)
                  return (
                    <Button key={`explain:${node.id}`} plain hotkey={one?.key}
                      dimColor={node.id !== selected}
                      label={`${node.id === selected ? '▸' : ' '}${one?.key ?? ' '} ${pad(node.label, 10)}${(n ? short(n) : '').padStart(5)}`}
                      onPress={() => select($, node.id)} />
                  )
                })}
                <Text> </Text>
                <Button key="replay" label={replay ? '■ stop replay' : '▶ replay turn'} hotkey="t" plain
                  onPress={() => toggleReplay($)} />
                <Button key="close" label="✕ close" hotkey="x" plain dimColor onPress={() => select($, undefined)} />
              </Box>
              <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={color} paddingX={1}>
                <Text bold color={color}>{explainer.title}</Text>
                <Text>{explainer.what}</Text>
                <Text> </Text>
                <Text bold>A hook here can</Text>
                <Text>{explainer.can}</Text>
                <Code source={explainer.snippet} language="ts" />
                <Text bold>Events</Text>
                {events.length === 0 && <Text dimColor>{`${explainer.events} · not seen yet`}</Text>}
                {events.map(([event, one]) => (
                  <Text>
                    {`${pad(event, 24)}${short(one.n).padStart(6)}  ${duration(one.ms / one.n).padStart(6)} avg`}
                  </Text>
                ))}
                <Text bold>Recently</Text>
                {recent.length === 0 && <Text dimColor>nothing yet this session</Text>}
                {recent.map(step => (
                  <Text dimColor>
                    {`${duration(now - step.at).padStart(7)} ago  ${step.detail || step.event}`}
                  </Text>
                ))}
              </Box>
            </Box>
          )
        })() : pinned ? (() => {
          // A pinned span: what it was, how long it took, what ran through
          // it and inside it, and what its box means.
          const color = hex(nodeColor(pinned.node))
          const about = EXPLAIN[pinned.node]
          const inside = insideOf(spans, pinned, now)
          const kinds = new Map<string, number>()
          for (const one of inside) kinds.set(one.event, (kinds.get(one.event) ?? 0) + 1)
          const index = spans.indexOf(pinned)
          return (
            <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginTop={1}>
              <Text bold color={color}>{`${index + 1}/${spans.length} · ${about?.title ?? pinned.node}`}</Text>
              <Text>{`${pinned.event}${pinned.detail ? ` · ${pinned.detail}` : ''}`}</Text>
              <Text dimColor>
                {`started +${seconds(pinned.start - (spans[0]?.start ?? pinned.start))} · took ${pinned.end === undefined ? `${seconds(now - pinned.start)} so far` : seconds(pinned.end - pinned.start)} · ${short(pinned.bytes / 1024)} KB in and out`}
              </Text>
              <Text dimColor>
                {pinned.plugins.length > 0 ? `plugins on it: ${[...new Set(pinned.plugins)].join(', ')}` : 'no other plugin hooked it'}
              </Text>
              <Text> </Text>
              <Text bold>Inside it</Text>
              {kinds.size === 0 && <Text dimColor>nothing else ran inside this span</Text>}
              {[...kinds].map(([event, n]) => <Text>{`${pad(event, 26)}×${n}`}</Text>)}
              <Text> </Text>
              <Text dimColor>{about?.what ?? ''}</Text>
              <Box flexDirection="row" gap={2} marginTop={1}>
                <Button key="span:prev" label="◀ prev" hotkey="b" plain
                  onPress={() => { pinFrom(-1); return update($, tick, n => n + 1) }} />
                <Button key="span:next" label="next ▶" hotkey="n" plain
                  onPress={() => { pinFrom(1); return update($, tick, n => n + 1) }} />
                <Button key="span:explain" label="? explain" hotkey="e" plain onPress={() => select($, pinned.node)} />
                <Button key="span:unpin" label="✕ unpin" hotkey="x" plain dimColor
                  onPress={() => { pinnedId = undefined; return update($, tick, n => n + 1) }} />
              </Box>
            </Box>
          )
        })() : (
          <Box flexDirection="column">
            <Text dimColor>{`${pad('event', nameWidth)} ${pad(`last ${SECONDS}s`, SECONDS)}     n   ms   KB`}</Text>
            {rows.length === 0 && <Text dimColor>Waiting for events…</Text>}
            {rows.map(([event, one]) => {
              const isHot = now - one.lastAt < 1000
              const avg = one.ms / one.n
              return (
                <Text color={isHot ? 'green' : undefined} dimColor={!isHot && now - one.lastAt > SECONDS * 1000}>
                  {`${pad(event, nameWidth)} ${sparkline(recentSeconds(one, now))} ${short(one.n).padStart(5)} ${short(avg).padStart(4)} ${short(one.bytes / 1024).padStart(4)}`}
                </Text>
              )
            })}
            <Text> </Text>
            <Text bold>
              {lastCall ? `Last call: ${lastCall.tool} · ${duration(lastCall.ms)}` : 'Last call: none yet'}
            </Text>
            {links.map(link => (
              <Box flexDirection="row">
                <Text dimColor>{pad(link.plugin, 12)} </Text>
                <Text color={link.plugin === 'engine' ? 'cyan' : 'magenta'}>{pad(bar(link.ms, slowest, linkBar), linkBar)}</Text>
                <Text dimColor>{duration(link.ms).padStart(8)}</Text>
              </Box>
            ))}
            <Text bold>Tokens per model request</Text>
            <Text color="cyan">{sparkline(steps.slice(-(width - 2)).map(s => s.input + s.cached + s.output)) || ' '}</Text>
            <Text dimColor>
              {lastStep
                ? `last: ${short(lastStep.input)} in · ${short(lastStep.cached)} cached · ${short(lastStep.output)} out`
                : 'no requests yet'}
            </Text>
            <Text bold>Dollars per turn</Text>
            <Text color="yellow">{sparkline(turns.slice(-(width - 2)).map(t => t.usd)) || ' '}</Text>
            <Text dimColor>
              {lastTurn ? `last turn: $${lastTurn.usd.toFixed(3)} · ${turns.length} turns` : 'no turns yet'}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
