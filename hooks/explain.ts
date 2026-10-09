// What each box of the flow chart stands for, for the explain panel: what
// happens there, its events, what a hook can do, and the hook that would.

export type Explainer = {
  key: string
  title: string
  what: string
  events: string
  can: string
  snippet: string
}

export const EXPLAIN: Record<string, Explainer> = {
  prompt: {
    key: '1',
    title: 'Prompt submitted',
    what: 'You pressed Enter. Your text becomes the next user message.',
    events: 'prompt.submit',
    can: 'Rewrite the text before the model sees it, or drop the prompt.',
    snippet: "on('prompt.submit', ($, e, next) =>\n  next({ ...e, text: e.text.trim() }))",
  },
  context: {
    key: '2',
    title: 'Context assembled',
    what: 'The system prompt is composed from sections, and context blocks are attached.',
    events: 'prompt.compose, prompt.section, prompt.context, prompt.attachment',
    can: 'Add, replace, reorder or drop system prompt sections.',
    snippet: "on('prompt.compose', async ($, e, next) => {\n  const { sections } = await next(e)\n  return { sections: [...sections, mine] }\n})",
  },
  turn: {
    key: '3',
    title: 'Turn started',
    what: 'A model turn begins: the loop of requests and tool calls that answers you.',
    events: 'turn.start',
    can: 'Observe only: start a timer, reset a counter.',
    snippet: "on('turn.start', async ($, e, next) => {\n  startedAt = await $.clock.now()\n  return next(e)\n})",
  },
  model: {
    key: '4',
    title: 'Model request',
    what: 'One API call. The reply streams back as text and tool calls; its usage is the tokens you pay for.',
    events: 'turn.step (streams)',
    can: 'Read or rewrite the streamed chunks, and read the token usage.',
    snippet: "on('turn.step', async function* ($, e, next) {\n  const result = yield* next(e)\n  log(result.usage)\n  return result\n})",
  },
  tool: {
    key: '5',
    title: 'Tool call',
    what: 'The model asked for a tool (Bash, Read, Edit…). It runs here, unless a hook or a permission check stops it.',
    events: 'tool.call',
    can: 'Refuse it, rewrite its input, or act on its result.',
    snippet: "on('tool.call', { tool: 'Bash' }, ($, e, next) =>\n  e.command.includes('rm -rf')\n    ? { deny: 'not here' }\n    : next(e))",
  },
  perms: {
    key: '6',
    title: 'Permission check',
    what: 'Rules, your permission mode and settings hooks decide: allow, ask you, or deny.',
    events: 'classic.PreToolUse, tool.check',
    can: 'Return your own decision: allow, ask or deny.',
    snippet: "on('tool.check', { tool: 'Read' }, () =>\n  ({ decision: 'allow' }))",
  },
  append: {
    key: '7',
    title: 'Transcript row',
    what: 'A message or tool result is written to the conversation. This is what the model reads on its next request.',
    events: 'session.append',
    can: 'Rewrite what is stored and sent, e.g. trim a huge tool result.',
    snippet: "on('session.append', ($, e, next) =>\n  next({ ...e, message: trimmed(e.message) }))",
  },
  done: {
    key: '8',
    title: 'Turn complete',
    what: 'The model stopped asking for tools and answered. The loop ends until your next prompt.',
    events: 'turn.complete',
    can: 'Show a line beneath the answer, or react: a toast, the cost.',
    snippet: "on('turn.complete', async ($, e, next) => {\n  const done = await next(e)\n  $.ui.toast('done')\n  return done\n})",
  },
  agent: {
    key: 'a',
    title: 'Subagent spawned',
    what: 'The Agent tool started a subagent: a whole loop of its own, nested inside this tool call.',
    events: 'agent.spawn',
    can: 'Refuse the spawn or pick its model.',
    snippet: "on('agent.spawn', ($, e, next) =>\n  next({ ...e, model: 'haiku' }))",
  },
  compact: {
    key: 'c',
    title: 'Compaction',
    what: 'The conversation is summarized to free up the context window.',
    events: 'session.compact',
    can: 'Change the summary instructions, or skip compacting.',
    snippet: "on('session.compact', ($, e, next) =>\n  next({ ...e, instructions: 'keep decisions' }))",
  },
  command: {
    key: 's',
    title: 'Slash command',
    what: 'A /command ran: built in, or registered by a plugin.',
    events: 'command.run',
    can: 'Answer a command yourself, or change what one prints.',
    snippet: "on('command.run', { command: 'flow' }, () =>\n  ({ text: 'hello' }))",
  },
  ui: {
    key: 'i',
    title: 'UI',
    what: 'The screen draws: messages, tool rows, the spinner, panes. It runs alongside everything else.',
    events: 'ui.render, ui.press, ui.scroll…',
    can: 'Draw your own tree for a site, like this pane.',
    snippet: "on('ui.render', { component: 'Pane', requestId: id },\n  ($, e) => <Text>hi</Text>)",
  },
}

export const NODE_BY_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(EXPLAIN).map(([id, one]) => [one.key, id]),
)
