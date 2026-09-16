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
// the four prompts the plugin sends, each overridable from the settings frame; undefined = default
export type Prompts = { segSystem?: string; segTemplate?: string; btwSystem?: string; btwTemplate?: string }
export type PromptKey = keyof Prompts
export type Settings = { model: string; every: number; window: number; btwModel: string; prompts: Prompts; enabled: boolean }

// a small interval by default: each look then covers roughly one action, so with the NEW bias the
// segments stay fine-grained instead of collapsing into one long block
// off until /traj says so: installing the plugin costs nothing until you ask for it
export const DEFAULTS: Settings = { model: 'haiku', every: 6, window: 40, btwModel: 'sonnet', prompts: {}, enabled: false }
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

// Prompts are mustache-style templates: {{long-horizon-context}} is the memory (every phase so
// far), {{short-horizon-context}} the recent raw material (the step window, or the phase in
// focus). A template is rendered by substituting each {{variable}}; an unknown name is left in
// place so the mistake is visible rather than silently blank.
export const VARIABLES: Record<'segment' | 'btw', { name: string; legend: string }[]> = {
  segment: [
    { name: 'long-horizon-context', legend: 'every phase so far, oldest first: title, summary, decisions (the model\'s own memory)' },
    { name: 'short-horizon-context', legend: 'the last {{window}} steps as [n kind] lines, with a --- NEW STEPS --- marker before the new ones' },
    { name: 'steps-shown', legend: 'how many steps are in the short-horizon context' },
    { name: 'step-count', legend: 'steps in the session so far' },
    { name: 'new-count', legend: 'steps since the last phase' },
    { name: 'window', legend: 'the window setting' },
  ],
  btw: [
    { name: 'long-horizon-context', legend: 'every phase so far, the focused one marked [IN FOCUS]' },
    { name: 'short-horizon-context', legend: 'the phase in focus in full: title, summary, decisions, its steps, earlier questions about it' },
    { name: 'question', legend: 'what the person asked' },
    { name: 'phase', legend: 'the focused phase\'s number' },
  ],
}

export const DEFAULT_SEG_TEMPLATE = 'SEGMENTS SO FAR:\n{{long-horizon-context}}\n\nLAST {{steps-shown}} STEPS ({{step-count}} in the session, {{new-count}} new):\n{{short-horizon-context}}\n\nDecision:'
export const DEFAULT_BTW_TEMPLATE = 'ALL PHASES:\n{{long-horizon-context}}\n\nPHASE IN FOCUS: {{short-horizon-context}}\n\nQUESTION: {{question}}\n\nANSWER:'

export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-z0-9-]+)\s*\}\}/gi, (whole, name: string) => {
    const v = vars[name.toLowerCase()]
    return v === undefined ? whole : String(v)
  })
}

// the {{names}} a template uses that the given set does not define
export const unknownVariables = (template: string, known: readonly { name: string }[]) =>
  [...new Set([...template.matchAll(/\{\{\s*([a-z0-9-]+)\s*\}\}/gi)].map(m => m[1].toLowerCase()))].filter(n => !known.some(k => k.name === n))

const outlineOf = (segments: Segment[], focus?: number) => [...segments].reverse().map(s =>
  `#${s.n} (steps ${s.from}-${s.to})${focus === s.n ? ' [IN FOCUS]' : ''} ${s.title}\n${s.summary}${s.decisions.length ? `\ndecisions: ${s.decisions.map(d => d.why ? `${d.choice} — ${d.why}` : d.choice).join(' | ')}` : ''}`).join('\n\n')

// the variables of one segmentation look: the earlier segments, then the last `window` steps with
// a marker before the ones that are new since the last segment
export function segmentVars(segments: Segment[], all: Step[], last: number, window: number): Record<string, string | number> {
  const long = segments.length === 0 ? '(none yet: the first reply is NEW)' : outlineOf(segments)
  const tail = all.slice(Math.max(0, all.length - window))
  const lines: string[] = []
  if (tail.length > 0 && tail[0].i > last + 1) lines.push('--- NEW STEPS (earlier ones cut) ---')
  for (const s of tail) {
    if (s.i === last + 1) lines.push('--- NEW STEPS ---')
    lines.push(`[${s.i} ${s.kind}] ${s.line}`)
  }
  return { 'long-horizon-context': long, 'short-horizon-context': lines.join('\n'), 'steps-shown': tail.length, 'step-count': all.length, 'new-count': all.length - last, window }
}

