/* @jsx h */
import type { ClientSurface } from 'claude-code'
import { backspace, del, fromText, insert, layout, move, newline, place, toText, tokens, type Buf, type Dir } from './edit.ts'

// The prompt editor: a surface module with its own keyboard. A click gives it the keys; printable
// keys type, Enter breaks a line, Backspace and Delete edit, the arrows, Home, End and PageUp/Down
// move, Tab indents, ctrl+s saves. Every change is posted to the hooks module as the draft, so the
// save button there has the latest text; ctrl+s posts a save. Esc never arrives: it returns the
// keyboard to the prompt and the draft stays.
//
// Never name a local `h` in this file: every JSX tag compiles to a call of `h`.

type Props = { text?: string; version?: number } | undefined
type State = { buf: Buf; version: number; scroll: number; typed: boolean }

const DIRS = new Set<string>(['left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown'])
// key names the terminal may hand over that are not text; anything else longer than one character
// is a paste, delivered as one event holding the whole text
const NAMED = new Set<string>(['return', 'tab', 'backspace', 'delete', 'insert', 'escape', 'space', ...DIRS, ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)])

// pasted text typed in: each newline breaks a line
function paste(buf: Buf, text: string): Buf {
  const parts = text.replace(/\r\n?/g, '\n').split('\n')
  return parts.reduce((b, part, i) => insert(i === 0 ? b : newline(b), part), buf)
}

export default function Editor(props: Props, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const width = () => Math.max(10, surface.columns - 1)
  const height = () => Math.max(3, surface.rows - 1)

  if (surface.state === undefined) {
    surface.setState({ buf: fromText(props?.text ?? ''), version: props?.version ?? 0, scroll: 0, typed: false })
    surface.onKey(ev => {
      const s = surface.state
      if (!s) return
      const k = ev.key === 'space' ? ' ' : ev.key
      let buf = s.buf
      let edited = false
      if (ev.ctrl && k.toLowerCase() === 's') {
        surface.post({ save: toText(buf) })
        return
      }
      if (ev.ctrl && k.toLowerCase() === 'a') buf = move(buf, 'home')
      else if (ev.ctrl && k.toLowerCase() === 'e') buf = move(buf, 'end')
      else if (ev.ctrl && k === 'home') buf = move(buf, 'top')
      else if (ev.ctrl && k === 'end') buf = move(buf, 'bottom')
      else if (ev.ctrl || ev.meta) return
      else if (k === 'return') { buf = newline(buf); edited = true }
      else if (k === 'backspace') { buf = backspace(buf); edited = true }
      else if (k === 'delete') { buf = del(buf); edited = true }
      else if (k === 'tab') { buf = insert(buf, '  '); edited = true }
      else if (DIRS.has(k)) buf = move(buf, k as Dir, Math.max(1, height() - 1))
      else if ([...k].length === 1 && k >= ' ') { buf = insert(buf, k); edited = true }
      else if ([...k].length > 1 && !NAMED.has(k)) { buf = paste(buf, k); edited = true }
      else return
      if (edited) surface.post({ draft: toText(buf) })
      surface.setState({ ...s, buf, typed: s.typed || edited })
    })
    surface.onPointer(ev => {
      const s = surface.state
      if (!s || ev.type !== 'down') return
      const { rows } = layout(s.buf, width())
      surface.setState({ ...s, buf: place(s.buf, rows, s.scroll + ev.y, ev.x) })
    })
  }

  const s = surface.state
  // another prompt opened, or a reset: reload the buffer
  if (s && props?.version !== undefined && props.version !== s.version) {
    surface.setState({ ...s, buf: fromText(props.text ?? ''), version: props.version, scroll: 0, typed: false })
  }
  const buf = s?.buf ?? fromText(props?.text ?? '')
  const w = width()
  const hgt = height()
  const { rows, cursor } = layout(buf, w)
  // keep the cursor row inside the window
  let scroll = s?.scroll ?? 0
  if (cursor.vr < scroll) scroll = cursor.vr
  if (cursor.vr >= scroll + hgt) scroll = cursor.vr - hgt + 1
  scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - hgt)))
  if (s && scroll !== s.scroll) surface.setState({ ...s, scroll })

  const visible = rows.slice(scroll, scroll + hgt)
  const paint = (text: string) => tokens(text).map((t, i) => (t.kind === 'var' ? <Text key={`t${i}`} color="cyan">{t.text}</Text> : <Text key={`t${i}`}>{t.text}</Text>))
  const lines = visible.map((seg, i) => {
    const vr = scroll + i
    if (vr !== cursor.vr) return <Text key={`r${vr}`} wrap="truncate-end">{paint(seg.text)}</Text>
    const cs = [...seg.text]
    const before = cs.slice(0, cursor.vc).join('')
    const at = cs[cursor.vc] ?? ' '
    const after = cs.slice(cursor.vc + 1).join('')
    return (
      <Text key={`r${vr}`} wrap="truncate-end">
        {paint(before)}
        <Text backgroundColor="white" color="black">{at}</Text>
        {paint(after)}
      </Text>
    )
  })
  const total = toText(buf).length
  const status = `${buf.lines.length} lines · ${total} chars · line ${buf.row + 1}, col ${buf.col + 1}${rows.length > hgt ? ` · rows ${scroll + 1}-${Math.min(rows.length, scroll + hgt)} of ${rows.length}` : ''}`
  return (
    <Box flexDirection="column">
      {lines}
      <Text dimColor wrap="truncate-end">{status}</Text>
    </Box>
  )
}
