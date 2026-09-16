// The pure parts of cc-traj-seg: the trajectory as steps, the window handed to the model, the
// system prompt, the reply protocol (SKIP, AMEND, NEW with a title, a summary and the decisions
// the agent made and why) and the /traj argument parser. The hooks module wires these to the engine.

export type ToolUse = { tool_use_id?: string; tool: string; input: Record<string, unknown>; text?: string; isError?: true }
export type Message = { role: 'user' | 'assistant'; text: string; toolUses: ToolUse[]; toolResults?: unknown[] }
// one step is one action of the trajectory: a prompt the person typed, an assistant message with
// text, or one tool call with what came back. `id` is the tool row's id, an anchor in the transcript.
export type Step = { i: number; kind: 'user' | 'assistant' | 'tool'; line: string; id?: string; text?: string }
// one decision: a choice the agent made and, separately, the reason for it. Kept apart so the
// panel shows the choice as a headline and the why underneath, not one run-on line.
export type Note = { choice: string; why: string }
export type Segment = {
  n: number; from: number; to: number; at: number; model: string
  title: string; summary: string
  decisions: Note[]      // the choices made in this segment, each with its reason
  steps: string[]        // the step lines the segment covers, for the detail view
  anchor?: string        // a tool row's id at the start of the segment, to scroll the transcript to
  anchorText?: string    // else the start of the first message's text, matched to a rendered row
  amended?: number
  backfilled?: true       // written in retrospect by /traj backfill, not live
  qa?: Qa[]               // side questions asked about this phase, newest last
}
// one side question about a phase and its answer, kept with the phase
export type Qa = { q: string; a: string; at: number; model: string }
export const MAX_QA = 10
export type Decision = { kind: 'skip' } | { kind: 'amend' | 'new'; title: string; summary: string; decisions: Note[] }
export const MAX_DECISIONS = 6
export type Settings = { model: string; every: number; window: number; btwModel: string }

// a small interval by default: each look then covers roughly one action, so with the NEW bias the
// segments stay fine-grained instead of collapsing into one long block
export const DEFAULTS: Settings = { model: 'haiku', every: 6, window: 40, btwModel: 'sonnet' }
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
  'You segment the trajectory of a coding agent into short, non-overlapping phases, for the engineer supervising it from a narrow side panel. Each phase is one thing the agent is doing. Favour many small phases over few long ones; the goal is a legible outline, not a wall of text.',
  'You get the phases you already wrote (with their decisions) and the most recent steps; the steps after the NEW STEPS marker arrived since the last phase.',
  'Choose one word. NEW: the agent\'s action, target or goal shifted at all — a different file, a different sub-task, a switch between exploring, editing, testing or debugging, or a fresh decision. This is the usual answer; when unsure, choose NEW. AMEND: the newest steps are the direct continuation and result of the SAME action already in the current phase (the thing it was doing just finished or produced output). Never use AMEND to absorb a new action. SKIP: the new steps did nothing worth recording (a bare message, no real action, nothing decided).',
  'Reply with the word alone on the first line. For NEW or AMEND then add:',
  'TITLE: under 70 characters, present tense, what the agent is doing in this phase.',
  'SUMMARY: exactly one sentence, under 140 characters, the essential context. Never a paragraph.',
  'DECISIONS: then one line per decision the agent made in these steps, written as "<choice> — <why>", the choice and the reason each a few words, the whole line under 90 characters. A decision is a choice among alternatives: an approach taken, an option rejected, a fix chosen after a failure, a tool, file or command picked for a reason the steps show. Omit the DECISIONS line when there is no real decision. For AMEND, list only decisions new since the last phase. Never invent a reason the steps do not support.',
  'Plain text, no markdown. Files by basename, commands by first word, tests by result. Terse. Never restate what an earlier phase already says.',
].join(' ')

// split a "choice — why" line into its two parts; the first " — ", " – ", " - " or ": " divides
// them, and a line with no divider is all choice
export function splitNote(line: string): Note {
  const m = /\s[—–]\s|\s-\s|:\s/.exec(line)
  if (!m) return { choice: line.trim(), why: '' }
  return { choice: line.slice(0, m.index).trim(), why: line.slice(m.index + m[0].length).trim() }
}

