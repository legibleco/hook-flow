// The span timeline: one turn laid out in time, a row per box of the flow
// chart, each event a bar from when its hook started to when it returned.
// Pure: the hooks module records the spans and draws the runs this returns.

import { NODES } from './flow'
import type { Run } from './flow'

export type Span = {
  id: number
  event: string
  node: string
  detail: string
  start: number
  end?: number
  bytes: number
  plugins: string[]
}

export const LABEL_WIDTH = 9
const MAX_LANES = 3
const DIM = 0x5a6270
const AXIS = 0x7f8c8d

// The loop's boxes, always shown so an empty row says "didn't happen";
// the side boxes only when the turn used them.
const MAIN = ['prompt', 'context', 'turn', 'model', 'tool', 'perms', 'append', 'done']
const SIDE = ['agent', 'compact', 'command']
const LABELS: Record<string, string> = {
  prompt: 'prompt', context: 'context', turn: 'turn', model: 'model', tool: 'tool', perms: 'perms',
  append: 'append', done: 'done', agent: 'subagent', compact: 'compact', command: 'command',
}

type Row = { node: string; lane: number }
type Placed = { span: Span; row: number; x0: number; x1: number }
export type Window = { t0: number; t1: number }
export type Layout = { rows: Row[]; placed: Placed[]; t0: number; t1: number; field: number; whole: Window }

// The whole turn, first start to last end; an open span runs to `now`.
export const wholeOf = (spans: readonly Span[], now: number): Window => {
  const t0 = spans[0]?.start ?? now
  return { t0, t1: Math.max(t0 + 1, ...spans.map(s => s.end ?? now)) }
}

// Rows, and each span's cells: a lane per span that would touch another in
// its row, up to three, the rest drawn over the last. Zoomed to a window,
// only the spans in it are laid out, those crossing its edges cut there.
export const layout = (spans: readonly Span[], columns: number, now: number, zoom?: Window): Layout => {
  const field = Math.max(1, columns - LABEL_WIDTH)
  const whole = wholeOf(spans, now)
  const { t0, t1 } = zoom ?? whole
  const at = (t: number) => Math.max(0, Math.min(field - 1, Math.floor(((t - t0) / (t1 - t0)) * field)))
  const shown = spans.filter(s => s.start <= t1 && (s.end ?? now) >= t0)
  const nodes = [...MAIN, ...SIDE.filter(id => spans.some(s => s.node === id))]
  const rows: Row[] = []
  const placed: Placed[] = []
  for (const node of nodes) {
    const ends: number[] = []
    const first = rows.length
    for (const span of shown.filter(s => s.node === node)) {
      const x0 = at(span.start)
      const x1 = Math.max(x0, at(span.end ?? now))
      let lane = ends.findIndex(end => x0 > end + 1)
      if (lane < 0) lane = ends.length < MAX_LANES ? ends.length : MAX_LANES - 1
      ends[lane] = Math.max(ends[lane] ?? -2, x1)
      placed.push({ span, row: first + lane, x0, x1 })
    }
    const lanes = Math.max(1, ends.length)
    for (let lane = 0; lane < lanes; lane++) rows.push({ node, lane })
  }
  return { rows, placed, t0, t1, field, whole }
}

// Zooms by `factor` (below 1 in, above 1 out) keeping the time at `anchor`,
// a fraction of the window, where it is; out to the whole turn, no window.
export const zoomBy = (zoom: Window | undefined, whole: Window, factor: number, anchor = 0.5): Window | undefined => {
  const { t0, t1 } = zoom ?? whole
  const width = Math.max(5, (t1 - t0) * factor)
  if (width >= whole.t1 - whole.t0) return undefined
  const at = t0 + anchor * (t1 - t0)
  const from = Math.max(whole.t0, Math.min(whole.t1 - width, at - anchor * width))
  return { t0: from, t1: from + width }
}

// The window moved just enough to show a span, its width kept.
export const follow = (zoom: Window | undefined, span: Span, now: number): Window | undefined => {
  if (!zoom) return undefined
  const end = span.end ?? now
  if (span.start >= zoom.t0 && end <= zoom.t1) return zoom
  const width = zoom.t1 - zoom.t0
  const t0 = span.start - width / 2 + Math.min(width, end - span.start) / 2
  return { t0, t1: t0 + width }
}

// The rows a timeline takes: its lanes plus the time axis.
export const heightOf = (shape: Layout) => shape.rows.length + 1

