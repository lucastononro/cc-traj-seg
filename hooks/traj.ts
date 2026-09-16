// The pure parts of cc-traj-seg: the trajectory as steps, the window handed to the model, the
// system prompt, the reply protocol (SKIP, AMEND, NEW with a title and a summary) and the /traj
// argument parser. The hooks module wires these to the engine.

export type ToolUse = { tool_use_id?: string; tool: string; input: Record<string, unknown>; text?: string; isError?: true }
export type Message = { role: 'user' | 'assistant'; text: string; toolUses: ToolUse[]; toolResults?: unknown[] }
// one step is one action of the trajectory: a prompt the person typed, an assistant message with
// text, or one tool call with what came back. `id` is the tool row's id, an anchor in the transcript.
export type Step = { i: number; kind: 'user' | 'assistant' | 'tool'; line: string; id?: string; text?: string }
export type Segment = {
  n: number; from: number; to: number; at: number; model: string
  title: string; summary: string
  steps: string[]        // the step lines the segment covers, for the detail view
  anchor?: string        // a tool row's id at the start of the segment, to scroll the transcript to
  anchorText?: string    // else the start of the first message's text, matched to a rendered row
  amended?: number
}
export type Decision = { kind: 'skip' } | { kind: 'amend' | 'new'; title: string; summary: string }
export type Settings = { model: string; every: number; window: number }

export const DEFAULTS: Settings = { model: 'haiku', every: 10, window: 40 }
export const LIMITS = { every: [1, 500], window: [5, 400] } as const
const STEP_LINE = 200
const STEPS_KEPT = 80

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

// a tool call as `Bash(git status) → ok: 3 files changed`: the argument that says what it did and
// the start of what came back
export function toolLine(t: ToolUse): string {
  const i = t.input
  const arg = typeof i.command === 'string' ? i.command
    : typeof i.file_path === 'string' ? i.file_path.split('/').slice(-2).join('/')
    : typeof i.pattern === 'string' ? i.pattern
    : typeof i.query === 'string' ? i.query
    : typeof i.url === 'string' ? i.url
    : typeof i.description === 'string' ? i.description
    : typeof i.prompt === 'string' ? i.prompt
    : ''
  const result = t.text === undefined ? '' : ` → ${t.isError ? 'error' : 'ok'}: ${cut(oneLine(t.text), 100)}`
  return `${t.tool}(${cut(oneLine(arg), 80)})${result}`
}

// the transcript flattened to steps, numbered from 1
export function steps(ms: Message[], textChars = 400): Step[] {
  const out: Step[] = []
  for (const m of ms) {
    const text = oneLine(m.text)
    if (m.role === 'user') {
      if (text !== '') out.push({ i: out.length + 1, kind: 'user', line: cut(text, textChars), text })
      continue
    }
    if (text !== '') out.push({ i: out.length + 1, kind: 'assistant', line: cut(text, textChars), text })
    for (const t of m.toolUses) out.push({ i: out.length + 1, kind: 'tool', line: toolLine(t), id: t.tool_use_id })
  }
  return out
}

export const due = (count: number, last: number, every: number) => count - last >= Math.max(1, every)

// the anchor of a stretch: the first step's tool row, else the first message's text
export function anchorOf(all: Step[], from: number, to: number): { anchor?: string; anchorText?: string } {
  const range = all.filter(s => s.i >= from && s.i <= to)
  const first = range[0]
  if (!first) return {}
  if (first.id) return { anchor: first.id }
  if (first.text) return { anchorText: first.text.slice(0, 200) }
  const tool = range.find(s => s.id)
  return tool ? { anchor: tool.id } : {}
}

export const stepLines = (all: Step[], from: number, to: number) =>
  all.filter(s => s.i >= from && s.i <= to).map(s => cut(`[${s.i} ${s.kind}] ${s.line}`, STEP_LINE)).slice(-STEPS_KEPT)