// decisions accumulate within a segment across amendments; a new one is appended unless an
// earlier one already made the same choice (case-insensitive), newest kept last
export function mergeDecisions(prev: readonly Note[], next: readonly Note[], max = MAX_DECISIONS): Note[] {
  const out = [...prev]
  for (const d of next) {
    const norm = d.choice.toLowerCase().trim()
    if (norm !== '' && !out.some(p => p.choice.toLowerCase().trim() === norm)) out.push(d)
  }
  return out.slice(-max)
}

// what the model reads: the earlier segments, then the last `window` steps with a marker before
// the ones that are new since the last segment
export function prompt(segments: Segment[], all: Step[], last: number, window: number): string {
  const earlier = segments.length === 0 ? '(none yet: the first reply is NEW)'
    : [...segments].reverse().map(s => `#${s.n} (steps ${s.from}-${s.to}) ${s.title}\n${s.summary}${s.decisions.length ? `\ndecisions: ${s.decisions.map(d => d.why ? `${d.choice} — ${d.why}` : d.choice).join(' | ')}` : ''}`).join('\n\n')
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

// the reply parsed: the decision word, the title, the summary paragraph, and the decision lines
// under a DECISIONS: marker (each a "choice — why")
export function parse(reply: string): Decision {
  const lines = reply.split('\n').map(strip).filter(l => l !== '' && !/^decision:?$/i.test(l))
  const head = (lines[0] ?? '').replace(/[^a-z]/gi, '').toUpperCase()
  const kind = head.startsWith('SKIP') ? 'skip' : head.startsWith('AMEND') ? 'amend' : head.startsWith('NEW') ? 'new' : undefined
  if (kind === 'skip') return { kind: 'skip' }
  const body = kind === undefined ? lines : lines.slice(1)
  let title = ''
  const summaryParts: string[] = []
  const decisions: string[] = []
  let mode: 'pre' | 'summary' | 'decisions' = 'pre'
  for (const l of body) {
    const t = /^title:\s*/i.exec(l)
    const s = /^summary:\s*/i.exec(l)
    const d = /^decisions?:\s*(.*)$/i.exec(l)
    if (t) { if (title === '') title = l.slice(t[0].length); mode = 'pre'; continue }
    if (s) { summaryParts.push(l.slice(s[0].length)); mode = 'summary'; continue }
    if (d) { mode = 'decisions'; if (d[1].trim() !== '') decisions.push(d[1].trim()); continue }
    if (mode === 'decisions') decisions.push(l)
    else if (mode === 'summary') summaryParts.push(l)
    else if (title === '') title = l
    else summaryParts.push(l)
  }
  if (title === '') title = summaryParts.shift() ?? ''
  const summary = cut(summaryParts.join(' ').replace(/\s+/g, ' ').trim(), 200)
  const decs = decisions.map(l => splitNote(cut(l, 110))).filter(d => d.choice !== '').slice(0, MAX_DECISIONS)
  if (title === '') return { kind: 'skip' }
  return { kind: kind ?? 'new', title: cut(title, 70), summary: summary === '' ? title : summary, decisions: decs }
}

// how far back a backfill reaches: the start step (0 = the whole conversation), from the answer
// the depth question got, which is a label or free text like "full", "everything", "last 120"
export function parseDepth(answer: string, count: number): number {
  const a = answer.toLowerCase()
  if (/\b(full|all|whole|everything|entire|beginning|start)\b/.test(a)) return 0
  const m = /(\d[\d,]*)/.exec(a)
  if (m) return Math.max(0, count - Number(m[1].replace(/,/g, '')))
  return 0
}

// the model options a backfill offers: the current one first (so Enter keeps it), then a few
// aliases, deduped, at most four
export function modelChoices(current: string): string[] {
  const out = [current]
  for (const m of ['haiku', 'sonnet', 'opus']) if (!out.includes(m)) out.push(m)
  return out.slice(0, 4)
}

// AskUserQuestion needs 2-4 unique labels; keep the first occurrence, cap at four
export const uniqueOptions = (labels: readonly string[]) => [...new Set(labels)].slice(0, 4)

// the depth options a backfill offers: the whole conversation, then a "last N" for each cutoff
// strictly shorter than it, so short sessions do not show two labels that mean the same span
export function depthOptions(count: number): string[] {
  const out = ['Full conversation']
  for (const c of [40, 100, 200]) if (c < count) out.push(`Last ${c} steps`)
  if (out.length < 2 && count > 1) out.push(`Last ${Math.max(1, Math.floor(count / 2))} steps`)
  return uniqueOptions(out)
}

// the interval options a backfill offers: the current N first, then a few, deduped
export const everyChoices = (current: number) => uniqueOptions([String(current), '5', '10', '20', '30'])

export type Command =
  | { kind: 'toggle' } | { kind: 'now' } | { kind: 'clear' } | { kind: 'stop' } | { kind: 'help' } | { kind: 'backfill' }
  | { kind: 'every' | 'window'; n: number } | { kind: 'model'; model: string } | { kind: 'unknown'; arg: string }
  | { kind: 'btw'; n?: number; question?: string } | { kind: 'btwModel'; model: string }

export function parseArgs(args: string): Command {
  const [head = '', tail = ''] = args.trim().split(/\s+/)
  const word = head.toLowerCase()
  if (word === '') return { kind: 'toggle' }
  if (word === 'now') return { kind: 'now' }
  if (word === 'clear') return { kind: 'clear' }
  if (word === 'stop' || word === 'close') return { kind: 'stop' }
  if (word === 'help' || word === 'list' || word === 'status') return { kind: 'help' }
  if (word === 'backfill' || word === 'catchup') return { kind: 'backfill' }
  if (word === 'every' || word === 'window') {
    const n = Number(tail)
    const [lo, hi] = LIMITS[word]
    return Number.isInteger(n) && n >= lo && n <= hi ? { kind: word, n } : { kind: 'unknown', arg: args.trim() }
  }
  if (word === 'model') return /^[\w.:-]+$/.test(tail) ? { kind: 'model', model: tail } : { kind: 'unknown', arg: args.trim() }
  if (word === 'btw') {
    // btw model NAME · btw N question… · btw question… (the newest phase) · btw (asks in a dialog)
    const rest = args.trim().slice(head.length).trim()
    const m = /^model\s+([\w.:-]+)$/i.exec(rest)
    if (m) return { kind: 'btwModel', model: m[1] }
    const num = /^#?(\d+)\b\s*(.*)$/s.exec(rest)
    if (num) return { kind: 'btw', n: Number(num[1]), ...(num[2].trim() ? { question: num[2].trim() } : {}) }
    return rest ? { kind: 'btw', question: rest } : { kind: 'btw' }
  }
  return { kind: 'unknown', arg: args.trim() }
}

export const BTW_SYSTEM = [
  'You answer a side question from the engineer supervising a coding agent, about one phase of the agent\'s trajectory. This is an aside: the agent never sees it, so answer the engineer directly.',
  'You get the outline of every phase so far (title, summary, decisions) for context, then the phase in focus in full: its steps, and any earlier questions about it. Ground the answer in the focused phase; draw on the other phases only where the question needs them, and say when something is not in the record rather than guessing.',
  'Answer in plain text, no markdown. Lead with the answer in one or two sentences; add at most a few short lines of evidence, naming steps by number, files by basename and commands by first word. Terse.',
].join(' ')

const SUGGESTED = ['Why did it do this?', 'What did it try that did not work?', 'What was left undone here?']
// the suggested questions a btw dialog offers, the free text under Other taking anything else
export const btwChoices = () => [...SUGGESTED]

// what the answering model reads: the outline of every phase, then the focused one in full
export function btwPrompt(segments: Segment[], focus: Segment, question: string): string {
  const outline = [...segments].reverse().map(s => `#${s.n} (steps ${s.from}-${s.to})${s.n === focus.n ? ' [IN FOCUS]' : ''} ${s.title}\n${s.summary}${s.decisions.length ? `\ndecisions: ${s.decisions.map(d => d.why ? `${d.choice} — ${d.why}` : d.choice).join(' | ')}` : ''}`).join('\n\n')
  const decisions = focus.decisions.length ? focus.decisions.map(d => `- ${d.choice}${d.why ? ` — ${d.why}` : ''}`).join('\n') : '(none recorded)'
  const earlier = (focus.qa ?? []).map(x => `Q: ${x.q}\nA: ${x.a}`).join('\n\n')
  return `ALL PHASES:\n${outline}\n\nPHASE IN FOCUS: #${focus.n} (steps ${focus.from}-${focus.to}) ${focus.title}\n${focus.summary}\ndecisions:\n${decisions}\nsteps:\n${focus.steps.join('\n') || '(none kept)'}${earlier ? `\n\nEARLIER QUESTIONS ABOUT THIS PHASE:\n${earlier}` : ''}\n\nQUESTION: ${question}\n\nANSWER:`
}

export const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