// Every span under a cell, latest first; a click or a hover lands here.
export const spansAt = (shape: Layout, x: number, y: number): Span[] => {
  const cx = x - LABEL_WIDTH
  return shape.placed
    .filter(p => p.row === y && cx >= p.x0 && cx <= p.x1)
    .map(p => p.span)
    .reverse()
}

// The spans that ran inside one: its own work and what it waited on.
export const insideOf = (spans: readonly Span[], outer: Span, now: number): Span[] =>
  spans.filter(s => s !== outer && s.start >= outer.start && (s.end ?? now) <= (outer.end ?? now))

const blend = (from: number, to: number, by: number): number => {
  const mix = (shift: number) =>
    Math.round(((from >> shift) & 0xff) * (1 - by) + ((to >> shift) & 0xff) * by) << shift
  return mix(16) | mix(8) | mix(0)
}

export const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

// The timeline as rows of [text, color] runs. With a span in focus (hovered
// or pinned) it and everything inside it light up; the rest dims.
export const timelineRows = (
  spans: readonly Span[],
  shape: Layout,
  columns: number,
  now: number,
  focus?: Span,
): Run[][] => {
  const color = (node: string) => NODES.find(n => n.id === node)?.color ?? 0xdfe6e9
  const lit = new Set(focus ? [focus, ...insideOf(spans, focus, now)] : [])
  const glyphs = shape.rows.map(() => Array.from({ length: columns }, () => ' '))
  const colors = shape.rows.map(() => Array.from({ length: columns }, () => -1))
  shape.rows.forEach((row, y) => {
    if (row.lane > 0) return
    const label = (LABELS[row.node] ?? row.node).padEnd(LABEL_WIDTH - 1).slice(0, LABEL_WIDTH - 1)
    const isLit = focus !== undefined && [...lit].some(s => s.node === row.node)
    for (let i = 0; i < label.length; i++) {
      glyphs[y]![i] = label[i]!
      colors[y]![i] = isLit ? color(row.node) : spans.some(s => s.node === row.node) ? AXIS : DIM
    }
    glyphs[y]![LABEL_WIDTH - 1] = '│'
    colors[y]![LABEL_WIDTH - 1] = DIM
  })
  shape.rows.forEach((row, y) => {
    if (row.lane === 0) return
    glyphs[y]![LABEL_WIDTH - 1] = '│'
    colors[y]![LABEL_WIDTH - 1] = DIM
  })
  // Lit spans draw last, so a stack shows the one in focus.
  const order = [...shape.placed].sort((a, b) => Number(lit.has(a.span)) - Number(lit.has(b.span)))
  for (const { span, row, x0, x1 } of order) {
    const base = color(span.node)
    const fg = span === focus ? blend(base, 0xffffff, 0.55) : lit.has(span) ? base : focus ? blend(base, 0x000000, 0.6) : blend(base, 0x000000, 0.15)
    const isOpen = span.end === undefined
    for (let x = x0; x <= x1; x++) {
      glyphs[row]![LABEL_WIDTH + x] = isOpen && x === x1 ? '▶' : x1 === x0 ? '▌' : '█'
      colors[row]![LABEL_WIDTH + x] = fg
    }
  }
  // The axis reads in time since the turn began: `0` to its length, or the
  // window's edges and how far it is zoomed.
  const from = shape.t0 - shape.whole.t0
  const isZoomed = shape.t1 - shape.t0 < shape.whole.t1 - shape.whole.t0
  const left = isZoomed ? `+${seconds(from)}` : '0'
  const ratio = (shape.whole.t1 - shape.whole.t0) / (shape.t1 - shape.t0)
  const zoomed = isZoomed ? ` ${ratio < 10 ? ratio.toFixed(1).replace(/\.0$/, '') : Math.round(ratio)}× ` : ''
  const right = isZoomed ? `+${seconds(shape.t1 - shape.whole.t0)}` : seconds(shape.t1 - shape.t0)
  const rule = Math.max(0, shape.field - left.length - right.length - zoomed.length)
  const axis = `${' '.repeat(LABEL_WIDTH - 1)}└${left}${'─'.repeat(Math.floor(rule / 2))}${zoomed}${'─'.repeat(Math.ceil(rule / 2))}${right}`
  const rows: Run[][] = glyphs.map((line, y) => {
    const runs: Run[] = []
    line.forEach((glyph, x) => {
      const c = glyph === ' ' ? -1 : colors[y]![x]!
      const last = runs.at(-1)
      if (last && last[1] === c) last[0] += glyph
      else runs.push([glyph, c])
    })
    return runs
  })
  rows.push([[axis.slice(0, columns), AXIS]])
  return rows
}
