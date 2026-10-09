import { expect, test } from 'claude-code/testing'

import { ORDER, bar, fromSnapshot, lastTurnSteps, note, record, reset, sparkline, stats, stepFrom, toSnapshot, chartProps, startSpan, endSpan, pinFrom } from './register'
import * as hookFlow from './register'
import { LABEL_WIDTH, follow, insideOf, layout, spansAt, timelineRows, zoomBy } from './timeline'
import type { Span } from './timeline'
import { EXPLAIN, NODE_BY_KEY } from './explain'
import { FLOW_COLUMNS, FLOW_ROWS, Flow, NODES, nodeAt, nodeOf } from './flow'

const PANE_PROPS = {
  title: 'Hook flow', isFocused: false, bodyColumns: 48, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 }, view: {},
}

test('sparkline scales to the tallest bar and leaves zeros blank', () => {
  expect(sparkline([0, 1, 2, 4])).toBe(' ▂▄█')
})

test('record counts, times and buckets an event', () => {
  reset()
  record('tool.call', 30, 2048, ['guard'], 5_000)
  record('tool.call', 10, 1024, [], 5_500)
  const one = stats.get('tool.call')
  expect(one?.n).toBe(2)
  expect(one?.ms).toBe(40)
  expect(one?.perSecond.get(5)).toBe(2)
  expect([...(one?.plugins ?? [])]).toEqual(['guard'])
})

test('events that flow through the engine show up in the pane', async ($, on) => {
  reset()
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x.txt' })

  const pane = await $.ui.mount({
    plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow', props: PANE_PROPS,
  })
  expect(await pane.find({ type: 'Text', text: /^tool\.call/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /^classic\.PreToolUse/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /^Last call: Read · / })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /prompt/, in: 'chart' })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: 'no requests yet' })).toBeTruthy()
})

test('counts survive a snapshot round trip, as across the UI toggle reload', () => {
  reset()
  record('tool.call', 30, 2048, ['guard'], 5_000)
  const saved = JSON.parse(JSON.stringify(toSnapshot()))
  reset()
  fromSnapshot(saved)
  expect(stats.get('tool.call')?.n).toBe(1)
  expect(stats.get('tool.call')?.perSecond.get(5)).toBe(1)
  expect([...(stats.get('tool.call')?.plugins ?? [])]).toEqual(['guard'])
})

for (const watchUi of [false, true]) {
  test(`the ui button reads ${watchUi ? 'on' : 'off'} with watchUi ${watchUi}`, { options: { watchUi } }, async $ => {
    const pane = await $.ui.mount({
      plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow', props: PANE_PROPS,
    })
    expect(await pane.find({ type: 'Button', key: 'ui', text: watchUi ? 'ui: on' : 'ui: off' })).toBeTruthy()
  })
}

test('bars fill in eighths and clamp at the top', () => {
  expect(bar(50, 100, 4)).toBe('██')
  expect(bar(1, 8, 1)).toBe('▏')
  expect(bar(500, 100, 3)).toBe('███')
})

test('events map onto the chart boxes', () => {
  expect(nodeOf('turn.step')).toBe('model')
  expect(nodeOf('prompt.section')).toBe('context')
  expect(nodeOf('classic.PreToolUse')).toBe('perms')
  expect(nodeOf('ui.render')).toBe('ui')
  expect(nodeOf('fs.read')).toBe(undefined)
})

test('the loop lights its arrows, a permission check branching off the tool', () => {
  const flow = new Flow()
  for (const [i, event] of ['turn.step', 'tool.call', 'classic.PreToolUse', 'session.append', 'turn.step'].entries()) {
    flow.hit(event, 1_000 + i)
  }
  expect([...flow.edgeAt.keys()]).toEqual(['model>tool', 'tool>perms', 'tool>append', 'append>model'])
  expect(flow.isHot(1_100)).toBe(true)
  expect(flow.isHot(5_000)).toBe(false)
})

test('the chart draws its boxes and counts', () => {
  const flow = new Flow()
  flow.hit('tool.call', 0)
  const lines = flow.grid(FLOW_COLUMNS, 0, id => (id === 'tool' ? 14 : 0)).glyphs.map(row => row.join(''))
  expect(lines[4]).toContain('─ 14 ┐')
  expect(lines[5]).toContain('│tool call  │')
  expect(lines[1]).toContain('prompt')
})

test('every box has an explainer under its own key', () => {
  for (const node of NODES) expect(EXPLAIN[node.id]).toBeTruthy()
  expect(Object.keys(NODE_BY_KEY).length).toBe(NODES.length)
  expect(NODE_BY_KEY['5']).toBe('tool')
})

