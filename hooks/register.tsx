/* @jsx h */
import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import { addAgent, addPlugin, anchorOf, BTW_SYSTEM, emptyUsage, usageLines, type Purpose, type Usage, btwChoices, btwPrompt, clock, DEFAULTS, defaultPrompt, due, MAX_QA, mergeDecisions, parse, parseArgs, parsePrompts, prompt, PROMPT_KEYS, PROMPT_LABELS, serializePrompts, splitNote, stepLines, steps, SYSTEM, unknownVariables, VARIABLES, type PromptKey, type Qa, type Segment, type Settings } from './traj.ts'

// /traj: a pane of trajectory segments. After every tool call and every turn the module counts
// the session's steps and, every N of them, hands a model the segments so far and the last W
// steps. The model answers SKIP, AMEND or NEW; only the last two touch the pane. A segment is a
// card: its title, and on a click its summary, a button that scrolls the transcript to where it
// starts, a button that opens its steps in a second pane, and an ✕. Settings live in $.store; the
// segments under the session id, so a resumed session shows its own.

const PANE = 'traj'
const DETAIL = 'traj-steps'
const BTW = 'traj-btw'
const SETTINGS = 'traj-settings'
const EDIT = 'traj-edit'
// the built-in system prompts, the defaults the settings frame resets to
const SYSTEMS = { seg: SYSTEM, btw: BTW_SYSTEM }
const MAX_SEGMENTS = 60

let sessionId = ''
let settings: Settings = { ...DEFAULTS }
let last = 0 // steps covered by the segments so far
let segments: Segment[] = []
let open = false
let busy = false
let state = ''
let detail: number | undefined
let btwOf: number | undefined
let asking = false
// the btw pane waiting for a question typed into its field, and the backfill row shown in the pane
let btwAsk: number | undefined
let backfillMenu = false
let promptsFile = ''
let usage: Usage = emptyUsage()
// the prompt open in the editor pane: which, the latest draft the editor posted, a version that
// bumps when a different text is loaded into it, and whether the draft is what is saved
let editing: { key: PromptKey; draft: string; version: number; saved: boolean } | undefined
const expanded = new Set<number>()
// the transcript rows as the terminal drew them: a message's render id by the start of its text,
// so a segment that starts with a message can be scrolled to
const rows = new Map<string, string>()

const KEY = () => `segments:${sessionId}`

// the helpers that take $ are top-level function declarations: the loader follows $ into them
function save($: EngineInterface) {
  return $.store.set(KEY(), { last, segments }).catch(err => $.ui.log(`cc-traj-seg: store write failed: ${err}`))
}

function saveSettings($: EngineInterface) {
  return $.store.set('settings', settings).catch(err => $.ui.log(`cc-traj-seg: store write failed: ${err}`))
}

