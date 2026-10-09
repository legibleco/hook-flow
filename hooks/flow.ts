// The flow chart: the agentic loop as boxes and arrows, each box lit in its
// color when one of its events fires, each arrow when the loop moves along it.
// Pure: the hooks module feeds it hits and draws the runs it returns.

export const FLOW_COLUMNS = 45
export const FLOW_ROWS = 15
const DEFAULT = 0x01000000
const IDLE_BORDER = 0x3d434b
const SEEN_BORDER = 0x5a6270
const LABEL = 0xb0b8c0
const FADE_MS = 600

type Node = { id: string; label: string; x: number; y: number; color: number; isSide?: boolean }

// Three columns of 13-cell boxes, 16 apart; rows of 3-cell boxes, 4 apart.
const col = (i: number) => i * 16
const row = (i: number) => i * 4

export const NODES: Node[] = [
  { id: 'prompt', label: 'prompt', x: col(0), y: row(0), color: 0xff6bcb },
  { id: 'context', label: 'context', x: col(1), y: row(0), color: 0xf368e0 },
  { id: 'turn', label: 'turn start', x: col(2), y: row(0), color: 0x48dbfb },
  { id: 'append', label: 'append', x: col(0), y: row(1), color: 0x1dd1a1 },
  { id: 'tool', label: 'tool call', x: col(1), y: row(1), color: 0xff9f43 },
  { id: 'model', label: 'model', x: col(2), y: row(1), color: 0x48dbfb },
  { id: 'agent', label: 'subagent', x: col(0), y: row(2), color: 0xfeca57, isSide: true },
  { id: 'perms', label: 'permission', x: col(1), y: row(2), color: 0xee5253 },
  { id: 'done', label: 'turn done', x: col(2), y: row(2), color: 0x0abde3 },
  { id: 'compact', label: 'compact', x: col(0), y: row(3), color: 0xa29bfe, isSide: true },
  { id: 'command', label: 'command', x: col(1), y: row(3), color: 0xc8d6e5, isSide: true },
  { id: 'ui', label: 'ui', x: col(2), y: row(3), color: 0x54a0ff, isSide: true },
]

// Which box an event lights; undefined for the events the chart leaves out.
export const nodeOf = (event: string): string | undefined => {
  if (event.startsWith('ui.')) return 'ui'
  switch (event) {
    case 'prompt.submit': return 'prompt'
    case 'prompt.compose':
    case 'prompt.section':
    case 'prompt.context':
    case 'prompt.attachment': return 'context'
    case 'turn.start': return 'turn'
    case 'turn.step': return 'model'
    case 'tool.call': return 'tool'
    case 'tool.check':
    case 'classic.PreToolUse':
    case 'classic.PermissionRequest': return 'perms'
    case 'session.append': return 'append'
    case 'turn.complete': return 'done'
    case 'agent.spawn': return 'agent'
    case 'session.compact': return 'compact'
    case 'command.run': return 'command'
    default: return undefined
  }
}

type Cell = [x: number, y: number, glyph: string]
type Edge = { from: string; to: string; cells: Cell[] }

const line = (glyph: string, y: number, x0: number, x1: number): Cell[] =>
  Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y, glyph] as Cell)

// Arrowheads sit on the border of the box they point into.
export const EDGES: Edge[] = [
  { from: 'prompt', to: 'context', cells: [...line('─', 1, 13, 14), [15, 1, '▶']] },
  { from: 'context', to: 'turn', cells: [...line('─', 1, 29, 30), [31, 1, '▶']] },
  { from: 'turn', to: 'model', cells: [[38, 2, '┬'], [38, 3, '│'], [38, 4, '▼']] },
  { from: 'model', to: 'tool', cells: [[29, 5, '◀'], ...line('─', 5, 30, 31)] },
  { from: 'tool', to: 'perms', cells: [[22, 6, '┬'], [22, 7, '┼'], [22, 8, '▼']] },
  { from: 'tool', to: 'append', cells: [[13, 5, '◀'], ...line('─', 5, 14, 15)] },
  {
    from: 'append',
    to: 'model',
    cells: [[6, 6, '┬'], [6, 7, '└'], ...line('─', 7, 7, 21), ...line('─', 7, 23, 34), [35, 7, '┘'], [35, 6, '▲']],
  },
  { from: 'model', to: 'done', cells: [[41, 6, '┬'], [41, 7, '│'], [41, 8, '▼']] },
]

const blend = (from: number, to: number, by: number): number => {
  const f = Math.max(0, Math.min(1, by))
  const mix = (shift: number) =>
    Math.round(((from >> shift) & 0xff) * (1 - f) + ((to >> shift) & 0xff) * f) << shift
  return mix(16) | mix(8) | mix(0)
}