test('a prompt starts a recording and the turn completing files it for replay', () => {
  const events = ['prompt.submit', 'turn.start', 'turn.step', 'tool.call', 'session.append', 'turn.step', 'turn.complete']
  events.forEach((event, i) => note(event, event === 'tool.call' ? 'Bash' : '', i))
  note('fs.read', '', 99)
  expect(lastTurnSteps.map(s => s.node)).toEqual(['prompt', 'turn', 'model', 'tool', 'append', 'model', 'done'])
  expect(lastTurnSteps[3]?.detail).toBe('Bash')
})

test('explain mode swaps the stats for the box list and its details', async $ => {
  const pane = await $.ui.mount({
    plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow', props: PANE_PROPS,
  })
  expect(await pane.find({ type: 'Text', text: 'Tokens per model request' })).toBeTruthy()
  expect(await pane.find({ type: 'Button', key: 'explain:tool' })).toBeFalsy()
  await $.ui.press({ plugin: 'hook-flow', key: 'explain' })
  await $.ui.press({ plugin: 'hook-flow', key: 'explain:tool' })
  expect(await pane.find({ type: 'Text', text: /^Tool call$/ })).toBeTruthy()
  expect(await pane.find({ type: 'Code', text: /deny/ })).toBeTruthy()
  expect(await pane.find({ type: 'Button', key: 'explain:model', text: /4 model/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: 'Tokens per model request' })).toBeFalsy()
  await $.ui.press({ plugin: 'hook-flow', key: 'explain:model' })
  expect(await pane.find({ type: 'Text', text: /^Model request$/ })).toBeTruthy()
  await $.ui.press({ plugin: 'hook-flow', key: 'close' })
  expect(await pane.find({ type: 'Text', text: 'Tokens per model request' })).toBeTruthy()
})

test('arrows step through the boxes in loop order, wrapping at the ends', () => {
  expect(ORDER.slice(0, 5)).toEqual(['prompt', 'context', 'turn', 'model', 'tool'])
  expect(stepFrom('model', 1)).toBe('tool')
  expect(stepFrom('model', -3)).toBe('turn')
  expect(stepFrom('prompt', -1)).toBe('ui')
  expect(stepFrom('ui', 1)).toBe('prompt')
})

test('in explain mode a scroll key moves the selection; the wheel still scrolls', async $ => {
  const pane = await $.ui.mount({
    plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow', props: PANE_PROPS,
  })
  await $.ui.press({ plugin: 'hook-flow', key: 'explain' })
  expect(await pane.find({ type: 'Text', text: /^Prompt submitted$/ })).toBeTruthy()
  const key = { component: 'Pane', requestId: 'hook-flow', offset: 1, by: 1, bodyRows: 30, contentRows: 60, origin: { kind: 'person' } } as const
  await $.ui.scroll(key)
  expect(await pane.find({ type: 'Text', text: /^Context assembled$/ })).toBeTruthy()
  await $.ui.scroll({ ...key, by: -1, offset: 0 })
  await $.ui.scroll({ ...key, by: -1, offset: 0 })
  expect(await pane.find({ type: 'Text', text: /^UI$/ })).toBeTruthy()
})

test('a click lands on the box under it', () => {
  // A 48-column pane centers the 45-column chart one cell in.
  expect(nodeAt(1, 0, 48)).toBe('prompt')
  expect(nodeAt(20, 5, 48)).toBe('tool')
  expect(nodeAt(14, 1, 48)).toBe(undefined)
  expect(nodeAt(40, 13, 48)).toBe('ui')
})

test('the chart arrives as color runs, a run per stretch of one color', () => {
  const rows = new Flow().rows(FLOW_COLUMNS, 0, () => 0)
  expect(rows.length).toBe(FLOW_ROWS)
  expect(rows[1]?.map(([text]) => text).join('')).toContain('prompt')
  expect(rows.every(row => row.map(([text]) => text).join('').length === FLOW_COLUMNS)).toBe(true)
})

test('clicking a box in the chart opens its explainer', async $ => {
  const pane = await $.ui.mount({
    plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow', props: PANE_PROPS,
  })
  await pane.pointer({ type: 'down', x: 20, y: 5, button: 'left', in: 'chart' })
  expect(await pane.find({ type: 'Text', text: /^Tool call$/ })).toBeTruthy()
  await pane.pointer({ type: 'down', x: 3, y: 1, button: 'left', in: 'chart' })
  expect(await pane.find({ type: 'Text', text: /^Prompt submitted$/ })).toBeTruthy()
})