export const SYSTEM = [
  'You segment the trajectory of a coding agent into phases, for the engineer supervising it from a narrow side panel.',
  'You get the segments you wrote before and the most recent steps of the trajectory; the steps after the NEW STEPS marker arrived since the last segment.',
  'Decide one of three things. SKIP: the new steps continue the current segment and change nothing worth saying. AMEND: they continue it, but its title or summary should change (progress, a result, a blocker). NEW: the agent moved to a different action or path.',
  'Reply with the decision word alone on the first line. For AMEND or NEW add two more lines: "TITLE: " and one clause under 80 characters saying what the agent is doing right now, present tense, concrete; then "SUMMARY: " and one paragraph of two to five sentences on the path: why, what it tried, what came back, what is left.',
  'Plain text, no markdown. Files by basename, commands by first word, tests by result. Actions over chatter. Never restate what an earlier segment already says. When in doubt, SKIP.',
].join(' ')

// what the model reads: the earlier segments, then the last `window` steps with a marker before
// the ones that are new since the last segment
export function prompt(segments: Segment[], all: Step[], last: number, window: number): string {
  const earlier = segments.length === 0 ? '(none yet: the first reply is NEW)'
    : [...segments].reverse().map(s => `#${s.n} (steps ${s.from}-${s.to}) ${s.title}\n${s.summary}`).join('\n\n')
  const tail = all.slice(Math.max(0, all.length - window))
  const lines: string[] = []
  if (tail.length > 0 && tail[0].i > last + 1) lines.push('--- NEW STEPS (earlier ones cut) ---')
  for (const s of tail) {
    if (s.i === last + 1) lines.push('--- NEW STEPS ---')
    lines.push(`[${s.i} ${s.kind}] ${s.line}`)
  }
  return `SEGMENTS SO FAR:\n${earlier}\n\nLAST ${tail.length} STEPS (${all.length} in the session, ${all.length - last} new):\n${lines.join('\n')}\n\nDecision:`
}

const strip = (l: string) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*?|__?|`/g, '').trim()

// the reply parsed: the decision word, the title, the summary as one paragraph
export function parse(reply: string): Decision {
  const lines = reply.split('\n').map(strip).filter(l => l !== '' && !/^decision:?$/i.test(l))
  const head = (lines[0] ?? '').replace(/[^a-z]/gi, '').toUpperCase()
  const kind = head.startsWith('SKIP') ? 'skip' : head.startsWith('AMEND') ? 'amend' : head.startsWith('NEW') ? 'new' : undefined
  if (kind === 'skip') return { kind: 'skip' }
  const body = kind === undefined ? lines : lines.slice(1)
  let title = ''
  const rest: string[] = []
  for (const l of body) {
    const t = /^title:\s*/i.exec(l)
    const s = /^summary:\s*/i.exec(l)
    if (t && title === '') title = l.slice(t[0].length)
    else rest.push(s ? l.slice(s[0].length) : l)
  }
  if (title === '') title = rest.shift() ?? ''
  const summary = cut(rest.join(' ').replace(/\s+/g, ' ').trim(), 900)
  if (title === '') return { kind: 'skip' }
  return { kind: kind ?? 'new', title: cut(title, 90), summary: summary === '' ? title : summary }
}

export type Command =
  | { kind: 'toggle' } | { kind: 'now' } | { kind: 'clear' } | { kind: 'stop' } | { kind: 'help' }
  | { kind: 'every' | 'window'; n: number } | { kind: 'model'; model: string } | { kind: 'unknown'; arg: string }

export function parseArgs(args: string): Command {
  const [head = '', tail = ''] = args.trim().split(/\s+/)
  const word = head.toLowerCase()
  if (word === '') return { kind: 'toggle' }
  if (word === 'now') return { kind: 'now' }
  if (word === 'clear') return { kind: 'clear' }
  if (word === 'stop' || word === 'close') return { kind: 'stop' }
  if (word === 'help' || word === 'list' || word === 'status') return { kind: 'help' }
  if (word === 'every' || word === 'window') {
    const n = Number(tail)
    const [lo, hi] = LIMITS[word]
    return Number.isInteger(n) && n >= lo && n <= hi ? { kind: word, n } : { kind: 'unknown', arg: args.trim() }
  }
  if (word === 'model') return /^[\w.:-]+$/.test(tail) ? { kind: 'model', model: tail } : { kind: 'unknown', arg: args.trim() }
  return { kind: 'unknown', arg: args.trim() }
}

export const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
