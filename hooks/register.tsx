/* @jsx h */
import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import { anchorOf, clock, DEFAULTS, due, parse, parseArgs, prompt, stepLines, steps, SYSTEM, type Segment, type Settings } from './traj.ts'

// /traj: a pane of trajectory segments. After every tool call and every turn the module counts
// the session's steps and, every N of them, hands a model the segments so far and the last W
// steps. The model answers SKIP, AMEND or NEW; only the last two touch the pane. A segment is a
// card: its title, and on a click its summary, a button that scrolls the transcript to where it
// starts, a button that opens its steps in a second pane, and an ✕. Settings live in $.store; the
// segments under the session id, so a resumed session shows its own.

const PANE = 'traj'
const DETAIL = 'traj-steps'
const MAX_SEGMENTS = 60

let sessionId = ''
let settings: Settings = { ...DEFAULTS }
let last = 0 // steps covered by the segments so far
let segments: Segment[] = []
let open = false
let busy = false
let state = ''
let detail: number | undefined
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

// the work that outlives a hook: a completion can take longer than a hook's budget, so nothing
// awaits this from a hook; it redraws the pane when it is done
async function segment($: EngineInterface, force: boolean) {
  if (busy) return
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
  state = `reading steps ${last + 1}-${count}…`
  redraw($)
  const from = last + 1
  const to = count
  try {
    const reply = await $.model.complete({ model: settings.model, prompt: prompt(segments, all, last, settings.window), system: SYSTEM, maxTokens: 500 })
    const decision = parse(reply)
    const at = await $.clock.now()
    last = to
    if (decision.kind === 'skip') {
      state = `steps ${from}-${to}: nothing new`
    } else if (decision.kind === 'amend' && segments.length > 0) {
      const [head, ...rest] = segments
      segments = [{ ...head, to, title: decision.title, summary: decision.summary, steps: [...head.steps, ...stepLines(all, from, to)].slice(-80), amended: at }, ...rest]
      state = `#${head.n} amended at step ${to}`
    } else {
      const seg: Segment = { n: (segments[0]?.n ?? 0) + 1, from, to, at, model: settings.model, title: decision.title, summary: decision.summary, steps: stepLines(all, from, to), ...anchorOf(all, from, to) }
      segments = [seg, ...segments].slice(0, MAX_SEGMENTS)
      state = `#${seg.n} at step ${to}`
      $.ui.toast(`traj #${seg.n}: ${seg.title}`, { timeoutMs: 6000 })
      if (!open) {
        // a pane the plugin opens on its own waits undrawn under 144 columns until /traj asks
        await $.ui.open({ id: PANE, title: 'Trajectory' }).then(() => { open = true }).catch(() => undefined)
      }
    }
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
      }
    }
    const saved = (await $.store.get(KEY()).catch(() => undefined)) as { last?: unknown; segments?: unknown } | undefined
    if (saved && typeof saved.last === 'number' && Array.isArray(saved.segments)) {
      last = saved.last
      segments = (saved.segments as Segment[]).map(x => ({ ...x, steps: Array.isArray(x.steps) ? x.steps : [], summary: x.summary ?? x.title ?? '' }))
    }
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
      case 'toggle':
        if (open) {
          await $.ui.close({ id: PANE }).catch(() => undefined)
          open = false
          return { text: 'traj closed · /traj opens it again' }
        }
        await show()
        return { text: `traj: ${plural(segments.length, 'segment')} · ${settings.model} looks every ${settings.every} steps at the last ${settings.window} · click a card to expand it · /traj now asks for one now` }
      case 'now':
        await show()
        void segment($, true)
        return { text: busy ? 'traj: already at it' : 'traj: asking for a segment of the steps since the last one…' }
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
          '/traj             open or close the pane',
          '/traj now         ask for a segment of the steps since the last one',
          `/traj every N     look every N steps (now ${settings.every})`,
          `/traj window N    the model sees the last N steps (now ${settings.window})`,
          `/traj model NAME  which model writes them (now ${settings.model}; haiku, sonnet, opus, or a full id)`,
          '/traj clear       drop every segment',
          '/traj stop        close the pane',
          '',
          'in the pane: click a title to expand it · transcript scrolls to where it starts · steps opens them · ✕ dismisses',
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

  // a look after every tool call and every turn, so a long turn is segmented while it runs
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    void segment($, false)
    return r
  })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
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
        <Text wrap="truncate-end"><Text bold>trajectory</Text>{` · ${settings.model} · every ${settings.every} steps · sees ${settings.window} · ${last} covered${state ? ` · ${state}` : ''}`}</Text>
        <Box flexDirection="row" columnGap={1}>
          <Button key="traj:now" label="now" onPress={now} />
          <Button key="traj:clear" label="clear" onPress={clear} />
          <Button key="traj:close" label="close" onPress={close} />
        </Box>
        {segments.length === 0
          ? <Text dimColor wrap="wrap">{`no segments yet · ${settings.model} looks every ${settings.every} steps and only writes when the path changes · now asks it right away`}</Text>
          : segments.map((s, idx) => {
            const isOpen = expanded.has(s.n)
            return (
              <Box key={`seg:${s.n}`} flexDirection="column" borderStyle="round" borderColor={idx === 0 ? 'cyan' : 'gray'} borderDimColor={idx !== 0} width={width}>
                <Box flexDirection="row" columnGap={1}>
                  <Text bold color="cyan">{`#${s.n}`}</Text>
                  <Text dimColor wrap="truncate-end">{`steps ${s.from}–${s.to} · ${clock(s.at)}${s.amended ? ` · amended ${clock(s.amended)}` : ''} · ${s.model}`}</Text>
                  <Button key={`dismiss:${s.n}`} label="✕" plain dimColor onPress={() => dismiss(s.n)} />
                </Box>
                <Button key={`toggle:${s.n}`} label={`${isOpen ? '▾' : '▸'} ${s.title}`} plain hover={{ color: 'cyan' }} onPress={() => toggle(s.n)} />
                {isOpen ? <Text wrap="wrap" dimColor={idx !== 0}>{s.summary}</Text> : null}
                {isOpen ? (
                  <Box flexDirection="row" columnGap={1}>
                    <Button key={`goto:${s.n}`} label="transcript" onPress={() => { void goTo($, s) }} />
                    <Button key={`steps:${s.n}`} label="steps" onPress={() => { void showSteps($, s.n) }} />
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
        <Text dimColor>{'—'}</Text>
        {seg.steps.map((line, i) => <Text key={`step:${seg.n}:${i}`} wrap="wrap" dimColor={!line.includes(' tool] ')}>{line}</Text>)}
      </Box>
    )
  })
}
