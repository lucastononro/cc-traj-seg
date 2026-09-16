import { describe, expect, test } from 'bun:test'
import { backspace, del, fromText, insert, layout, move, newline, place, toText, tokens, wrapLine } from '../hooks/edit.ts'

describe('edit', () => {
  test('insert, newline, backspace and delete edit around the cursor, across lines too', () => {
    let b = fromText('ab')
    b = move(b, 'end'); b = insert(b, 'c'); expect(toText(b)).toBe('abc')
    b = move(b, 'left'); b = newline(b); expect(b).toEqual({ lines: ['ab', 'c'], row: 1, col: 0 })
    b = backspace(b); expect(b).toEqual({ lines: ['abc'], row: 0, col: 2 })
    b = del(b); expect(toText(b)).toBe('ab')
    b = newline(move(b, 'end')); b = move(b, 'up'); b = move(b, 'end'); b = del(b); expect(toText(b)).toBe('ab')
    expect(backspace(fromText('x'))).toEqual(fromText('x'))
    expect(insert(fromText(''), 'héllo')).toEqual({ lines: ['héllo'], row: 0, col: 5 })
  })

  test('movement clamps the column and stops at the edges', () => {
    let b = { lines: ['long line', 'ab', ''], row: 0, col: 7 }
    b = move(b, 'down'); expect([b.row, b.col]).toEqual([1, 2])
    b = move(b, 'down'); expect([b.row, b.col]).toEqual([2, 0])
    b = move(b, 'down'); expect([b.row, b.col]).toEqual([2, 0])
    b = move(b, 'right'); expect([b.row, b.col]).toEqual([2, 0])
    b = move(b, 'left'); expect([b.row, b.col]).toEqual([1, 2])
    b = move(b, 'top'); expect([b.row, b.col]).toEqual([0, 0])
    b = move(b, 'bottom'); expect([b.row, b.col]).toEqual([2, 0])
    expect(move({ lines: Array.from({ length: 30 }, (_, i) => `l${i}`), row: 25, col: 1 }, 'pageup', 10).row).toBe(15)
  })

  test('wrapLine breaks after the last space that fits, or hard when there is none', () => {
    expect(wrapLine('the quick brown fox', 0, 10).map(s => [s.text, s.start])).toEqual([['the quick ', 0], ['brown fox', 10]])
    expect(wrapLine('abcdefghij', 0, 4).map(s => s.text)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapLine('', 3, 4)).toEqual([{ text: '', row: 3, start: 0 }])
  })

  test('layout maps the cursor onto the wrapped rows, and place maps a click back', () => {
    const b = { lines: ['the quick brown fox', 'z'], row: 0, col: 12 }
    const { rows, cursor } = layout(b, 10)
    expect(rows.length).toBe(3)
    expect(cursor).toEqual({ vr: 1, vc: 2 })
    // the cursor at the very end of a wrapped line sits on the last segment
    expect(layout({ ...b, col: 19 }, 10).cursor).toEqual({ vr: 1, vc: 9 })
    expect(place(b, rows, 2, 5)).toEqual({ ...b, row: 1, col: 1 })
    expect(place(b, rows, 0, 3)).toEqual({ ...b, row: 0, col: 3 })
  })

  test('tokens split out {{variables}} for colouring', () => {
    expect(tokens('a {{x}} b {{ y-z }}')).toEqual([
      { text: 'a ', kind: 'text' }, { text: '{{x}}', kind: 'var' }, { text: ' b ', kind: 'text' }, { text: '{{ y-z }}', kind: 'var' },
    ])
    expect(tokens('plain')).toEqual([{ text: 'plain', kind: 'text' }])
  })
})
