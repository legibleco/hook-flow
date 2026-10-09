import type { ClientModule } from 'claude-code'

// The flow chart and the timeline, drawn on the surface so a click or a
// hover can reach the hooks module. It draws the rows of runs it is handed
// and asks for fresh ones: every 50 ms while something moves, every half
// second at rest. A hover is posted when it reaches a new cell.

export type ChartProps = { rows: [string, number][][]; isHot: boolean }

let isHot = false

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`

const Chart: ClientModule<ChartProps, true> = (props, surface) => {
  const { Box, Text } = surface.elements
  isHot = props.isHot
  if (surface.state === undefined) {
    surface.setState(true)
    let ticks = 0
    surface.every(50, () => {
      ticks += 1
      if (isHot || ticks % 10 === 0) surface.post({ kind: 'frame' })
    })
    // No key listener: a click would hand this Client keys of its own, a
    // focus nobody can see. The hooks module asks for the pane's instead.
    let hoverAt = ''
    surface.onPointer(event => {
      if (event.type === 'down' && event.button === 'left') surface.post({ kind: 'click', x: event.x, y: event.y })
      if (event.type === 'move' && event.button === undefined && `${event.x},${event.y}` !== hoverAt) {
        hoverAt = `${event.x},${event.y}`
        surface.post({ kind: 'hover', x: event.x, y: event.y })
      }
      if (event.type === 'leave') {
        hoverAt = ''
        surface.post({ kind: 'hover', x: -1, y: -1 })
      }
    })
  }
  return (
    <Box flexDirection="column">
      {props.rows.map(runs => (
        <Box flexDirection="row">
          {runs.map(([text, color]) => (color < 0 ? <Text>{text}</Text> : <Text color={hex(color)}>{text}</Text>))}
        </Box>
      ))}
    </Box>
  )
}

export default Chart