test('the chart shows no jump keys outside explain mode', () => {
  const text = chartProps(45, 0).rows.map(runs => runs.map(([t]) => t).join('')).join('\n')
  expect(text).toContain('┌────')
  expect(text).not.toContain('┌1')
})

const span = (id: number, event: string, start: number, end?: number): Span => ({
  id, event, node: nodeOf(event) ?? '', detail: '', start, end, bytes: 0, plugins: [],
})

test('the timeline lays spans out in time, a row per box, overlaps in lanes', () => {
  const spans = [
    span(1, 'prompt.submit', 0, 10),
    span(2, 'turn.start', 10, 20),
    span(3, 'turn.step', 20, 500),
    span(4, 'tool.call', 500, 900),
    span(5, 'tool.call', 520, 880),
    span(6, 'tool.check', 510, 520),
    span(7, 'turn.complete', 990, 1000),
  ]
  const shape = layout(spans, 59, 1000)
  const tools = shape.rows.filter(r => r.node === 'tool')
  expect(tools.length).toBe(2)
  expect(shape.rows[0]?.node).toBe('prompt')
  expect(shape.rows.some(r => r.node === 'agent')).toBe(false)
  const model = shape.placed.find(p => p.span.id === 3)!
  expect(model.x0).toBe(1)
  expect(model.x1).toBe(25)
  const row = shape.rows.findIndex(r => r.node === 'model')
  expect(spansAt(shape, LABEL_WIDTH + 10, row).map(s => s.id)).toEqual([3])
  expect(insideOf(spans, spans[3]!, 1000).map(s => s.id)).toEqual([5, 6])
  const rows = timelineRows(spans, shape, 59, 1000, spans[3])
  expect(rows.length).toBe(shape.rows.length + 1)
  expect(rows.at(-1)?.[0]?.[0]).toContain('1.0s')
})

test('a prompt starts the recording and the turn completing ends it', () => {
  expect(startSpan('tool.call', 'Read', 1)).toBeUndefined()
  const prompt = startSpan('prompt.submit', '', 10)
  endSpan(prompt, 5, [], 12)
  endSpan(startSpan('turn.start', '', 13), 0, [], 14)
  const tool = startSpan('tool.call', 'Read', 20)
  endSpan(tool, 100, ['guard'], 40)
  endSpan(startSpan('turn.complete', '', 50), 0, [], 51)
  expect(startSpan('tool.call', 'Bash', 60)).toBeUndefined()
  expect(hookFlow.spans.map(s => s.event)).toEqual(['prompt.submit', 'turn.start', 'tool.call', 'turn.complete'])
  expect(tool?.end).toBe(40)
  pinFrom(1)
  pinFrom(1)
  expect(hookFlow.timelineProps(59, 60).rows.at(-1)?.[0]?.[0]).toMatch(/^turn\.start/)
})

test('the timeline view lights the span under the pointer and pins it on a click', async ($, on) => {
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } }).catch(() => undefined)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x.txt' })
  const pane = await $.ui.mount({
    plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow', props: PANE_PROPS,
  })
  await $.ui.press({ plugin: 'hook-flow', key: 'view' })
  expect(await pane.find({ type: 'Text', text: /hover a bar/, in: 'chart' })).toBeTruthy()
  // The turn is still open here, so the axis keeps stretching: find the tool
  // bar's cell as it is drawn now, then hover it.
  const row = 4 // prompt, context, turn, model, tool
  const toolBar = async () => {
    const texts = (await pane.findAll({ type: 'Text', in: 'chart' })).map(t => String(t.text))
    return texts.slice(texts.indexOf('tool'), texts.indexOf('perms')).join('').search(/[▌█]/)
  }
  let isLit = false
  for (let attempt = 0; attempt < 20 && !isLit; attempt++) {
    await pane.pointer({ type: 'move', x: await toolBar(), y: row, in: 'chart' })
    isLit = Boolean(await pane.find({ type: 'Text', text: /^tool\.call · Read/, in: 'chart' }))
  }
  expect(isLit).toBe(true)
  let isPinned = false
  for (let attempt = 0; attempt < 20 && !isPinned; attempt++) {
    await pane.pointer({ type: 'down', x: await toolBar(), y: row, button: 'left', in: 'chart' })
    isPinned = Boolean(await pane.find({ type: 'Text', text: /· Tool call$/ }))
  }
  expect(isPinned).toBe(true)
  expect(await pane.find({ type: 'Button', key: 'span:next' })).toBeTruthy()
})