// what the model reads for one look: the template (default or the person's) over the variables
export const prompt = (segments: Segment[], all: Step[], last: number, window: number, template = DEFAULT_SEG_TEMPLATE) =>
  render(template, segmentVars(segments, all, last, window))

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
  | { kind: 'settings' } | { kind: 'prompts'; action: 'export' | 'load' | 'reset' } | { kind: 'enable'; on: boolean } | { kind: 'tokens' }

export function parseArgs(args: string): Command {
  const [head = '', tail = ''] = args.trim().split(/\s+/)
  const word = head.toLowerCase()
  if (word === '') return { kind: 'toggle' }
  if (word === 'now') return { kind: 'now' }
  if (word === 'clear') return { kind: 'clear' }
  if (word === 'stop' || word === 'close') return { kind: 'stop' }
  if (word === 'help' || word === 'list' || word === 'status') return { kind: 'help' }
  if (word === 'backfill' || word === 'catchup') return { kind: 'backfill' }
  if (word === 'settings' || word === 'config') return { kind: 'settings' }
  if (word === 'tokens' || word === 'usage' || word === 'cost') return { kind: 'tokens' }
  if (word === 'on' || word === 'resume' || word === 'start') return { kind: 'enable', on: true }
  if (word === 'off' || word === 'pause') return { kind: 'enable', on: false }
  if (word === 'prompts') {
    const a = tail.toLowerCase()
    return a === 'export' || a === 'load' || a === 'reset' ? { kind: 'prompts', action: a } : { kind: 'unknown', arg: args.trim() }
  }
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

// the variables of one side question: the outline of every phase, then the focused one in full
export function btwVars(segments: Segment[], focus: Segment, question: string): Record<string, string | number> {
  const decisions = focus.decisions.length ? focus.decisions.map(d => `- ${d.choice}${d.why ? ` — ${d.why}` : ''}`).join('\n') : '(none recorded)'
  const earlier = (focus.qa ?? []).map(x => `Q: ${x.q}\nA: ${x.a}`).join('\n\n')
  const short = `#${focus.n} (steps ${focus.from}-${focus.to}) ${focus.title}\n${focus.summary}\ndecisions:\n${decisions}\nsteps:\n${focus.steps.join('\n') || '(none kept)'}${earlier ? `\n\nEARLIER QUESTIONS ABOUT THIS PHASE:\n${earlier}` : ''}`
  return { 'long-horizon-context': outlineOf(segments, focus.n), 'short-horizon-context': short, question, phase: focus.n }
}

export const btwPrompt = (segments: Segment[], focus: Segment, question: string, template = DEFAULT_BTW_TEMPLATE) =>
  render(template, btwVars(segments, focus, question))

// ---- the prompts file: a markdown round-trip for editing long prompts in an editor
export const PROMPT_LABELS: Record<PromptKey, string> = {
  segSystem: 'segmentation system prompt',
  segTemplate: 'segmentation prompt template',
  btwSystem: 'btw system prompt',
  btwTemplate: 'btw prompt template',
}
export const PROMPT_KEYS = Object.keys(PROMPT_LABELS) as PromptKey[]
export const defaultPrompt = (key: PromptKey, systems: { seg: string; btw: string }) =>
  key === 'segSystem' ? systems.seg : key === 'btwSystem' ? systems.btw : key === 'segTemplate' ? DEFAULT_SEG_TEMPLATE : DEFAULT_BTW_TEMPLATE

const legendLines = () => [
  'Variables, written {{name}}; an unknown name is left in the text so you can see it:',
  ...VARIABLES.segment.map(v => `  segmentation  {{${v.name}}}  ${v.legend}`),
  ...VARIABLES.btw.map(v => `  btw           {{${v.name}}}  ${v.legend}`),
]

export function serializePrompts(prompts: Prompts, systems: { seg: string; btw: string }): string {
  const out = ['# cc-traj-seg prompts', '', 'Edit a section and load the file back with /traj prompts load (or the load button in the settings frame).', 'A section left exactly as its default, or emptied, means: use the default.', '', ...legendLines(), '']
  for (const k of PROMPT_KEYS) out.push(`## ${PROMPT_LABELS[k]}`, '', prompts[k] ?? defaultPrompt(k, systems), '')
  return out.join('\n')
}

// the file back into overrides: each `## label` section's body; a body equal to the default (or
// empty) clears the override
export function parsePrompts(text: string, systems: { seg: string; btw: string }): Prompts {
  const out: Prompts = {}
  const parts = text.split(/^## /m).slice(1)
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const label = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase()
    const body = (nl === -1 ? '' : part.slice(nl + 1)).trim()
    const key = PROMPT_KEYS.find(k => PROMPT_LABELS[k] === label)
    if (!key) continue
    if (body !== '' && body !== defaultPrompt(key, systems)) out[key] = body
  }
  return out
}

// ---- tokens: what the agent's turns cost as the API reported it, per model, and what this
// plugin's own calls cost, estimated from characters (a completion returns text only)
export type Counts = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type AgentUse = Counts & { turns: number }
export type PluginUse = { calls: number; inChars: number; outChars: number }
export type Purpose = 'phases' | 'btw'
export type Usage = { agent: Record<string, AgentUse>; plugin: Record<Purpose, Record<string, PluginUse>> }
export const emptyUsage = (): Usage => ({ agent: {}, plugin: { phases: {}, btw: {} } })
// the working estimate for English and code; shown with ≈ wherever it appears
export const CHARS_PER_TOKEN = 4
export const estTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN)

