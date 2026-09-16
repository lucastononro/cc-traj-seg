import { describe, expect, test } from 'bun:test'
import { anchorOf, btwChoices, btwPrompt, DEFAULT_BTW_TEMPLATE, DEFAULT_SEG_TEMPLATE, depthOptions, due, everyChoices, mergeDecisions, modelChoices, parse, parseArgs, parseDepth, parsePrompts, prompt, render, serializePrompts, splitNote, stepLines, steps, toolLine, unknownVariables, VARIABLES, type Message, type Note, type Segment } from '../hooks/traj.ts'

const user = (text: string): Message => ({ role: 'user', text, toolUses: [] })
const bot = (text: string, tools: Message['toolUses'] = []): Message => ({ role: 'assistant', text, toolUses: tools })
const results = (): Message => ({ role: 'user', text: '', toolUses: [], toolResults: [{}] })
const note = (choice: string, why = ''): Note => ({ choice, why })
const seg = (n: number, from: number, to: number, title: string, summary = title, decisions: Note[] = []): Segment => ({ n, from, to, at: 0, model: 'haiku', title, summary, decisions, steps: [] })

describe('traj', () => {
  test('steps: a prompt, an assistant message with text, and one per tool call; tool-result entries are plumbing', () => {
    const s = steps([user('fix it'), bot('', [{ tool_use_id: 'tu1', tool: 'Bash', input: { command: 'ls' }, text: 'a\nb' }, { tool: 'Read', input: { file_path: '/x/y/z.ts' } }]), results(), bot('done')])
    expect(s.map(x => `${x.i}:${x.kind}`)).toEqual(['1:user', '2:tool', '3:tool', '4:assistant'])
    expect(s[1].line).toBe('Bash(ls) → ok: a b')
    expect(s[1].id).toBe('tu1')
    expect(s[2].line).toBe('Read(y/z.ts)')
    expect(s[0].text).toBe('fix it')
  })

  test('toolLine shows the argument that says what it did, and an error', () => {
    expect(toolLine({ tool: 'Grep', input: { pattern: 'TODO' }, text: 'no match', isError: true })).toBe('Grep(TODO) → error: no match')
    expect(toolLine({ tool: 'Edit', input: { file_path: '/a/b/hooks/register.tsx' } })).toBe('Edit(hooks/register.tsx)')
    expect(toolLine({ tool: 'Task', input: { prompt: 'x'.repeat(200) } }).length).toBeLessThan(100)
  })

  test('a look is due every N steps, counting from the last covered one', () => {
    expect(due(10, 0, 10)).toBe(true)
    expect(due(9, 0, 10)).toBe(false)
    expect(due(20, 10, 10)).toBe(true)
  })

  test('the anchor is the first tool row, else the first message text, else a later tool row', () => {
    const all = steps([user('go'), bot('', [{ tool_use_id: 'tu1', tool: 'Bash', input: { command: 'ls' } }]), bot('ok')])
    expect(anchorOf(all, 1, 3)).toEqual({ anchorText: 'go' })
    expect(anchorOf(all, 2, 3)).toEqual({ anchor: 'tu1' })
    expect(anchorOf(all, 9, 9)).toEqual({})
    expect(stepLines(all, 2, 3)).toEqual(['[2 tool] Bash(ls)', '[3 assistant] ok'])
  })

  test('the prompt carries the segments so far and a window of steps with the new ones marked', () => {
    const all = steps(Array.from({ length: 30 }, (_, i) => (i % 2 ? bot(`reply ${i}`) : user(`ask ${i}`))))
    // stored newest first, as the hooks module keeps them; the prompt reads oldest first
    const segs = [seg(2, 11, 20, 'Writing tests'), seg(1, 1, 10, 'Setting up the repo', 'cloned, installed', [note('chose bun over npm', 'faster installs')])]
    const p = prompt(segs, all, 20, 15)
    expect(p).toContain('#1 (steps 1-10) Setting up the repo\ncloned, installed\ndecisions: chose bun over npm — faster installs')
    expect(p.indexOf('#1 (steps')).toBeLessThan(p.indexOf('#2 (steps'))
    expect(p).toContain('LAST 15 STEPS (30 in the session, 10 new)')
    expect(p).not.toContain('[15 user]')
    expect(p).toContain('[16 assistant]')
    expect(p).toContain('--- NEW STEPS ---\n[21 user] ask 20')
    expect(p.endsWith('Decision:')).toBe(true)
  })

  test('a window that only holds new steps says the earlier ones were cut', () => {
    const all = steps(Array.from({ length: 30 }, (_, i) => user(`ask ${i}`)))
    expect(prompt([], all, 10, 5)).toContain('--- NEW STEPS (earlier ones cut) ---\n[26 user]')
    expect(prompt([], steps([user('hi')]), 0, 40)).toContain('(none yet: the first reply is NEW)')
  })

  test('parse: SKIP, AMEND and NEW; a terse summary and structured decisions', () => {
    expect(parse('SKIP')).toEqual({ kind: 'skip' })
    expect(parse('skip.\nnothing new')).toEqual({ kind: 'skip' })
    expect(parse('AMEND\nTITLE: **Running** the `tests`\nSUMMARY: 12 pass, one left.')).toEqual({ kind: 'amend', title: 'Running the tests', summary: '12 pass, one left.', decisions: [] })
    // a DECISIONS section, each line split into choice and why
    expect(parse('NEW\nTITLE: Fixing the build\nSUMMARY: It broke on the types.\nDECISIONS:\n- Pinned tsc to 5 — the loose range fails\n* Skipped codegen: not the cause')).toEqual({
      kind: 'new', title: 'Fixing the build', summary: 'It broke on the types.',
      decisions: [{ choice: 'Pinned tsc to 5', why: 'the loose range fails' }, { choice: 'Skipped codegen', why: 'not the cause' }],
    })
    // a decision with no reason keeps an empty why
    expect(parse('NEW\nTITLE: A\nSUMMARY: b\nDECISIONS: chose X')).toEqual({ kind: 'new', title: 'A', summary: 'b', decisions: [{ choice: 'chose X', why: '' }] })
    // no decision word and no markers: a new segment, title then summary, no decisions
    expect(parse('Fixing the build\nIt broke on the types.')).toEqual({ kind: 'new', title: 'Fixing the build', summary: 'It broke on the types.', decisions: [] })
    expect(parse('NEW\n')).toEqual({ kind: 'skip' })
  })

  test('splitNote divides a choice from its why on the first em-dash, dash or colon', () => {
    expect(splitNote('used npx — bun missing')).toEqual({ choice: 'used npx', why: 'bun missing' })
    expect(splitNote('used npx - bun missing')).toEqual({ choice: 'used npx', why: 'bun missing' })
    expect(splitNote('runner: npx')).toEqual({ choice: 'runner', why: 'npx' })
    expect(splitNote('kept bun --version as the probe — it is canonical')).toEqual({ choice: 'kept bun --version as the probe', why: 'it is canonical' })
    expect(splitNote('just a choice')).toEqual({ choice: 'just a choice', why: '' })
  })

  test('mergeDecisions appends new choices, drops case-insensitive duplicate choices, keeps newest', () => {
    expect(mergeDecisions([note('a', 'x'), note('b', 'y')], [note('B', 'y2'), note('c', 'z')])).toEqual([note('a', 'x'), note('b', 'y'), note('c', 'z')])
    expect(mergeDecisions([], [note('one', 'r')]).length).toBe(1)
    expect(mergeDecisions(Array.from({ length: 6 }, (_, i) => note(`d${i}`)), [note('new', 'r')], 6).slice(-1)).toEqual([note('new', 'r')])
  })

  test('parseArgs', () => {
    expect(parseArgs('')).toEqual({ kind: 'toggle' })
    expect(parseArgs('every 5')).toEqual({ kind: 'every', n: 5 })
    expect(parseArgs('window 2')).toEqual({ kind: 'unknown', arg: 'window 2' })
    expect(parseArgs('model claude-sonnet-5')).toEqual({ kind: 'model', model: 'claude-sonnet-5' })
    expect(parseArgs('model "x y"')).toEqual({ kind: 'unknown', arg: 'model "x y"' })
    expect(parseArgs('status')).toEqual({ kind: 'help' })
  })

  test('parseArgs backfill, and parseDepth from the dialog answer', () => {
    expect(parseArgs('backfill')).toEqual({ kind: 'backfill' })
    expect(parseArgs('catchup')).toEqual({ kind: 'backfill' })
    expect(parseDepth('Full conversation', 200)).toBe(0)
    expect(parseDepth('everything', 200)).toBe(0)
    expect(parseDepth('Last 40 steps', 200)).toBe(160)
    expect(parseDepth('last 1,000', 200)).toBe(0)   // asked for more than exists: from the start
    expect(parseDepth('no idea', 200)).toBe(0)      // unparseable: full
  })

  test('modelChoices puts the current model first and dedupes', () => {
    expect(modelChoices('haiku')).toEqual(['haiku', 'sonnet', 'opus'])
    expect(modelChoices('claude-opus-5')).toEqual(['claude-opus-5', 'haiku', 'sonnet', 'opus'])
    expect(modelChoices('sonnet')).toEqual(['sonnet', 'haiku', 'opus'])
  })

  test('depthOptions never repeats a span, and stays inside 2-4 unique labels', () => {
    expect(depthOptions(500)).toEqual(['Full conversation', 'Last 40 steps', 'Last 100 steps', 'Last 200 steps'])
    expect(depthOptions(11)).toEqual(['Full conversation', 'Last 5 steps'])  // no cutoff < 11, so half
    expect(depthOptions(50)).toEqual(['Full conversation', 'Last 40 steps'])
    for (const c of [1, 2, 3, 40, 41, 300]) expect(new Set(depthOptions(c)).size).toBe(depthOptions(c).length)
  })

  test('everyChoices puts the current interval first and dedupes', () => {
    expect(everyChoices(10)).toEqual(['10', '5', '20', '30'])
    expect(everyChoices(7)).toEqual(['7', '5', '10', '20'])
  })

  test('parseArgs btw: a dialog, a question about the newest phase, about #N, and the model', () => {
    expect(parseArgs('btw')).toEqual({ kind: 'btw' })
    expect(parseArgs('btw why did it retry?')).toEqual({ kind: 'btw', question: 'why did it retry?' })
    expect(parseArgs('btw 3')).toEqual({ kind: 'btw', n: 3 })
    expect(parseArgs('btw #3 what failed?')).toEqual({ kind: 'btw', n: 3, question: 'what failed?' })
    expect(parseArgs('btw model opus')).toEqual({ kind: 'btwModel', model: 'opus' })
    expect(btwChoices().length).toBeGreaterThanOrEqual(2)
  })

  test('btwPrompt puts every phase in the outline, marks the focus, and gives it in full', () => {
    const a: Segment = { ...seg(1, 1, 6, 'Exploring', 'looked around', [note('used ls', 'cheap')]), steps: ['[1 user] go', '[2 tool] Bash(ls)'] }
    const b: Segment = { ...seg(2, 7, 12, 'Testing', 'ran tests'), qa: [{ q: 'earlier?', a: 'yes', at: 0, model: 'sonnet' }] }
    const p = btwPrompt([b, a], b, 'what ran?')
    expect(p).toContain('#1 (steps 1-6) Exploring\nlooked around\ndecisions: used ls — cheap')
    expect(p).toContain('#2 (steps 7-12) [IN FOCUS] Testing')
    expect(p).toContain('PHASE IN FOCUS: #2 (steps 7-12) Testing')
    expect(p).toContain('EARLIER QUESTIONS ABOUT THIS PHASE:\nQ: earlier?\nA: yes')
    expect(p.endsWith('QUESTION: what ran?\n\nANSWER:')).toBe(true)
    expect(btwPrompt([a], a, 'x')).toContain('steps:\n[1 user] go\n[2 tool] Bash(ls)')
  })

  test('render substitutes {{variables}} (spaces and case tolerated) and leaves unknown ones visible', () => {
    expect(render('a {{x}} b {{ Y }} c {{nope}}', { x: 1, y: 'two' })).toBe('a 1 b two c {{nope}}')
    expect(unknownVariables('{{long-horizon-context}} {{typo}} {{Window}}', VARIABLES.segment)).toEqual(['typo'])
  })

  test('a custom segmentation template gets the same variables as the default', () => {
    const all = steps([user('go'), bot('ok', [{ tool: 'Bash', input: { command: 'ls' } }])])
    const p = prompt([], all, 0, 40, 'MEM:\n{{long-horizon-context}}\nRECENT ({{steps-shown}}/{{step-count}}, {{new-count}} new, window {{window}}):\n{{short-horizon-context}}\nGo.')
    expect(p).toBe('MEM:\n(none yet: the first reply is NEW)\nRECENT (3/3, 3 new, window 40):\n--- NEW STEPS ---\n[1 user] go\n[2 assistant] ok\n[3 tool] Bash(ls)\nGo.')
    // the default template reproduces the built-in prompt shape
    expect(prompt([], all, 0, 40)).toBe(prompt([], all, 0, 40, DEFAULT_SEG_TEMPLATE))
    expect(btwPrompt([seg(1, 1, 3, 'T')], seg(1, 1, 3, 'T'), 'q?')).toBe(btwPrompt([seg(1, 1, 3, 'T')], seg(1, 1, 3, 'T'), 'q?', DEFAULT_BTW_TEMPLATE))
    expect(btwPrompt([seg(1, 1, 3, 'T')], seg(1, 1, 3, 'T'), 'q?', '{{phase}}: {{question}}')).toBe('1: q?')
  })

  test('the prompts file round-trips: custom sections come back, default or empty ones clear', () => {
    const systems = { seg: 'SEG SYS', btw: 'BTW SYS' }
    const text = serializePrompts({ segTemplate: 'MINE {{short-horizon-context}}', btwSystem: 'be brief' }, systems)
    expect(text).toContain('## segmentation prompt template\n\nMINE {{short-horizon-context}}\n')
    expect(text).toContain('## segmentation system prompt\n\nSEG SYS\n')
    expect(text).toContain('{{long-horizon-context}}')
    expect(parsePrompts(text, systems)).toEqual({ segTemplate: 'MINE {{short-horizon-context}}', btwSystem: 'be brief' })
    expect(parsePrompts(text.replace('MINE {{short-horizon-context}}', ''), systems)).toEqual({ btwSystem: 'be brief' })
    expect(parsePrompts('no sections here', systems)).toEqual({})
  })

  test('parseArgs settings and prompts', () => {
    expect(parseArgs('settings')).toEqual({ kind: 'settings' })
    expect(parseArgs('prompts export')).toEqual({ kind: 'prompts', action: 'export' })
    expect(parseArgs('prompts LOAD')).toEqual({ kind: 'prompts', action: 'load' })
    expect(parseArgs('prompts reset')).toEqual({ kind: 'prompts', action: 'reset' })
    expect(parseArgs('prompts nope')).toEqual({ kind: 'unknown', arg: 'prompts nope' })
  })
})