test('zooming keeps the anchor in place and stops at the whole turn', () => {
  const whole = { t0: 0, t1: 1000 }
  const half = zoomBy(undefined, whole, 0.5, 0.5)
  expect(half).toEqual({ t0: 250, t1: 750 })
  expect(zoomBy(undefined, whole, 0.5, 0)).toEqual({ t0: 0, t1: 500 })
  expect(zoomBy(half, whole, 2, 0.5)).toBeUndefined()
  // Near an edge the window slides inside the turn rather than past it.
  expect(zoomBy({ t0: 900, t1: 1000 }, whole, 1.5, 1)).toEqual({ t0: 850, t1: 1000 })
  expect(zoomBy(undefined, whole, 0.001)).toEqual({ t0: 497.5, t1: 502.5 })
  const late = span(9, 'tool.call', 800, 820)
  expect(follow({ t0: 0, t1: 100 }, late, 1000)).toEqual({ t0: 760, t1: 860 })
  expect(follow(undefined, late, 1000)).toBeUndefined()
})

test('a zoomed layout shows only the window, spans cut at its edges', () => {
  const spans = [span(1, 'turn.step', 0, 500), span(2, 'tool.call', 500, 600), span(3, 'turn.step', 600, 1000)]
  const shape = layout(spans, 49, 1000, { t0: 450, t1: 650 })
  expect(shape.placed.find(p => p.span.id === 2)).toMatchObject({ x0: 10, x1: 30 })
  expect(shape.placed.find(p => p.span.id === 1)).toMatchObject({ x0: 0 })
  expect(layout(spans, 49, 1000, { t0: 700, t1: 800 }).placed.map(p => p.span.id)).toEqual([3])
  const axis = timelineRows(spans, shape, 49, 1000).at(-1)?.[0]?.[0] ?? ''
  expect(axis).toContain('+450ms')
  expect(axis).toContain(' 5× ')
})

test('the zoom keys and the wheel over the timeline zoom it', async ($, on) => {
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } }).catch(() => undefined)
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x.txt' })
  const pane = await $.ui.mount({
    plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow', props: PANE_PROPS,
  })
  await $.ui.press({ plugin: 'hook-flow', key: 'view' })
  expect(await pane.find({ type: 'Button', key: 'zoom:fit' })).toBeFalsy()
  await $.ui.press({ plugin: 'hook-flow', key: 'zoom:in' })
  // The turn is still open here, so the whole keeps growing past the window.
  expect(await pane.find({ type: 'Text', text: / [\d.]+× /, in: 'chart' })).toBeTruthy()
  await $.ui.press({ plugin: 'hook-flow', key: 'zoom:fit' })
  expect(await pane.find({ type: 'Text', text: /×/, in: 'chart' })).toBeFalsy()
  const wheel = {
    component: 'Pane', requestId: 'hook-flow', offset: 0, by: -1, bodyRows: 40, contentRows: 60,
    origin: { kind: 'person' }, pointer: { column: 30, row: 4 },
  } as const
  expect(await $.ui.scroll(wheel)).toEqual({})
  expect(await pane.find({ type: 'Text', text: / [\d.]+× /, in: 'chart' })).toBeTruthy()
})

test('a click on the chart asks for the pane\'s keys; the badge shows the pane\'s focus', async ($, on) => {
  const asked: unknown[] = []
  on('ui.open', ($, e, next) => {
    asked.push(e.focus)
    return next(e)
  })
  const pane = await $.ui.mount({
    plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow', props: PANE_PROPS,
  })
  expect(await pane.find({ type: 'Text', text: 'click for keys' })).toBeTruthy()
  await pane.pointer({ type: 'down', x: 0, y: 14, button: 'left', in: 'chart' })
  expect(asked).toContain(true)
  await pane.unmount()
  const focused = await $.ui.mount({
    plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow',
    props: { ...PANE_PROPS, isFocused: true },
  })
  expect(await focused.find({ type: 'Text', text: / keys · esc / })).toBeTruthy()
})

test('switching views keeps the one chart Client', async $ => {
  const pane = await $.ui.mount({
    plugin: 'hook-flow', surface: 'terminal', component: 'Pane', requestId: 'hook-flow', props: PANE_PROPS,
  })
  expect(await pane.find({ type: 'Text', text: /prompt/, in: 'chart' })).toBeTruthy()
  await $.ui.press({ plugin: 'hook-flow', key: 'view' })
  expect(await pane.find({ type: 'Text', text: /└/, in: 'chart' })).toBeTruthy()
})
