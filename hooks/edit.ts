// A small text buffer for the in-pane prompt editor: lines, a cursor, the edits a keyboard makes,
// soft wrapping to a width with the cursor mapped onto the wrapped rows, and the split of a line
// into plain text and {{variable}} tokens for colouring. Pure; the editor surface module drives it.

export type Buf = { lines: string[]; row: number; col: number }
export type Dir = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'top' | 'bottom' | 'pageup' | 'pagedown'
export type Seg = { text: string; row: number; start: number }
export type Token = { text: string; kind: 'text' | 'var' }

export const fromText = (text: string): Buf => ({ lines: text.split('\n'), row: 0, col: 0 })
export const toText = (b: Buf) => b.lines.join('\n')

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const chars = (s: string) => [...s]

// text typed at the cursor (no newlines: those are `newline`)
export function insert(b: Buf, text: string): Buf {
  const line = chars(b.lines[b.row] ?? '')
  const next = [...line.slice(0, b.col), ...chars(text), ...line.slice(b.col)].join('')
  const lines = [...b.lines]
  lines[b.row] = next
  return { lines, row: b.row, col: b.col + chars(text).length }
}

export function newline(b: Buf): Buf {
  const line = chars(b.lines[b.row] ?? '')
  const lines = [...b.lines]
  lines.splice(b.row, 1, line.slice(0, b.col).join(''), line.slice(b.col).join(''))
  return { lines, row: b.row + 1, col: 0 }
}

export function backspace(b: Buf): Buf {
  if (b.col > 0) {
    const line = chars(b.lines[b.row])
    const lines = [...b.lines]
    lines[b.row] = [...line.slice(0, b.col - 1), ...line.slice(b.col)].join('')
    return { lines, row: b.row, col: b.col - 1 }
  }
  if (b.row === 0) return b
  const prev = b.lines[b.row - 1]
  const lines = [...b.lines]
  lines.splice(b.row - 1, 2, prev + b.lines[b.row])
  return { lines, row: b.row - 1, col: chars(prev).length }
}

export function del(b: Buf): Buf {
  const line = chars(b.lines[b.row])
  if (b.col < line.length) {
    const lines = [...b.lines]
    lines[b.row] = [...line.slice(0, b.col), ...line.slice(b.col + 1)].join('')
    return { lines, row: b.row, col: b.col }
  }
  if (b.row >= b.lines.length - 1) return b
  const lines = [...b.lines]
  lines.splice(b.row, 2, b.lines[b.row] + b.lines[b.row + 1])
  return { lines, row: b.row, col: b.col }
}

export function move(b: Buf, dir: Dir, page = 10): Buf {
  const len = (r: number) => chars(b.lines[r] ?? '').length
  const last = b.lines.length - 1
  switch (dir) {
    case 'left': return b.col > 0 ? { ...b, col: b.col - 1 } : b.row > 0 ? { ...b, row: b.row - 1, col: len(b.row - 1) } : b
    case 'right': return b.col < len(b.row) ? { ...b, col: b.col + 1 } : b.row < last ? { ...b, row: b.row + 1, col: 0 } : b
    case 'up': return b.row > 0 ? { ...b, row: b.row - 1, col: clamp(b.col, 0, len(b.row - 1)) } : { ...b, col: 0 }
    case 'down': return b.row < last ? { ...b, row: b.row + 1, col: clamp(b.col, 0, len(b.row + 1)) } : { ...b, col: len(b.row) }
    case 'home': return { ...b, col: 0 }
    case 'end': return { ...b, col: len(b.row) }
    case 'top': return { ...b, row: 0, col: 0 }
    case 'bottom': return { ...b, row: last, col: len(last) }
    case 'pageup': { const row = clamp(b.row - page, 0, last); return { ...b, row, col: clamp(b.col, 0, len(row)) } }
    case 'pagedown': { const row = clamp(b.row + page, 0, last); return { ...b, row, col: clamp(b.col, 0, len(row)) } }
  }
}

// one logical line soft-wrapped to `width` columns, breaking after the last space that fits;
// each segment remembers where in the line it starts
export function wrapLine(line: string, row: number, width: number): Seg[] {
  const w = Math.max(1, width)
  const cs = chars(line)
  if (cs.length === 0) return [{ text: '', row, start: 0 }]
  const out: Seg[] = []
  let start = 0
  while (start < cs.length) {
    let end = Math.min(cs.length, start + w)
    if (end < cs.length) {
      const space = cs.lastIndexOf(' ', end - 1)
      if (space > start) end = space + 1
    }
    out.push({ text: cs.slice(start, end).join(''), row, start })
    start = end
  }
  return out
}

// the whole buffer as wrapped rows, and where the cursor lands among them
export function layout(b: Buf, width: number): { rows: Seg[]; cursor: { vr: number; vc: number } } {
  const rows: Seg[] = []
  let cursor = { vr: 0, vc: 0 }
  b.lines.forEach((line, r) => {
    const segs = wrapLine(line, r, width)
    if (r === b.row) {
      // the segment holding the cursor: the last one starting at or before it, unless the cursor
      // is inside an earlier one
      let idx = segs.findIndex(s => b.col < s.start + chars(s.text).length)
      if (idx === -1) idx = segs.length - 1
      cursor = { vr: rows.length + idx, vc: b.col - segs[idx].start }
    }
    rows.push(...segs)
  })
  return { rows, cursor }
}

// a click at a wrapped row and column, back to the buffer position
export function place(b: Buf, rows: Seg[], vr: number, vc: number): Buf {
  const seg = rows[clamp(vr, 0, rows.length - 1)]
  if (!seg) return b
  return { ...b, row: seg.row, col: seg.start + clamp(vc, 0, chars(seg.text).length) }
}

// plain text and {{variable}} tokens, for colouring
export function tokens(text: string): Token[] {
  const out: Token[] = []
  const re = /\{\{\s*[a-z0-9-]+\s*\}\}/gi
  let i = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > i) out.push({ text: text.slice(i, m.index), kind: 'text' })
    out.push({ text: m[0], kind: 'var' })
    i = m.index! + m[0].length
  }
  if (i < text.length) out.push({ text: text.slice(i), kind: 'text' })
  return out
}