const short = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`

export class Flow {
  hitAt = new Map<string, number>()
  edgeAt = new Map<string, number>()
  last: string | undefined

  // Lights the event's box, and the arrow from the box the loop was last in.
  // A permission check branches off its tool call: the loop stays at the tool.
  hit(event: string, now: number) {
    const id = nodeOf(event)
    if (!id) return
    this.hitAt.set(id, now)
    const node = NODES.find(n => n.id === id)
    if (node?.isSide) return
    if (this.last && this.last !== id) this.edgeAt.set(`${this.last}>${id}`, now)
    if (id !== 'perms') this.last = id
  }

  isHot(now: number): boolean {
    for (const at of [...this.hitAt.values(), ...this.edgeAt.values()]) if (now - at < FADE_MS) return true
    return false
  }

  // The chart as glyphs and colors, `columns` x FLOW_ROWS, centered;
  // `countOf` gives each box's count, `keyOf` the key that explains it, and
  // `selected` stays lit.
  grid(
    columns: number,
    now: number,
    countOf: (id: string) => number,
    keyOf: (id: string) => string = () => '',
    selected?: string,
  ): { glyphs: string[][]; colors: number[][] } {
    const glyphs = Array.from({ length: FLOW_ROWS }, () => Array.from({ length: columns }, () => ' '))
    const colors = Array.from({ length: FLOW_ROWS }, () => Array.from({ length: columns }, () => DEFAULT))
    const left = leftOf(columns)
    const put = (x: number, y: number, glyph: string, fg: number) => {
      const at = left + x
      const row = glyphs[y]
      const tint = colors[y]
      if (!row || !tint || at < 0 || at >= columns) return
      row[at] = glyph
      tint[at] = fg
    }
    const heat = (at: number | undefined) => (at === undefined ? 0 : Math.max(0, 1 - (now - at) / FADE_MS))

    for (const node of NODES) {
      const count = countOf(node.id)
      const glow = node.id === selected ? 1 : heat(this.hitAt.get(node.id))
      const rest = count > 0 ? SEEN_BORDER : IDLE_BORDER
      const border = blend(rest, node.color, glow)
      const text = blend(count > 0 ? LABEL : SEEN_BORDER, node.color, glow)
      const { x, y } = node
      const [tl, tr, bl, br, h, v] = node.isSide ? ['╭', '╮', '╰', '╯', '┄', '┆'] : ['┌', '┐', '└', '┘', '─', '│']
      put(x, y, tl, border)
      put(x + 12, y, tr, border)
      put(x, y + 2, bl, border)
      put(x + 12, y + 2, br, border)
      for (let i = 1; i < 12; i++) {
        put(x + i, y, h, border)
        put(x + i, y + 2, h, border)
      }
      put(x, y + 1, v, border)
      put(x + 12, y + 1, v, border)
      const label = node.label.slice(0, 11)
      for (let i = 0; i < label.length; i++) put(x + 1 + i, y + 1, label[i] ?? ' ', text)
      const key = keyOf(node.id)
      if (key) put(x + 1, y, key, blend(LABEL, node.color, Math.max(glow, 0.5)))
      // The count rides the top border's right end: `┌1─────── 14 ┐`.
      if (count > 0) {
        const number = ` ${short(count)} `
        const from = x + 12 - number.length
        for (let i = 0; i < number.length; i++) put(from + i, y, number[i] ?? ' ', blend(LABEL, 0xffffff, glow))
      }
    }

    for (const edge of EDGES) {
      const glow = heat(this.edgeAt.get(`${edge.from}>${edge.to}`))
      const to = NODES.find(n => n.id === edge.to)
      const fg = blend(SEEN_BORDER, to?.color ?? LABEL, glow)
      for (const [x, y, glyph] of edge.cells) put(x, y, glyph, fg)
    }
    return { glyphs, colors }
  }

  // The chart as rows of [text, color] runs, a run per stretch of one color:
  // what a Client draws as Text, `-1` for the terminal's own color.
  rows(...args: Parameters<Flow['grid']>): Run[][] {
    const { glyphs, colors } = this.grid(...args)
    return glyphs.map((row, y) => {
      const runs: Run[] = []
      row.forEach((glyph, x) => {
        const raw = colors[y]?.[x] ?? DEFAULT
        const color = raw === DEFAULT || glyph === ' ' ? -1 : raw
        const last = runs.at(-1)
        if (last && last[1] === color) last[0] += glyph
        else runs.push([glyph, color])
      })
      return runs
    })
  }
}

export type Run = [text: string, color: number]

const leftOf = (columns: number) => Math.max(0, Math.floor((columns - FLOW_COLUMNS) / 2))

// The box under a cell of the chart, as a click lands on it.
export const nodeAt = (x: number, y: number, columns: number): string | undefined => {
  const cx = x - leftOf(columns)
  return NODES.find(n => cx >= n.x && cx <= n.x + 12 && y >= n.y && y <= n.y + 2)?.id
}