function redraw($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

function saveUsage($: EngineInterface) {
  return $.store.set(`usage:${sessionId}`, usage).catch(() => undefined)
}

// every completion this plugin asks for goes through here, so its cost is counted per model and
// purpose; the API's own counts are not returned to a plugin, so characters stand in for them
async function complete($: EngineInterface, purpose: Purpose, model: string, promptText: string, system: string, maxTokens: number): Promise<string> {
  const reply = await $.model.complete({ model, prompt: promptText, system, maxTokens })
  usage = addPlugin(usage, purpose, model, promptText.length + system.length, reply.length)
  void saveUsage($)
  return reply
}

// one look's decision applied to the segment stack: SKIP leaves it, AMEND rewrites and extends
// the top segment (its decisions merged), NEW pushes one. Shared by the live look and backfill.
function apply(decision: ReturnType<typeof parse>, all: ReturnType<typeof steps>, from: number, to: number, at: number, model: string, backfilled: boolean): { kind: 'skip' | 'amend' | 'new'; n?: number; added?: number } {
  if (decision.kind === 'skip') return { kind: 'skip' }
  if (decision.kind === 'amend' && segments.length > 0) {
    const [head, ...rest] = segments
    const decisions = mergeDecisions(head.decisions, decision.decisions)
    segments = [{ ...head, to, title: decision.title, summary: decision.summary, decisions, steps: [...head.steps, ...stepLines(all, from, to)].slice(-80), amended: at }, ...rest]
    return { kind: 'amend', n: head.n, added: decisions.length - head.decisions.length }
  }
  const seg: Segment = { n: (segments[0]?.n ?? 0) + 1, from, to, at, model, title: decision.title, summary: decision.summary, decisions: decision.decisions, steps: stepLines(all, from, to), ...(backfilled ? { backfilled: true } : {}), ...anchorOf(all, from, to) }
  segments = [seg, ...segments].slice(0, MAX_SEGMENTS)
  return { kind: 'new', n: seg.n }
}

// how many strides one trigger may consume, so a burst of steps does not fan out into a long
// chain of model calls in a single run; the rest is caught by the next trigger
const MAX_CHUNKS = 8

// the work that outlives a hook: a completion can take longer than a hook's budget, so nothing
// awaits this from a hook; it redraws the pane when it is done. The backlog is consumed one
// `every`-sized chunk at a time, so each chunk is roughly one action and becomes its own block,
// rather than one look swallowing a whole multi-step turn into a single segment.
async function segment($: EngineInterface, force: boolean) {
  if (busy) return
  // off: no looks and no model calls until /traj on; a forced look (/traj now) still works
  if (!settings.enabled && !force) return
  const messages: SessionMessage[] = await $.session.messages().catch(() => [])
  const all = steps(messages)
  const count = all.length
  if (count <= last || (!force && !due(count, last, settings.every))) {
    if (force) {
      state = `nothing new since step ${last}`
      redraw($)
    }
    return
  }
  busy = true
  try {
    const stride = Math.max(1, settings.every)
    let made = 0
    let touched = false
    let chunks = 0
    // a normal trigger consumes only whole strides and leaves a short tail for next time; a forced
    // look (/traj now) flushes the tail too
    while (chunks < MAX_CHUNKS && (force ? last < count : last + stride <= count)) {
      const from = last + 1
      const to = Math.min(count, last + stride)
      state = `reading steps ${from}-${to} of ${count}…`
      redraw($)
      const reply = await complete($, 'phases', settings.model, prompt(segments, all.slice(0, to), last, settings.window, settings.prompts.segTemplate), settings.prompts.segSystem ?? SYSTEM, 400)
      const at = await $.clock.now()
      const r = apply(parse(reply), all, from, to, at, settings.model, false)
      last = to
      chunks++
      if (r.kind === 'new') made++
      if (r.kind !== 'skip') touched = true
      redraw($)
    }
    if (touched && !open) {
      // a pane the plugin opens on its own waits undrawn under 144 columns until /traj asks
      await $.ui.open({ id: PANE, title: 'Trajectory' }).then(() => { open = true }).catch(() => undefined)
    }
    if (made > 0) $.ui.toast(`traj: ${made} new segment${made === 1 ? '' : 's'} (${segments[0]?.title ?? ''})`, { timeoutMs: 6000 })
    state = made > 0 ? `${made} new · ${last} covered` : touched ? `updated · ${last} covered` : `caught up · ${last} covered`
    await save($)
  } catch (err) {
    state = `failed: ${String(err).slice(0, 60)}`
    $.ui.log(`cc-traj-seg: segmentation failed: ${err}`)
  } finally {
    busy = false
    redraw($)
  }
}

// the transcript scrolled to where a segment starts: its first tool row, or its first message's
// row as drawn. Refused (an id the terminal never drew, a row that is not scrollable), the steps
// pane opens instead and the toast says why.
async function goTo($: EngineInterface, seg: Segment) {
  const requestId = seg.anchor ?? (seg.anchorText ? rows.get(seg.anchorText) : undefined)
  const r = requestId ? await $.ui.scroll({ to: { requestId }, block: 'start' }).catch(err => ({ deny: String(err) })) : { deny: 'no row of this segment was drawn in this session' }
  if ('deny' in r && r.deny) {
    state = `#${seg.n}: cannot scroll there (${String(r.deny).slice(0, 50)})`
    $.ui.toast(`traj: cannot scroll there (${String(r.deny).slice(0, 60)}) · showing the steps instead`, { timeoutMs: 5000 })
    await showSteps($, seg.n)
  } else {
    state = `scrolled to #${seg.n}`
    redraw($)
  }
}

async function showSteps($: EngineInterface, n: number) {
  detail = n
  await $.ui.open({ id: DETAIL, title: `#${n} steps`, focus: true, closeOnEscape: true, rows: 14 })
    .then(() => { state = `steps of #${n} open · Esc closes them` })
    .catch(err => { state = `steps pane refused: ${String(err).slice(0, 50)}` })
  redraw($)
}

// a side question about one phase, answered in parallel and never shown to the agent: the
// question comes from the dialog (a suggestion, or free text under Other) or from /traj btw; the
// answering model reads every phase for context and the focused one in full; the thread is kept
// on the phase and shown in its own pane
async function askBtw($: EngineInterface, n: number, question?: string) {
  const seg = segments.find(x => x.n === n)
  if (!seg) {
    $.ui.toast(`traj: no phase #${n}`, { timeoutMs: 4000 })
    return
  }
  if (asking) {
    $.ui.toast('traj: one question at a time', { timeoutMs: 3000 })
    return
  }
  const q = question?.trim() ?? ''
  if (q === '') {
    // no question yet: the pane opens with a field to type one and the stock questions as buttons
    btwOf = n
    btwAsk = n
    await $.ui.open({ id: BTW, title: `btw #${n}`, focus: true, closeOnEscape: true, rows: 14 }).catch(() => undefined)
    redraw($)
    return
  }
  asking = true
  btwOf = n
  btwAsk = undefined
  state = `btw #${n}: asking ${settings.btwModel}…`
  redraw($)
  await $.ui.open({ id: BTW, title: `btw #${n}`, focus: true, closeOnEscape: true, rows: 14 }).catch(() => undefined)
  try {
    const a = (await complete($, 'btw', settings.btwModel, btwPrompt(segments, seg, q, settings.prompts.btwTemplate), settings.prompts.btwSystem ?? BTW_SYSTEM, 600)).trim()
    const at = await $.clock.now()
    const entry: Qa = { q, a: a || '(no answer)', at, model: settings.btwModel }
    segments = segments.map(x => (x.n === n ? { ...x, qa: [...(x.qa ?? []), entry].slice(-MAX_QA) } : x))
    state = `btw #${n} answered by ${settings.btwModel}`
    await save($)
  } catch (err) {
    state = `btw failed: ${String(err).slice(0, 50)}`
    $.ui.log(`cc-traj-seg: btw failed: ${err}`)
  } finally {
    asking = false
    redraw($)
  }
}

// ---- the settings frame: models, cadence, and the four prompts. A prompt is edited in a file:
// export writes all four with the variable legend, load reads them back. The dialog only offers
// labels (free text typed under Other is routed through the permission flow and comes back as a
// denial), so it is where you reset a prompt or jump to the file.
const varsOf = (key: PromptKey) => (key.startsWith('seg') ? VARIABLES.segment : VARIABLES.btw)
const isTemplate = (key: PromptKey) => key.endsWith('Template')

async function openSettings($: EngineInterface) {
  // the dock shows one pane: the side panes step aside so the frame is what appears
  for (const id of [BTW, DETAIL, EDIT]) await $.ui.close({ id }).catch(() => undefined)
  await $.ui.open({ id: SETTINGS, title: 'Settings', focus: true, closeOnEscape: true, rows: 24 }).catch(() => undefined)
  redraw($)
}

// a prompt opened in the editor pane, with its current text (custom or default) loaded
async function editPrompt($: EngineInterface, key: PromptKey) {
  const text = settings.prompts[key] ?? defaultPrompt(key, SYSTEMS)
  editing = { key, draft: text, version: (editing?.version ?? 0) + 1, saved: true }
  // the dock shows one pane: the settings frame steps aside so the editor is what appears, and
  // comes back when the editor closes
  await $.ui.close({ id: SETTINGS }).catch(() => undefined)
  await $.ui.open({ id: EDIT, title: `edit · ${PROMPT_LABELS[key]}`, focus: true, rows: 22 }).catch(() => undefined)
  redraw($)
}

// the editor's text saved as the prompt: the default (or nothing) clears the override; a template
// is checked for unknown {{names}} and for the short-horizon context
async function savePrompt($: EngineInterface, key: PromptKey, raw: string) {
  const text = raw.replace(/\s+$/, '')
  if (text === '' || text === defaultPrompt(key, SYSTEMS)) {
    await resetPrompt($, key)
    if (editing?.key === key) editing = { ...editing, draft: defaultPrompt(key, SYSTEMS), saved: true }
    redraw($)
    return
  }
  const unknown = isTemplate(key) ? unknownVariables(text, varsOf(key)) : []
  const missing = isTemplate(key) && !/\{\{\s*short-horizon-context\s*\}\}/i.test(text)
  settings = { ...settings, prompts: { ...settings.prompts, [key]: text } }
  await saveSettings($)
  if (editing?.key === key) editing = { ...editing, draft: text, saved: true }
  const warn = [unknown.length ? `unknown ${unknown.map(u => `{{${u}}}`).join(' ')}` : '', missing ? 'no {{short-horizon-context}}: the model will not see the steps' : ''].filter(Boolean).join(' · ')
  $.ui.toast(`traj: ${PROMPT_LABELS[key]} saved (${text.length} chars)${warn ? ` · ${warn}` : ''}`, { timeoutMs: 7000 })
  redraw($)
}

async function resetPrompt($: EngineInterface, key: PromptKey) {
  const { [key]: _dropped, ...rest } = settings.prompts
  settings = { ...settings, prompts: rest }
  await saveSettings($)
  // an editor open on this prompt reloads the default
  if (editing?.key === key) editing = { key, draft: defaultPrompt(key, SYSTEMS), version: editing.version + 1, saved: true }
  $.ui.toast(`traj: ${PROMPT_LABELS[key]} back to default`, { timeoutMs: 4000 })
  redraw($)
}

async function exportPrompts($: EngineInterface) {
  try {
    await $.fs.write(promptsFile, serializePrompts(settings.prompts, SYSTEMS))
    state = `prompts written to ${promptsFile}`
    $.ui.toast(`traj: prompts written to ${promptsFile} · edit, then load`, { timeoutMs: 8000 })
  } catch (err) {
    state = `export failed: ${String(err).slice(0, 50)}`
  }
  redraw($)
}

async function loadPrompts($: EngineInterface) {
  try {
    const text = await $.fs.read(promptsFile)
    const prompts = parsePrompts(text, SYSTEMS)
    settings = { ...settings, prompts }
    await saveSettings($)
    if (editing) editing = { ...editing, draft: prompts[editing.key] ?? defaultPrompt(editing.key, SYSTEMS), version: editing.version + 1, saved: true }
    const custom = PROMPT_KEYS.filter(k => prompts[k])
    const warn = custom.filter(isTemplate).flatMap(k => unknownVariables(prompts[k] ?? '', varsOf(k)).map(u => `{{${u}}}`))
    state = `prompts loaded: ${custom.length ? custom.map(k => PROMPT_LABELS[k]).join(', ') : 'all default'}${warn.length ? ` · unknown ${warn.join(' ')}` : ''}`
    $.ui.toast(`traj: ${state}`, { timeoutMs: 7000 })
  } catch (err) {
    state = `load failed: ${String(err).slice(0, 60)} · export first`
    $.ui.toast(`traj: ${state}`, { timeoutMs: 6000 })
  }
  redraw($)
}

// a setting typed into its field in the frame: a model alias or full id, or a number in range
function applySetting($: EngineInterface, which: 'model' | 'btwModel' | 'every' | 'window', raw: string) {
  const a = raw.trim()
  let ok = false
  if (which === 'model' || which === 'btwModel') {
    if (/^[\w.:-]+$/.test(a)) { settings = { ...settings, [which]: a }; ok = true }
  } else {
    const n = Number(a)
    const [lo, hi] = which === 'every' ? [1, 500] : [5, 400]
    if (Number.isInteger(n) && n >= lo && n <= hi) { settings = { ...settings, [which]: n }; ok = true }
  }
  if (!ok) $.ui.toast(`traj: "${a}" is not a valid ${which === 'every' ? 'interval (1-500)' : which === 'window' ? 'window (5-400)' : 'model (an alias or a full id)'}`, { timeoutMs: 5000 })
  void saveSettings($).then(() => redraw($))
}

// the phases rebuilt over history, no dialog: `lastSteps` is 0 for the whole conversation or k
// for the last k steps, and the model and interval are the current settings
async function backfill($: EngineInterface, lastSteps: number) {
  if (busy) {
    $.ui.toast('traj: already at it', { timeoutMs: 3000 })
    return
  }
  backfillMenu = false
  const messages: SessionMessage[] = await $.session.messages().catch(() => [])
  const all = steps(messages)
  const count = all.length
  if (count === 0) {
    $.ui.toast('traj: nothing to backfill yet', { timeoutMs: 4000 })
    redraw($)
    return
  }
  const start = lastSteps <= 0 ? 0 : Math.max(0, count - lastSteps)
  const model = settings.model
  const every = settings.every
  busy = true
  // start fresh over the chosen range; step by `every`, but cap the number of model calls so a
  // very long conversation does not fan out into hundreds of them
  segments = []
  expanded.clear()
  const MAX_LOOKS = 80
  const stride = Math.max(every, Math.ceil((count - start) / MAX_LOOKS))
  let covered = start
  let made = 0
  try {
    const at = await $.clock.now()
    if (!open) await $.ui.open({ id: PANE, title: 'Trajectory' }).then(() => { open = true }).catch(() => undefined)
    while (covered < count) {
      const to = Math.min(count, covered + stride)
      state = `backfill: steps ${covered + 1}-${to} of ${count} (${made} segments)…`
      redraw($)
      const reply = await complete($, 'phases', model, prompt(segments, all.slice(0, to), covered, settings.window, settings.prompts.segTemplate), settings.prompts.segSystem ?? SYSTEM, 500)
      const r = apply(parse(reply), all, covered + 1, to, at, model, true)
      if (r.kind === 'new') made++
      covered = to
      redraw($)
    }
    last = count
    await save($)
    state = `backfilled ${made} segment${made === 1 ? '' : 's'} from step ${start + 1} to ${count}`
    $.ui.toast(`traj: backfilled ${made} segment${made === 1 ? '' : 's'} · live from here`, { timeoutMs: 6000 })
  } catch (err) {
    state = `backfill failed: ${String(err).slice(0, 50)}`
    $.ui.log(`cc-traj-seg: backfill failed: ${err}`)
    await save($).catch(() => undefined)
  } finally {
    busy = false
    redraw($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    sessionId = await $.session.id().catch(() => 'unknown')
    const s = (await $.store.get('settings').catch(() => undefined)) as Partial<Settings> | undefined
    if (s && typeof s === 'object') {
      settings = {
        model: typeof s.model === 'string' && s.model !== '' ? s.model : DEFAULTS.model,
        every: Number.isInteger(s.every) && (s.every as number) >= 1 ? (s.every as number) : DEFAULTS.every,
        window: Number.isInteger(s.window) && (s.window as number) >= 5 ? (s.window as number) : DEFAULTS.window,
        btwModel: typeof s.btwModel === 'string' && s.btwModel !== '' ? s.btwModel : DEFAULTS.btwModel,
        prompts: Object.fromEntries(PROMPT_KEYS.flatMap(k => (typeof s.prompts?.[k] === 'string' && s.prompts[k] !== '' ? [[k, s.prompts[k]]] : []))),
        enabled: s.enabled === true,
      }
    }
    const u = (await $.store.get(`usage:${sessionId}`).catch(() => undefined)) as Usage | undefined
    if (u && typeof u === 'object' && u.agent && u.plugin) usage = { agent: u.agent, plugin: { phases: u.plugin.phases ?? {}, btw: u.plugin.btw ?? {} } }
    const saved = (await $.store.get(KEY()).catch(() => undefined)) as { last?: unknown; segments?: unknown } | undefined
    if (saved && typeof saved.last === 'number' && Array.isArray(saved.segments)) {
      last = saved.last
      segments = (saved.segments as Segment[]).map(x => ({
        ...x,
        steps: Array.isArray(x.steps) ? x.steps : [],
        summary: x.summary ?? x.title ?? '',
        // decisions were once plain strings; coerce any old ones to the choice/why shape
        decisions: Array.isArray(x.decisions) ? x.decisions.map((d: unknown) => (typeof d === 'string' ? splitNote(d) : d)).filter((d): d is Segment['decisions'][number] => !!d && typeof (d as { choice?: unknown }).choice === 'string') : [],
      }))
    }
    const home = await $.env.get('HOME').catch(() => undefined)
    promptsFile = home ? `${home}/.claude/cc-traj-seg/prompts.md` : `${e.cwd}/.cc-traj-seg-prompts.md`
    await $.command.register({
      name: 'traj',
      description: 'Trajectory segments of what Claude is doing, every N steps, in a pane on the right (cc-traj-seg)',
      argumentHint: '[now | every N | window N | model NAME | clear | stop | help]',
      immediate: true,
    }).catch(err => $.ui.log(`cc-traj-seg: /traj not registered: ${err}`))
    return r
  })

  // the transcript's message rows, remembered by the start of their text, for the go-to button
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    rows.set(e.props.text.replace(/\s+/g, ' ').trim().slice(0, 200), e.requestId)
    return next(e)
  })
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (text !== '' && !rows.has(text)) rows.set(text, e.requestId)
    return next(e)
  })

  on('command.run', { command: 'traj' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    const show = async () => {
      await $.ui.open({ id: PANE, title: 'Trajectory', focus: true })
      open = true
      redraw($)
    }
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
    switch (cmd.kind) {
      case 'toggle': {
        // /traj turns the looks on and shows the pane; /traj off turns them off; /traj stop only hides the pane
        const wasOn = settings.enabled
        if (!wasOn) {
          settings = { ...settings, enabled: true }
          await saveSettings($)
        }
        await show()
        void segment($, false)
        return { text: `traj: ${wasOn ? 'on' : 'switched on'} · ${settings.model} looks every ${settings.every} steps at the last ${settings.window} · ${plural(segments.length, 'segment')} so far · /traj off stops it` }
      }
      case 'now':
        await show()
        void segment($, true)
        return { text: busy ? 'traj: already at it' : 'traj: asking for a segment of the steps since the last one…' }
      case 'backfill':
        await show()
        if (cmd.start === undefined) {
          backfillMenu = true
          redraw($)
          return { text: `traj: choose how far in the pane (whole conversation, or the last N steps) · or /traj backfill full · /traj backfill 120 · uses ${settings.model} every ${settings.every} steps` }
        }
        if (cmd.start < 0) return { text: 'traj: /traj backfill full, or /traj backfill N for the last N steps' }
        void backfill($, cmd.start)
        return { text: busy ? 'traj: already at it' : `traj: backfilling ${cmd.start === 0 ? 'the whole conversation' : `the last ${cmd.start} steps`} with ${settings.model}, every ${settings.every} steps…` }
      case 'btw': {
        const n = cmd.n ?? segments[0]?.n
        if (n === undefined) return { text: 'traj: no phase to ask about yet' }
        if (!segments.some(x => x.n === n)) return { text: `traj: no phase #${n} · /traj help lists them` }
        await show()
        void askBtw($, n, cmd.question)
        return { text: cmd.question ? `traj: asking ${settings.btwModel} about #${n}…` : `traj: type a question about #${n} in the btw pane, or press one of its buttons` }
      }
      case 'btwModel':
        settings = { ...settings, btwModel: cmd.model }
        await saveSettings($)
        redraw($)
        return { text: `traj: btw answers by ${cmd.model} from now on` }
      case 'settings':
        await openSettings($)
        return { text: 'traj: settings open · models, cadence, the four prompts, and tokens · Esc closes' }
      case 'tokens': {
        const su = await $.session.usage().catch(() => undefined)
        return { text: ['tokens · this session', ...usageLines(usage, su)].join('\n') }
      }
      case 'enable':
        settings = { ...settings, enabled: cmd.on }
        await saveSettings($)
        if (cmd.on) await show()
        else {
          await $.ui.close({ id: PANE }).catch(() => undefined)
          open = false
        }
        redraw($)
        return { text: cmd.on ? `traj: on · a look every ${settings.every} steps` : 'traj: off · no looks, no model calls, pane closed · the phases are kept · /traj turns it back on' }
      case 'prompts':
        if (cmd.action === 'export') { await exportPrompts($); return { text: `traj: prompts written to ${promptsFile} · edit the sections, then /traj prompts load` } }
        if (cmd.action === 'load') { await loadPrompts($); return { text: `traj: ${state}` } }
        settings = { ...settings, prompts: {} }
        await saveSettings($)
        redraw($)
        return { text: 'traj: all four prompts back to default' }
      case 'every':
        settings = { ...settings, every: cmd.n }
        await saveSettings($)
        redraw($)
        return { text: `traj: a look every ${cmd.n} steps` }
      case 'window':
        settings = { ...settings, window: cmd.n }
        await saveSettings($)
        redraw($)
        return { text: `traj: the model sees the last ${cmd.n} steps` }
      case 'model':
        settings = { ...settings, model: cmd.model }
        await saveSettings($)
        redraw($)
        return { text: `traj: segments by ${cmd.model} from now on (an alias like haiku or sonnet, or a full model id)` }
      case 'clear':
        segments = []
        expanded.clear()
        await save($)
        redraw($)
        return { text: 'traj: segments cleared · the next look starts from the steps since the last one' }
      case 'stop':
        await $.ui.close({ id: PANE }).catch(() => undefined)
        open = false
        return { text: 'traj closed' }
      case 'help':
        return { text: [
          '/traj             turn the looks on and open the pane (off by default)',
          '/traj now         ask for a segment of the steps since the last one',
          '/traj backfill [full | N]   rebuild the phases over the whole conversation or the last N steps, with the current model and interval',
          '/traj btw [N] [question]   ask a side question about phase N (newest if omitted); no question opens the field',
          `/traj btw model NAME       which model answers btw questions (now ${settings.btwModel})`,
          `/traj off         turn the looks off and close the pane (now ${settings.enabled ? 'on' : 'off'}); the phases are kept`,
          '/traj settings    the settings frame: models, cadence, the four prompts, and tokens',
          '/traj tokens      tokens this session: the agent per model as reported, context and cost, and this plugin\'s calls (estimated)',
          `/traj prompts export|load|reset   the prompts as a markdown file at ${promptsFile}`,
          `/traj every N     look every N steps (now ${settings.every})`,
          `/traj window N    the model sees the last N steps (now ${settings.window})`,
          `/traj model NAME  which model writes them (now ${settings.model}; haiku, sonnet, opus, or a full id)`,
          '/traj clear       drop every segment',
          '/traj stop        hide the pane, looks keep running',
          '',
          'in the pane: click a title to expand it · transcript scrolls to where it starts · steps opens them · btw asks about it · ✕ dismisses',
          `${plural(segments.length, 'segment')} · ${last} steps covered · a step is a prompt, an assistant message, or one tool call`,
        ].join('\n') }
      default:
        return { text: `traj: no command "${cmd.arg}" · /traj help lists them` }
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    open = false
    return next(e)
  })
  on('ui.close', { id: DETAIL }, async ($, e, next) => {
    detail = undefined
    return next(e)
  })
  on('ui.close', { id: BTW }, async ($, e, next) => {
    btwOf = undefined
    btwAsk = undefined
    return next(e)
  })
  on('ui.close', { id: SETTINGS }, async ($, e, next) => next(e))
  on('ui.close', { id: EDIT }, async ($, e, next) => {
    const r = await next(e)
    editing = undefined
    // back to the frame the editor was opened from
    if (!('deny' in r && r.deny)) void openSettings($)
    return r
  })

  // what the editor posts: the draft after every edit, or a save on ctrl+s
  on('ui.message', async ($, e, next) => {
    if (!editing || e.element !== 'editor') return next(e)
    const data = e.data as { draft?: unknown; save?: unknown } | null
    if (typeof data?.draft === 'string') {
      const before = isTemplate(editing.key) ? unknownVariables(editing.draft, varsOf(editing.key)).join(',') : ''
      editing = { ...editing, draft: data.draft, saved: false }
      const after = isTemplate(editing.key) ? unknownVariables(data.draft, varsOf(editing.key)).join(',') : ''
      // the pane's own chrome (chars, unsaved, warnings) redraws only when something it shows changed
      if (before !== after) redraw($)
    }
    if (typeof data?.save === 'string') void savePrompt($, editing.key, data.save)
    return {}
  })

  // a look after every tool call and every turn, so a long turn is segmented while it runs
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    void segment($, false)
    return r
  })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    // the turn's cost as the API reported it, per model
    const u = e.usage
    if (u) {
      usage = addAgent(usage, u.model, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens })
      void saveUsage($)
    }
    void segment($, false)
    return r
  })

  // the pane is this plugin's own: nothing beneath draws into it, so `next` is not called
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = await $.ui.resolve(e)
    const width = e.props.bodyColumns
    const dismiss = (n: number) => {
      segments = segments.filter(s => s.n !== n)
      expanded.delete(n)
      void save($)
      redraw($)
    }
    const toggle = (n: number) => {
      if (expanded.has(n)) expanded.delete(n)
      else expanded.add(n)
      redraw($)
    }
    const now = () => { void segment($, true) }
    const clear = () => { segments = []; expanded.clear(); void save($); redraw($) }
    const close = () => { open = false; void $.ui.close({ id: PANE }).catch(() => undefined) }
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end"><Text bold>trajectory</Text>{settings.enabled ? '' : <Text color="yellow">{' · OFF'}</Text>}{` · ${settings.model} · every ${settings.every} steps · sees ${settings.window} · ${last} covered${state ? ` · ${state}` : ''}`}</Text>
        <Box flexDirection="row" columnGap={1}>
          <Button key="traj:now" label="now" onPress={now} />
          <Button key="traj:backfill" label="backfill" onPress={() => { backfillMenu = !backfillMenu; redraw($) }} />
          <Button key="traj:clear" label="clear" onPress={clear} />
          <Button key="traj:settings" label="settings" onPress={() => { void openSettings($) }} />
          <Button key="traj:close" label="close" onPress={close} />
        </Box>
        {backfillMenu ? (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow">
            <Text wrap="truncate-end"><Text bold color="yellow">{'backfill'}</Text>{` · rebuild the phases with ${settings.model}, every ${settings.every} steps (both in settings)`}</Text>
            <Box flexDirection="row" columnGap={1} flexWrap="wrap">
              <Button key="bf:full" label="whole conversation" onPress={() => { void backfill($, 0) }} />
              <Button key="bf:40" label="last 40 steps" onPress={() => { void backfill($, 40) }} />
              <Button key="bf:100" label="last 100 steps" onPress={() => { void backfill($, 100) }} />
              <Button key="bf:cancel" label="cancel" plain dimColor onPress={() => { backfillMenu = false; redraw($) }} />
            </Box>
          </Box>
        ) : null}
        {segments.length === 0
          ? <Text dimColor wrap="wrap">{`no segments yet · ${settings.model} looks every ${settings.every} steps and only writes when the path changes · now asks it right away`}</Text>
          : segments.map((s, idx) => {
            const isOpen = expanded.has(s.n)
            return (
              <Box key={`seg:${s.n}`} flexDirection="column" borderStyle="round" borderColor={idx === 0 ? 'cyan' : 'gray'} borderDimColor={idx !== 0} width={width}>
                <Box flexDirection="row" columnGap={1}>
                  <Text bold color="cyan">{`#${s.n}`}</Text>
                  <Text dimColor wrap="truncate-end">{`steps ${s.from}–${s.to} · ${clock(s.at)}${s.amended ? ` · amended ${clock(s.amended)}` : ''} · ${s.model}${s.decisions.length ? ` · ${s.decisions.length} dec` : ''}${s.qa?.length ? ` · ${s.qa.length} btw` : ''}`}</Text>
                  <Button key={`dismiss:${s.n}`} label="✕" plain dimColor onPress={() => dismiss(s.n)} />
                </Box>
                <Button key={`toggle:${s.n}`} label={`${isOpen ? '▾' : '▸'} ${s.title}`} plain hover={{ color: 'cyan' }} onPress={() => toggle(s.n)} />
                {isOpen ? <Text wrap="wrap" dimColor={idx !== 0}>{s.summary}</Text> : null}
                {isOpen && s.decisions.length ? <Text color="yellow" bold>{'decisions'}</Text> : null}
                {isOpen ? s.decisions.map((d, i) => (
                  <Box key={`dec:${s.n}:${i}`} flexDirection="column">
                    <Text color="yellow" wrap="wrap">{`• ${d.choice}`}</Text>
                    {d.why ? <Text dimColor wrap="wrap">{`  ↳ ${d.why}`}</Text> : null}
                  </Box>
                )) : null}
                {isOpen ? (
                  <Box flexDirection="row" columnGap={1}>
                    <Button key={`goto:${s.n}`} label="transcript" onPress={() => { void goTo($, s) }} />
                    <Button key={`steps:${s.n}`} label="steps" onPress={() => { void showSteps($, s.n) }} />
                    <Button key={`btw:${s.n}`} label="btw" onPress={() => { void askBtw($, s.n) }} />
                  </Box>
                ) : null}
              </Box>
            )
          })}
      </Box>
    )
  })

  // the steps of one segment, in a pane of its own that scrolls while it holds the keys
  on('ui.render', { component: 'Pane', requestId: DETAIL }, async ($, e) => {
    const { Box, Text, Button } = await $.ui.resolve(e)
    const seg = segments.find(s => s.n === detail)
    const close = () => { detail = undefined; void $.ui.close({ id: DETAIL }).catch(() => undefined) }
    if (!seg) return <Text dimColor>{'the segment was dismissed'}</Text>
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold color="cyan">{`#${seg.n}`}</Text>
          <Text wrap="truncate-end">{`steps ${seg.from}–${seg.to} · ${clock(seg.at)} · ${seg.model} · ${seg.steps.length} shown · Esc closes`}</Text>
          <Button key="detail:close" label="✕" plain dimColor onPress={close} />
        </Box>
        <Text bold wrap="wrap">{seg.title}</Text>
        <Text wrap="wrap">{seg.summary}</Text>
        {seg.decisions.length ? <Text bold color="yellow">{'decisions'}</Text> : null}
        {seg.decisions.map((d, i) => (
          <Box key={`dec:${seg.n}:${i}`} flexDirection="column">
            <Text color="yellow" wrap="wrap">{`• ${d.choice}`}</Text>
            {d.why ? <Text dimColor wrap="wrap">{`  ↳ ${d.why}`}</Text> : null}
          </Box>
        ))}
        <Text dimColor>{'— steps —'}</Text>
        {seg.steps.map((line, i) => <Text key={`step:${seg.n}:${i}`} wrap="wrap" dimColor={!line.includes(' tool] ')}>{line}</Text>)}
      </Box>
    )
  })

  // the side-question thread of one phase: newest answer first, a button to ask another
  on('ui.render', { component: 'Pane', requestId: BTW }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Input } = await $.ui.resolve(e)
    const seg = segments.find(x => x.n === btwOf)
    const close = () => { btwOf = undefined; void $.ui.close({ id: BTW }).catch(() => undefined) }
    if (!seg) return <Text dimColor>{'the phase was dismissed'}</Text>
    const thread = [...(seg.qa ?? [])].reverse()
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold color="cyan">{`btw #${seg.n}`}</Text>
          <Text wrap="truncate-end">{`${seg.title} · ${settings.btwModel} · Esc closes`}</Text>
          <Button key="btw:close" label="✕" plain dimColor onPress={close} />
        </Box>
        {btwAsk === seg.n && !asking ? (
          <Box flexDirection="column">
            <Input key="btw:question" label="ask" placeholder={`a question about #${seg.n} · Enter asks ${settings.btwModel}`} submitLabel="ask" autoFocus onSubmit={value => { if (value.trim()) void askBtw($, seg.n, value) }} />
            <Box flexDirection="row" columnGap={1} flexWrap="wrap">
              {btwChoices().map((q, i) => <Button key={`btw:stock:${i}`} label={q} plain onPress={() => { void askBtw($, seg.n, q) }} />)}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="row" columnGap={1}>
            <Button key="btw:again" label="ask another" onPress={() => { btwAsk = seg.n; redraw($) }} />
            <Button key="btw:steps" label="steps" onPress={() => { void showSteps($, seg.n) }} />
          </Box>
        )}
        {asking && btwOf === seg.n ? <Text color="yellow">{`asking ${settings.btwModel}…`}</Text> : null}
        {thread.length === 0 && !asking ? <Text dimColor>{'no questions yet'}</Text> : null}
        {thread.map((x, i) => (
          <Box key={`qa:${seg.n}:${x.at}:${i}`} flexDirection="column" borderStyle="round" borderColor={i === 0 ? 'cyan' : 'gray'} borderDimColor={i !== 0}>
            <Text bold wrap="wrap">{`Q: ${x.q}`}</Text>
            <Text wrap="wrap" dimColor={i !== 0}>{x.a}</Text>
            <Text dimColor>{`${clock(x.at)} · ${x.model}`}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  // the settings frame: what runs, how often, and the prompts, with the variable legend
  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Input } = await $.ui.resolve(e)
    const close = () => { void $.ui.close({ id: SETTINGS }).catch(() => undefined) }
    const su = await $.session.usage().catch(() => undefined)
    const tokens = usageLines(usage, su)
    // a field per setting: click it, type, Enter applies
    const field = (which: 'model' | 'btwModel' | 'every' | 'window', label: string, value: string, hint: string) => (
      <Box key={`set:${which}`} flexDirection="row" columnGap={1}>
        <Input key={`set:${which}:input`} label={label} value={value} placeholder={hint} submitLabel="apply" onSubmit={v => applySetting($, which, v)} />
        <Text dimColor wrap="truncate-end">{hint}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold color="cyan">{'settings'}</Text>
          <Text dimColor wrap="truncate-end">{'cc-traj-seg · Esc closes'}</Text>
          <Button key="settings:close" label="✕" plain dimColor onPress={close} />
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Text wrap="truncate-end"><Text dimColor>{'automatic looks: '}</Text>{settings.enabled ? 'on' : 'off (no model calls)'}</Text>
          <Button key="set:enabled:toggle" label={settings.enabled ? 'turn off' : 'turn on'} plain onPress={() => { settings = { ...settings, enabled: !settings.enabled }; void saveSettings($).then(() => redraw($)) }} />
        </Box>
        {field('model', 'phase model', settings.model, 'haiku · sonnet · opus · or a full id')}
        {field('every', 'look every', String(settings.every), 'steps, 1-500')}
        {field('window', 'model sees', String(settings.window), 'recent steps per look, 5-400')}
        {field('btwModel', 'btw model', settings.btwModel, 'haiku · sonnet · opus · or a full id')}
        <Text bold color="yellow">{'tokens · this session'}</Text>
        {tokens.map((l, i) => <Text key={`tok:${i}`} wrap="truncate-end" dimColor={l.startsWith('  ')} color={l.startsWith('  ') ? undefined : 'cyan'}>{l}</Text>)}
        <Text bold color="yellow">{'prompts'}</Text>
        {PROMPT_KEYS.map(k => {
          const custom = settings.prompts[k]
          const unknown = custom && isTemplate(k) ? unknownVariables(custom, varsOf(k)) : []
          return (
            <Box key={`prompt:${k}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text wrap="truncate-end">{PROMPT_LABELS[k]}<Text dimColor>{custom ? ` · custom, ${custom.length} chars` : ' · default'}</Text></Text>
                <Button key={`prompt:${k}:edit`} label="edit" plain onPress={() => { void editPrompt($, k) }} />
                {custom ? <Button key={`prompt:${k}:reset`} label="reset" plain dimColor onPress={() => { void resetPrompt($, k) }} /> : null}
              </Box>
              {unknown.length ? <Text color="red" wrap="wrap">{`  unknown variable${unknown.length === 1 ? '' : 's'}: ${unknown.map(u => `{{${u}}}`).join(' ')}`}</Text> : null}
            </Box>
          )
        })}
        <Box flexDirection="row" columnGap={1}>
          <Button key="prompts:export" label="export to file" onPress={() => { void exportPrompts($) }} />
          <Button key="prompts:load" label="load from file" onPress={() => { void loadPrompts($) }} />
        </Box>
        <Text dimColor wrap="wrap">{promptsFile}</Text>
        <Text bold color="yellow">{'variables · write them as {{name}}'}</Text>
        <Text dimColor>{'segmentation prompt template'}</Text>
        {VARIABLES.segment.map(v => <Text key={`var:seg:${v.name}`} wrap="wrap"><Text color="cyan">{`{{${v.name}}}`}</Text><Text dimColor>{`  ${v.legend}`}</Text></Text>)}
        <Text dimColor>{'btw prompt template'}</Text>
        {VARIABLES.btw.map(v => <Text key={`var:btw:${v.name}`} wrap="wrap"><Text color="cyan">{`{{${v.name}}}`}</Text><Text dimColor>{`  ${v.legend}`}</Text></Text>)}
        <Text dimColor wrap="wrap">{'edit opens a prompt in an editor pane: click in the text, type, ctrl+s or the save button. The system prompts have no variables; the templates are the user turn the model gets. The file round-trip is there for an external editor.'}</Text>
        {state ? <Text dimColor wrap="truncate-end">{state}</Text> : null}
      </Box>
    )
  })

  // the editor pane: one prompt, edited in place; the surface module under it holds the text
  on('ui.render', { component: 'Pane', requestId: EDIT }, async ($, e, next) => {
    // the editor is a surface module with a keyboard: terminal only
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button, Client } = await $.ui.resolve(e)
    if (!editing) return <Text dimColor>{'nothing is being edited · settings, then edit on a prompt'}</Text>
    const ed = editing
    const cols = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    const legend = isTemplate(ed.key) ? varsOf(ed.key) : []
    const unknown = isTemplate(ed.key) ? unknownVariables(ed.draft, legend) : []
    const missing = isTemplate(ed.key) && !/\{\{\s*short-horizon-context\s*\}\}/i.test(ed.draft)
    // chrome above and below the text: header, buttons, hint, legend, warnings
    const chrome = 4 + (legend.length ? legend.length + 1 : 0) + (unknown.length ? 1 : 0) + (missing ? 1 : 0)
    const height = Math.max(4, rows - chrome)
    const close = () => { editing = undefined; void $.ui.close({ id: EDIT }).catch(() => undefined) }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text bold color="cyan">{'edit'}</Text>
          <Text wrap="truncate-end">{`${PROMPT_LABELS[ed.key]} · ${ed.draft.length} chars · ${ed.saved ? (settings.prompts[ed.key] ? 'custom, saved' : 'default') : 'unsaved'}`}</Text>
          <Button key="edit:close" label="✕" plain dimColor onPress={close} />
        </Box>
        <Box flexDirection="row" columnGap={1}>
          <Button key="edit:save" label="save" onPress={() => { void savePrompt($, ed.key, ed.draft) }} />
          <Button key="edit:reset" label="reset to default" plain onPress={() => { void resetPrompt($, ed.key) }} />
          <Button key="edit:export" label="export to file" plain dimColor onPress={() => { void exportPrompts($) }} />
        </Box>
        <Client key="editor" module="./editor.tsx" width={cols} height={height} props={{ text: ed.draft, version: ed.version }} />
        <Text dimColor wrap="truncate-end">{'click in the text to type · Enter breaks a line · ctrl+s saves · Esc gives the keyboard back'}</Text>
        {legend.map(v => <Text key={`edit:var:${v.name}`} wrap="truncate-end"><Text color="cyan">{`{{${v.name}}}`}</Text><Text dimColor>{`  ${v.legend}`}</Text></Text>)}
        {unknown.length ? <Text color="red" wrap="wrap">{`unknown variable${unknown.length === 1 ? '' : 's'}: ${unknown.map(u => `{{${u}}}`).join(' ')}`}</Text> : null}
        {missing ? <Text color="yellow" wrap="wrap">{'no {{short-horizon-context}}: the model would never see the steps'}</Text> : null}
      </Box>
    )
  })
}
