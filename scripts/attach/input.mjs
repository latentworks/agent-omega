// scripts/attach/input.mjs
// Raw-mode key decoder + compose buffer + prompt history (plan §3.6, §5.4). Hand-rolled byte parser
// (not emitKeypressEvents) so bracketed paste never double-fires and keys behave identically across
// Termius/desktop. States: compose | menu. Emits high-level actions to the controller via handlers.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function createInput(h) {
  const HIST_FILE = process.env.AGENT_OMEGA_ATTACH_HISTORY || path.join(os.homedir(), '.agent-omega', 'attach_history.json')
  const stdin = process.stdin
  let mode = 'compose'          // 'compose' | 'menu'
  let buf = '', cursor = 0
  let menuCount = 0, menuIndex = 0
  let paste = null, pasteTimer = null
  let exitArmed = false, exitTimer = null
  let hist = load(), histIdx = hist.length, histDraft = ''

  function load() { try { const a = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); return Array.isArray(a) ? a.slice(-200) : [] } catch { return [] } }
  function save() { try { fs.mkdirSync(path.dirname(HIST_FILE), { recursive: true }); fs.writeFileSync(HIST_FILE, JSON.stringify(hist.slice(-100))) } catch {} }
  function pushHist(t) { if (t && hist[hist.length - 1] !== t) { hist.push(t) ; save() } histIdx = hist.length; histDraft = '' }

  const repaint = () => h.onRepaint && h.onRepaint()
  const insert = (s) => { buf = buf.slice(0, cursor) + s + buf.slice(cursor); cursor += s.length; disarmExit() }
  function disarmExit() { if (exitArmed) { exitArmed = false; clearTimeout(exitTimer); h.onExitDisarm && h.onExitDisarm() } }

  function submit() {
    const t = buf
    buf = ''; cursor = 0; histIdx = hist.length; histDraft = ''
    if (t.trim()) { if (!t.startsWith('/')) pushHist(t); h.onPrompt(t) } else repaint()
  }
  function handleEnter() {
    if (mode === 'menu') { h.onMenuPick && h.onMenuPick(menuIndex); return }
    if (buf.endsWith('\\')) { buf = buf.slice(0, -1); insert('\n'); repaint(); return }
    if (h.isBusy && h.isBusy() && !buf.startsWith('/')) { h.onBusyEnter && h.onBusyEnter(); return } // keep prompt while busy (D11); /commands still go through
    submit()
  }
  function handleCtrlC() {
    if (mode === 'menu') { h.onMenuCancel && h.onMenuCancel(); return }
    if (buf) { buf = ''; cursor = 0; repaint(); return }
    if (exitArmed) { clearTimeout(exitTimer); h.onExit && h.onExit(); return }
    exitArmed = true; h.onExitArm && h.onExitArm()
    exitTimer = setTimeout(() => { exitArmed = false; h.onExitDisarm && h.onExitDisarm() }, 2000)
  }
  function handleEsc() {
    if (mode === 'menu') { h.onMenuCancel && h.onMenuCancel(); return }
    if (h.isBusy && h.isBusy()) { h.onAbort && h.onAbort(); return }
    if (buf) { buf = ''; cursor = 0; repaint() }
  }
  function histPrev() { if (mode !== 'compose' || !hist.length) return; if (histIdx === hist.length) histDraft = buf; if (histIdx > 0) { histIdx--; buf = hist[histIdx]; cursor = buf.length; repaint() } }
  function histNext() { if (mode !== 'compose') return; if (histIdx < hist.length) { histIdx++; buf = histIdx === hist.length ? histDraft : hist[histIdx]; cursor = buf.length; repaint() } }

  function handleCSI(nums, final) {
    if (mode === 'menu') {
      if (final === 'A') { menuIndex = (menuIndex - 1 + menuCount) % menuCount; repaint() }
      else if (final === 'B') { menuIndex = (menuIndex + 1) % menuCount; repaint() }
      return
    }
    switch (final) {
      case 'A': histPrev(); break                                   // up
      case 'B': histNext(); break                                   // down
      case 'C': if (cursor < buf.length) { cursor++; repaint() } break // right
      case 'D': if (cursor > 0) { cursor--; repaint() } break        // left
      case 'H': cursor = 0; repaint(); break
      case 'F': cursor = buf.length; repaint(); break
      case '~':
        if (nums === '1' || nums === '7') { cursor = 0; repaint() }
        else if (nums === '4' || nums === '8') { cursor = buf.length; repaint() }
        else if (nums === '3') { if (cursor < buf.length) { buf = buf.slice(0, cursor) + buf.slice(cursor + 1); repaint() } } // delete
        break
    }
  }

  function feed(data) {
    let s = data
    // continuing a paste
    if (paste !== null) {
      const end = s.indexOf('\x1b[201~')
      if (end < 0) { paste += s; return }
      paste += s.slice(0, end); endPaste(); s = s.slice(end + 6)
    }
    let i = 0
    while (i < s.length) {
      if (s.startsWith('\x1b[200~', i)) { startPaste(); i += 6; continue }
      if (paste !== null) { const end = s.indexOf('\x1b[201~', i); if (end < 0) { paste += s.slice(i); return } paste += s.slice(i, end); endPaste(); i = end + 6; continue }
      const c = s[i]
      if (c === '\x1b' && s[i + 1] === '[') { const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(s.slice(i)); if (m) { handleCSI(m[1], m[2]); i += m[0].length; continue } }
      if (c === '\x1b') { handleEsc(); i++; continue }
      const code = c.charCodeAt(0)
      if (code === 13) { handleEnter(); i++; continue }
      if (code === 10) { if (mode === 'compose') { insert('\n'); repaint() } i++; continue }  // Ctrl+J
      if (code === 3) { handleCtrlC(); i++; continue }
      if (code === 127 || code === 8) { if (mode === 'compose' && cursor > 0) { buf = buf.slice(0, cursor - 1) + buf.slice(cursor); cursor--; repaint() } i++; continue }
      if (code === 21) { if (mode === 'compose') { buf = buf.slice(cursor); cursor = 0; repaint() } i++; continue }      // Ctrl+U
      if (code === 1) { if (mode === 'compose') { cursor = 0; repaint() } i++; continue }                                // Ctrl+A
      if (code === 5) { if (mode === 'compose') { cursor = buf.length; repaint() } i++; continue }                       // Ctrl+E
      if (code === 23) { if (mode === 'compose') { const l = buf.slice(0, cursor).replace(/\s*\S+\s*$/, ''); buf = l + buf.slice(cursor); cursor = l.length; repaint() } i++; continue } // Ctrl+W
      if (code === 12) { h.onRedraw && h.onRedraw(); i++; continue }                                                     // Ctrl+L
      if (code === 9) { if (mode === 'compose') { if (buf.startsWith('/')) { h.onSlash && h.onSlash(buf) } else insert('  ') ; repaint() } i++; continue } // Tab
      if (code < 32) { i++; continue }
      // printable — consume a full code point (surrogate pair aware)
      const cp = s.codePointAt(i); const ch = String.fromCodePoint(cp)
      if (mode === 'menu') { const d = cp - 48; if (d >= 1 && d <= menuCount) { menuIndex = d - 1; h.onMenuPick && h.onMenuPick(menuIndex) } }
      else { insert(ch); repaint() }
      i += ch.length
    }
  }
  function startPaste() { paste = ''; clearTimeout(pasteTimer); pasteTimer = setTimeout(() => { if (paste !== null) { const c = norm(paste); paste = null; if (mode === 'compose') { insert(c); repaint() } } }, 2000) }
  function endPaste() { clearTimeout(pasteTimer); const c = norm(paste); paste = null; if (mode === 'compose') { insert(c); repaint() } }
  const norm = (s) => s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')

  return {
    buffer: () => ({ buf, cursor }),
    menuIndex: () => menuIndex,
    _feed: feed,   // test hook: drive the decoder without a live TTY
    setMenu(count) { mode = 'menu'; menuCount = Math.max(1, count); menuIndex = 0 },
    setCompose() { mode = 'compose' },
    start() {
      if (stdin.isTTY) stdin.setRawMode(true)
      stdin.setEncoding('utf8')
      stdin.resume()
      try { process.stdout.write('\x1b[?2004h') } catch {}   // enable bracketed paste (an OUTPUT escape)
      stdin.on('data', feed)
    },
    stop() {
      try { process.stdout.write('\x1b[?2004l') } catch {}
      try { if (stdin.isTTY) stdin.setRawMode(false) } catch {}
      stdin.pause(); stdin.removeListener('data', feed)
    },
  }
}
