import { describe, expect, test } from 'bun:test'
import { anchorOf, due, parse, parseArgs, prompt, stepLines, steps, toolLine, type Message, type Segment } from '../hooks/traj.ts'

const user = (text: string): Message => ({ role: 'user', text, toolUses: [] })
const bot = (text: string, tools: Message['toolUses'] = []): Message => ({ role: 'assistant', text, toolUses: tools })
const results = (): Message => ({ role: 'user', text: '', toolUses: [], toolResults: [{}] })
const seg = (n: number, from: number, to: number, title: string, summary = title): Segment => ({ n, from, to, at: 0, model: 'haiku', title, summary, steps: [] })

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
    const segs = [seg(2, 11, 20, 'Writing tests'), seg(1, 1, 10, 'Setting up the repo', 'cloned, installed')]
    const p = prompt(segs, all, 20, 15)
    expect(p).toContain('#1 (steps 1-10) Setting up the repo\ncloned, installed')
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

  test('parse: SKIP, AMEND and NEW with a title and a paragraph, markdown stripped', () => {
    expect(parse('SKIP')).toEqual({ kind: 'skip' })
    expect(parse('skip.\nnothing new')).toEqual({ kind: 'skip' })
    expect(parse('AMEND\nTITLE: **Running** the `tests`\nSUMMARY: 12 pass.\nOne left.')).toEqual({ kind: 'amend', title: 'Running the tests', summary: '12 pass. One left.' })
    expect(parse('NEW\nFixing the build\nIt broke on the types.')).toEqual({ kind: 'new', title: 'Fixing the build', summary: 'It broke on the types.' })
    // no decision word: a new segment; a title alone doubles as the summary; nothing at all is a skip
    expect(parse('Title: Fixing the build')).toEqual({ kind: 'new', title: 'Fixing the build', summary: 'Fixing the build' })
    expect(parse('NEW\n')).toEqual({ kind: 'skip' })
  })

  test('parseArgs', () => {
    expect(parseArgs('')).toEqual({ kind: 'toggle' })
    expect(parseArgs('every 5')).toEqual({ kind: 'every', n: 5 })
    expect(parseArgs('window 2')).toEqual({ kind: 'unknown', arg: 'window 2' })
    expect(parseArgs('model claude-sonnet-5')).toEqual({ kind: 'model', model: 'claude-sonnet-5' })
    expect(parseArgs('model "x y"')).toEqual({ kind: 'unknown', arg: 'model "x y"' })
    expect(parseArgs('status')).toEqual({ kind: 'help' })
  })
})