export function addAgent(u: Usage, model: string, c: Counts): Usage {
  const prev = u.agent[model] ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return { ...u, agent: { ...u.agent, [model]: { turns: prev.turns + 1, input: prev.input + c.input, output: prev.output + c.output, cacheRead: prev.cacheRead + c.cacheRead, cacheWrite: prev.cacheWrite + c.cacheWrite } } }
}

export function addPlugin(u: Usage, purpose: Purpose, model: string, inChars: number, outChars: number): Usage {
  const prev = u.plugin[purpose][model] ?? { calls: 0, inChars: 0, outChars: 0 }
  return { ...u, plugin: { ...u.plugin, [purpose]: { ...u.plugin[purpose], [model]: { calls: prev.calls + 1, inChars: prev.inChars + inChars, outChars: prev.outChars + outChars } } } }
}

// 1234 → 1.2k, 1234567 → 1.2M, 999 → 999
export function fmtK(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(1)}M`
}

// the panel's lines, for the frame and for /traj tokens
export function usageLines(u: Usage, session?: { context?: { tokens?: number; window: number; percent?: number }; cost?: { usd: number }; rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[] }): string[] {
  const out: string[] = []
  const agents = Object.entries(u.agent)
  out.push(agents.length ? 'agent · as the API reported it' : 'agent · no completed turn yet')
  for (const [m, a] of agents) out.push(`  ${m}: ${a.turns} turn${a.turns === 1 ? '' : 's'} · in ${fmtK(a.input)} · out ${fmtK(a.output)} · cache read ${fmtK(a.cacheRead)} · cache write ${fmtK(a.cacheWrite)}`)
  if (session) {
    const c = session.context
    const parts = [
      c ? `context ${c.tokens === undefined ? '?' : fmtK(c.tokens)} / ${fmtK(c.window)}${c.percent === undefined ? '' : ` (${Math.round(c.percent)}%)`}` : '',
      session.cost ? `cost $${session.cost.usd.toFixed(2)}` : '',
      ...(session.rateLimits ?? []).map(r => `${r.kind.replace(/_/g, ' ')} ${Math.round(r.percentUsed)}%${r.resetsAt ? ` (resets ${clock(new Date(r.resetsAt).getTime())})` : ''}`),
    ].filter(Boolean)
    if (parts.length) out.push(`  ${parts.join(' · ')}`)
  }
  const purposes: Purpose[] = ['phases', 'btw']
  const any = purposes.some(p => Object.keys(u.plugin[p]).length)
  out.push(any ? `cc-traj-seg · estimated from characters, ≈${CHARS_PER_TOKEN} per token` : 'cc-traj-seg · no calls yet')
  for (const p of purposes) for (const [m, c] of Object.entries(u.plugin[p])) out.push(`  ${m} · ${p}: ${c.calls} call${c.calls === 1 ? '' : 's'} · ≈in ${fmtK(estTokens(c.inChars))} · ≈out ${fmtK(estTokens(c.outChars))}`)
  return out
}

export const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
