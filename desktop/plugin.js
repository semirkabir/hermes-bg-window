/**
 * bg-window — /btw and /bg answers in a docked side chat window instead of the transcript.
 *
 * How it works:
 *  1. composer.middleware catches "/btw <question>", "/bg <prompt>" and
 *     "/background <prompt>" before the app's slash handler, calls prompt.btw /
 *     prompt.background itself, and cancels the normal submit, so the
 *     "task started" line never lands in chat.
 *  2. ctx.onEvent('btw.complete' / 'background.complete') picks up the answer
 *     for task ids WE started and shows it in the window.
 *  3. On apps that ship ctx.claimSideTask (NousResearch/hermes-agent#125968)
 *     the plugin claims each task id, so the core never appends its
 *     "[bg <id>]" transcript line. On older apps, a MutationObserver hides
 *     exactly those messages for our task ids instead. That fallback is
 *     display-only: the gateway never writes them to the stored session.
 *
 * The window is plain DOM on document.body (no react-dom import allowed), pinned
 * bottom-right above the composer, right edge aligned with the composer.
 *
 * Uncompiled ESM. Allowed imports: '@hermes/plugin-sdk', 'react', 'react/jsx-runtime'.
 */
import { host } from '@hermes/plugin-sdk'

const ID = 'bg-window'
const MIDDLEWARE_AREA = 'composer.middleware'
const BG_RE = /^\/(?:bg|background)(?:\s+([\s\S]*))?$/i
const BTW_RE = /^\/btw(?:\s+([\s\S]*))?$/i
const MAX_TASKS = 30

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** "/bg foo" → "foo"; "/bg" → ""; anything else → null. */
export function parseBg(text) {
  const m = String(text ?? '').trim().match(BG_RE)
  if (!m) return null
  return (m[1] ?? '').trim()
}

/** "/bg x" → {kind:'bg',prompt:'x'}; "/btw x" → {kind:'btw',prompt:'x'}; else null. */
export function parseSide(text) {
  const t = String(text ?? '').trim()
  let m = t.match(BTW_RE)
  if (m) return { kind: 'btw', prompt: (m[1] ?? '').trim() }
  m = t.match(BG_RE)
  if (m) return { kind: 'bg', prompt: (m[1] ?? '').trim() }
  return null
}

/** Task id from a core transcript header: "[bg 1a2b3c]" or "[btw \"q\" (btw_1a2b3c)]". */
export function transcriptTaskId(txt) {
  const s = String(txt ?? '')
  let m = s.match(/\[bg ((?:bg_)?[0-9a-f]{6})\]/)
  if (m) return m[1].startsWith('bg_') ? m[1] : 'bg_' + m[1]
  m = s.match(/\[btw\b[^\n]*?\((btw_[0-9a-f]{6})\)\]/)
  return m ? m[1] : null
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
}

/**
 * Tiny markdown → HTML: fences, headings, bullets, numbered, paragraphs.
 * XSS-safe by construction: every model/user string goes through esc() before any
 * tag is added, and links are limited to http(s) hrefs (quotes escaped). All other
 * innerHTML in this file is static markup or esc()'d values.
 */
export function md(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let list = null
  let para = []
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = [] } }
  const flushList = () => { if (list) { out.push(`<${list.tag}>` + list.items.map(i => '<li>' + inline(i) + '</li>').join('') + `</${list.tag}>`); list = null } }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^```/.test(l)) {
      flushPara(); flushList()
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>')
      continue
    }
    let m
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push('<p class="h"><strong>' + inline(m[2]) + '</strong></p>'); continue }
    if ((m = l.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] } } list.items.push(m[1]); continue }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] } } list.items.push(m[1]); continue }
    if (!l.trim()) { flushPara(); flushList(); continue }
    flushList(); para.push(l)
  }
  flushPara(); flushList()
  return out.join('')
}

/** Follow-up prompt: bg agents are fresh sessions, so carry the last exchange. */
export function followUpPrompt(prev, text) {
  if (!prev || !prev.result) return text
  const clip = s => (s.length > 6000 ? s.slice(0, 6000) + '\n…[truncated]' : s)
  return `Context — an earlier background task:\nTask: ${prev.prompt}\nResult:\n${clip(prev.result)}\n\nFollow-up: ${text}`
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ctxRef = null
let tasks = [] // { id, kind: 'bg'|'btw', prompt, shown, status: 'running'|'done'|'error', result, startedAt, doneAt }
const ours = new Set()
const claimed = new Set() // task ids the app itself keeps out of the transcript
let open = false
let collapsed = false
let root = null
let els = null
let observer = null
let tickTimer = null

function save() {
  try { ctxRef?.storage?.set('tasks', tasks.slice(-MAX_TASKS)) } catch { /* ignore */ }
}

function runtimeSessionId() {
  try { return host.state?.activeSessionId?.get?.() || null } catch { return null }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

async function startTask(prompt, shown, kind = 'bg') {
  const sid = runtimeSessionId()
  const local = { id: 'pending_' + Date.now(), kind, prompt, shown: shown ?? prompt, status: 'running', result: '', startedAt: Date.now(), doneAt: 0 }
  tasks.push(local)
  openWindow()
  render()
  if (!sid) {
    local.status = 'error'; local.result = 'No active chat session — open a chat first.'; local.doneAt = Date.now()
    render(); save(); return
  }
  try {
    const r = await host.request(kind === 'btw' ? 'prompt.btw' : 'prompt.background', { session_id: sid, text: prompt })
    local.id = r?.task_id || local.id
    ours.add(local.id)
    // Apps with the side-task claim hook skip the transcript line for this id;
    // older apps fall back to hideTranscriptCopies() below.
    if (r?.task_id && typeof ctxRef?.claimSideTask === 'function') {
      try { ctxRef.claimSideTask(r.task_id); claimed.add(r.task_id) } catch { /* fall back to hiding */ }
    }
  } catch (e) {
    local.status = 'error'; local.result = 'Could not start: ' + (e?.message || String(e)); local.doneAt = Date.now()
  }
  render(); save()
}

function onComplete(ev) {
  const p = ev?.payload ?? ev ?? {}
  const id = String(p.task_id ?? '').trim()
  if (!id || !ours.has(id)) return
  const t = tasks.find(x => x.id === id)
  if (!t) return
  const text = String(p.text ?? '')
  t.status = /^error: /.test(text) ? 'error' : 'done'
  t.result = t.status === 'error' ? text.replace(/^error: /, '') : text
  t.doneAt = Date.now()
  openWindow()
  render(); save()
  hideTranscriptCopies()
}

// ---------------------------------------------------------------------------
// Hide the core's "[bg <id>]" / "[btw … (<id>)]" transcript copies for our tasks (display only)
// ---------------------------------------------------------------------------

function hideTranscriptCopies() {
  if (!ours.size || ours.size === claimed.size) return
  const nodes = document.querySelectorAll('[data-slot="aui_system-message-root"]')
  for (const n of nodes) {
    if (n.dataset.bgwHidden) continue
    const id = transcriptTaskId(n.textContent || '')
    if (!id || !ours.has(id) || claimed.has(id)) continue
    const wrap = n.closest('[data-message-id]') || n
    wrap.style.display = 'none'
    n.dataset.bgwHidden = '1'
  }
}

// ---------------------------------------------------------------------------
// Window (vanilla DOM)
// ---------------------------------------------------------------------------

const CSS = `
#bgw-root{position:fixed;z-index:60;display:none;flex-direction:column;width:min(340px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 180px));
  background:var(--ui-bg-elevated,var(--dt-card,#1e1e1e));color:var(--ui-text-primary,inherit);
  border:1px solid var(--ui-stroke-tertiary,rgba(255,255,255,.12));border-radius:14px;
  box-shadow:0 8px 28px rgba(0,0,0,.3);font-size:13px;line-height:1.45;overflow:hidden;transition:max-height .18s ease}
#bgw-root.open{display:flex}
#bgw-root .bgw-head{display:flex;align-items:center;gap:8px;padding:6px 6px 4px 12px;flex:none;user-select:none;cursor:pointer;min-height:30px;box-sizing:border-box}
#bgw-root .bgw-title{color:var(--ui-text-secondary,#aaa);font-size:12px;flex:none}
#bgw-root .bgw-sum{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--ui-text-tertiary,#888);font-size:12px;display:none;align-items:center;gap:6px}
#bgw-root.collapsed .bgw-sum{display:flex}
#bgw-root:not(.collapsed) .bgw-sp{flex:1}
#bgw-root.collapsed .bgw-body,#bgw-root.collapsed .bgw-foot,#bgw-root.collapsed .bgw-title b{display:none}
#bgw-root.collapsed .bgw-head{padding-bottom:6px}
#bgw-root .bgw-chev{transition:transform .15s ease}#bgw-root.collapsed .bgw-chev{transform:rotate(180deg)}
#bgw-root .bgw-title b{font-weight:500;color:var(--ui-text-tertiary,#888);margin-left:6px}
#bgw-root .bgw-btns{display:flex;gap:2px}
#bgw-root .bgw-btn{all:unset;cursor:pointer;display:grid;place-items:center;width:22px;height:22px;border-radius:6px;color:var(--ui-text-tertiary,#999)}
#bgw-root .bgw-btn:hover{background:var(--chrome-action-hover,rgba(255,255,255,.08));color:var(--ui-text-primary,#fff)}
#bgw-root .bgw-body{flex:0 1 auto;min-height:0;overflow-y:auto;padding:2px 12px 8px;display:flex;flex-direction:column;gap:8px}
#bgw-root .bgw-empty{margin:8px auto;color:var(--ui-text-tertiary,#888);font-size:.9em;text-align:center}
#bgw-root .bgw-q{align-self:flex-end;max-width:85%;background:var(--ui-bg-quaternary,rgba(255,255,255,.08));border-radius:10px;padding:4px 9px;white-space:pre-wrap;word-break:break-word}
#bgw-root .bgw-tag{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--ui-text-tertiary,#888);margin-right:6px}
#bgw-root .bgw-a{line-height:1.5;word-break:break-word}
#bgw-root .bgw-a p{margin:0 0 .5em}#bgw-root .bgw-a p:last-child{margin-bottom:0}
#bgw-root .bgw-a ul,#bgw-root .bgw-a ol{margin:0 0 .5em;padding-left:1.3em}
#bgw-root .bgw-a code{font-family:ui-monospace,Menlo,monospace;font-size:.88em;padding:1px 5px;border-radius:5px;background:var(--ui-bg-quaternary,rgba(255,255,255,.07));color:var(--ui-orange,#e0806a)}
#bgw-root .bgw-a pre{margin:0 0 .5em;padding:8px 10px;border-radius:8px;background:var(--ui-terminal-surface-background,rgba(0,0,0,.25));overflow-x:auto}
#bgw-root .bgw-a pre code{background:none;padding:0;color:inherit}
#bgw-root .bgw-a a{color:var(--ui-accent,#6aa0ff)}
#bgw-root .bgw-a.err{color:var(--ui-red,#f87171)}
#bgw-root .bgw-meta{display:flex;align-items:center;gap:6px;color:var(--ui-text-tertiary,#888);font-size:11px;margin-top:2px}
#bgw-root .bgw-meta button{all:unset;cursor:pointer;opacity:.8}#bgw-root .bgw-meta button:hover{opacity:1;text-decoration:underline}
#bgw-root .bgw-run{color:var(--ui-text-tertiary,#888);font-size:.9em;display:flex;align-items:center;gap:8px}
#bgw-root .bgw-dot{width:7px;height:7px;border-radius:50%;background:var(--ui-accent,#e0806a);animation:bgwp 1.2s ease-in-out infinite}
@keyframes bgwp{0%,100%{opacity:.25}50%{opacity:1}}
#bgw-root .bgw-foot{flex:none;padding:4px 8px 8px}
#bgw-root .bgw-in{display:flex;align-items:flex-end;gap:4px;border:1px solid var(--ui-stroke-tertiary,rgba(255,255,255,.14));border-radius:10px;padding:4px 4px 4px 10px}
#bgw-root .bgw-in:focus-within{border-color:var(--dt-composer-ring,var(--ui-accent,#888))}
#bgw-root textarea{all:unset;flex:1;min-height:20px;max-height:96px;overflow-y:auto;white-space:pre-wrap;line-height:20px;font-size:13px;color:inherit}
#bgw-root textarea::placeholder{color:var(--ui-text-tertiary,#888)}
#bgw-root .bgw-send{all:unset;cursor:pointer;width:22px;height:22px;display:grid;place-items:center;border-radius:7px;color:var(--ui-text-secondary,#aaa)}
#bgw-root .bgw-send:hover{background:var(--chrome-action-hover,rgba(255,255,255,.08))}
#bgw-chip{position:fixed;z-index:59;display:none;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;cursor:pointer;
  background:var(--ui-bg-elevated,#222);border:1px solid var(--ui-stroke-tertiary,rgba(255,255,255,.12));color:var(--ui-text-secondary,#aaa);font-size:12px}
#bgw-chip.show{display:flex}#bgw-chip:hover{color:var(--ui-text-primary,#fff)}
`

const ICON_TRASH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>'
const ICON_X = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
const ICON_CHEV = '<svg class="bgw-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'
const ICON_ENTER = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 5v7a3 3 0 0 1-3 3H5"/><path d="M9 11l-4 4 4 4"/></svg>'

function mount() {
  if (root) return
  const style = document.createElement('style')
  style.id = 'bgw-style'
  style.textContent = CSS
  document.head.appendChild(style)

  root = document.createElement('div')
  root.id = 'bgw-root'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Side chat')
  root.innerHTML = `
    <div class="bgw-head" title="Collapse / expand"><div class="bgw-title">Side chat<b></b></div><div class="bgw-sum"></div><div class="bgw-sp"></div>
      <div class="bgw-btns"><button class="bgw-btn" data-a="toggle" title="Collapse">${ICON_CHEV}</button><button class="bgw-btn" data-a="clear" title="Clear finished">${ICON_TRASH}</button><button class="bgw-btn" data-a="close" title="Close">${ICON_X}</button></div></div>
    <div class="bgw-body"></div>
    <div class="bgw-foot"><div class="bgw-in"><textarea rows="1" placeholder="Follow up…"></textarea><button class="bgw-send" title="Ask on the side">${ICON_ENTER}</button></div></div>`
  document.body.appendChild(root)

  const chip = document.createElement('div')
  chip.id = 'bgw-chip'
  document.body.appendChild(chip)

  els = {
    style, chip,
    count: root.querySelector('.bgw-title b'),
    sum: root.querySelector('.bgw-sum'),
    toggle: root.querySelector('[data-a="toggle"]'),
    body: root.querySelector('.bgw-body'),
    input: root.querySelector('textarea'),
    send: root.querySelector('.bgw-send'),
  }

  root.querySelector('[data-a="close"]').onclick = e => { e.stopPropagation(); closeWindow() }
  els.toggle.onclick = e => { e.stopPropagation(); setCollapsed(!collapsed) }
  root.querySelector('.bgw-head').onclick = e => { if (!e.target.closest('button')) setCollapsed(!collapsed) }
  root.querySelector('[data-a="clear"]').onclick = e => {
    e.stopPropagation()
    tasks = tasks.filter(t => t.status === 'running'); render(); save()
  }
  chip.onclick = () => openWindow()
  const submit = () => {
    const text = els.input.value.trim()
    if (!text) return
    els.input.value = ''
    autosize()
    const prev = [...tasks].reverse().find(t => t.status === 'done')
    startTask(followUpPrompt(prev, text), text, prev?.kind || 'btw')
  }
  els.send.onclick = submit
  els.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
    if (e.key === 'Escape') { e.preventDefault(); closeWindow() }
  })
  const autosize = () => { els.input.style.height = 'auto'; els.input.style.height = Math.min(120, els.input.scrollHeight) + 'px' }
  els.input.addEventListener('input', autosize)
  els.body.addEventListener('click', e => {
    const b = e.target.closest('button[data-copy]')
    if (b) {
      const t = tasks.find(x => x.id === b.dataset.copy)
      if (t) navigator.clipboard?.writeText(t.result).then(() => { b.textContent = 'copied'; setTimeout(() => { b.textContent = 'copy' }, 1200) }).catch(() => {})
    }
    const r = e.target.closest('button[data-rm]')
    if (r) { tasks = tasks.filter(x => x.id !== r.dataset.rm); render(); save() }
  })

  window.addEventListener('resize', place)
  tickTimer = setInterval(() => { place(); if (open && tasks.some(t => t.status === 'running')) renderTimers() }, 1000)
}

function unmount() {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  window.removeEventListener('resize', place)
  root?.remove(); els?.chip?.remove(); els?.style?.remove()
  root = null; els = null
}

/** Pin above the (focused) composer, right edges aligned. */
function place() {
  if (!root) return
  const composers = [...document.querySelectorAll('[data-slot="composer-root"]')].filter(c => c.offsetParent)
  const active = document.activeElement?.closest?.('[data-slot="composer-root"]')
  const c = active || composers[composers.length - 1]
  let right = 16, bottom = 96
  if (c) {
    // composer-root is wider than the visible bordered surface; composer-fade's
    // parent IS that surface, so align to it.
    const surf = c.querySelector('[data-slot="composer-fade"]')?.parentElement || c
    const r = surf.getBoundingClientRect()
    right = Math.max(8, window.innerWidth - r.right)
    bottom = Math.max(8, window.innerHeight - r.top + 12)
  }
  root.style.right = right + 'px'
  root.style.bottom = bottom + 'px'
  els.chip.style.right = right + 'px'
  els.chip.style.bottom = bottom + 'px'
  const running = tasks.filter(t => t.status === 'running').length
  const unseen = tasks.filter(t => t.status !== 'running' && !t.seen).length
  const showChip = !open && (running || unseen)
  els.chip.classList.toggle('show', !!showChip)
  if (showChip) {
    const label = running ? `${running} running` : `${unseen} done`
    const html = `${running ? '<span class="bgw-dot" style="width:6px;height:6px;border-radius:50%;background:var(--ui-accent,#e0806a);display:inline-block"></span>' : ''}side · ${label}`
    if (els.chip.innerHTML !== html) els.chip.innerHTML = html
  }
}

function setCollapsed(v) {
  collapsed = !!v
  try { ctxRef?.storage?.set('collapsed', collapsed) } catch { /* ignore */ }
  if (!root) return
  root.classList.toggle('collapsed', collapsed)
  els.toggle.title = collapsed ? 'Expand' : 'Collapse'
  renderSummary()
  if (!collapsed) els.body.scrollTop = els.body.scrollHeight
  place()
}

/** One-line status shown in the collapsed header. */
export function summaryText(list) {
  const running = list.filter(t => t.status === 'running')
  if (running.length) return { dot: true, text: running.length > 1 ? `${running.length} running` : running[0].shown }
  const last = list[list.length - 1]
  if (!last) return { dot: false, text: 'No tasks' }
  const firstLine = String(last.result || '').split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '(empty)'
  return { dot: false, text: (last.status === 'error' ? 'Error: ' : '') + firstLine }
}

function renderSummary() {
  if (!els) return
  const s = summaryText(tasks)
  els.sum.innerHTML = (s.dot ? '<span class="bgw-dot"></span>' : '') + '<span style="overflow:hidden;text-overflow:ellipsis">' + esc(s.text) + '</span>'
}

function openWindow() {
  mount()
  open = true
  root.classList.add('open')
  for (const t of tasks) if (t.status !== 'running') t.seen = true
  place()
}

function closeWindow() {
  open = false
  root?.classList.remove('open')
  place()
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function renderTimers() {
  for (const el of root.querySelectorAll('[data-run]')) {
    const t = tasks.find(x => x.id === el.dataset.run)
    if (t) el.textContent = `Working… ${ago(Date.now() - t.startedAt)}`
  }
  if (collapsed) renderSummary()
}

function render() {
  if (!root) return
  const list = tasks.slice(-MAX_TASKS)
  const running = list.filter(t => t.status === 'running').length
  els.count.textContent = running ? `${running} running` : ''
  renderSummary()
  if (!list.length) {
    els.body.innerHTML = '<div class="bgw-empty">Nothing here yet.<br>Type <code>/btw &lt;question&gt;</code> or <code>/bg &lt;prompt&gt;</code> in the composer.</div>'
    return
  }
  els.body.innerHTML = list.map(t => {
    const q = `<div class="bgw-q"><span class="bgw-tag">${t.kind === 'btw' ? 'btw' : 'bg'}</span>${esc(t.shown)}</div>`
    if (t.status === 'running') return q + `<div class="bgw-run"><span class="bgw-dot"></span><span data-run="${esc(t.id)}">Working… ${ago(Date.now() - t.startedAt)}</span></div>`
    const meta = `<div class="bgw-meta">${ago(t.doneAt - t.startedAt)} · <button data-copy="${esc(t.id)}">copy</button> · <button data-rm="${esc(t.id)}">remove</button></div>`
    return q + `<div><div class="bgw-a${t.status === 'error' ? ' err' : ''}">${md(t.result || '(empty result)')}</div>${meta}</div>`
  }).join('')
  if (open) for (const t of tasks) if (t.status !== 'running') t.seen = true
  els.body.scrollTop = els.body.scrollHeight
  place()
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function middleware(input) {
  const side = parseSide(input?.text)
  if (!side) return input
  if (input?.attachments?.length) return input // let core handle attachments
  if (!side.prompt) { openWindow(); render(); clearDraft(); return null }
  startTask(side.prompt, side.prompt, side.kind)
  clearDraft()
  return null // cancel the normal submit; core never sees /bg or /btw
}

function clearDraft() {
  try { host.composer?.setDraft?.(null, '') } catch { /* ignore */ }
}

export const __test = { parseBg, parseSide, transcriptTaskId, md, esc, followUpPrompt, summaryText }

export default {
  id: ID,
  name: 'Background Window',
  description: 'Runs /btw and /bg in a docked side chat window instead of dropping answers into the chat.',
  register(ctx) {
    ctxRef = ctx
    const saved = ctx.storage?.get('tasks', [])
    if (Array.isArray(saved)) {
      tasks = saved.map(t => ({ kind: 'bg', ...t })).map(t => (t.status === 'running' ? { ...t, status: 'error', result: 'Lost track of this task (app reloaded before it finished).', doneAt: t.doneAt || Date.now() } : t))
      for (const t of tasks) ours.add(t.id)
    }
    mount()
    setCollapsed(!!ctx.storage?.get('collapsed', false))
    render()

    ctx.register({ id: 'bg-intercept', area: MIDDLEWARE_AREA, order: 5, data: { handler: middleware } })
    ctx.onEvent('background.complete', onComplete)
    ctx.onEvent('btw.complete', onComplete)

    observer = new MutationObserver(() => hideTranscriptCopies())
    observer.observe(document.body, { childList: true, subtree: true })
    hideTranscriptCopies()

    ctx.onDispose(() => { observer?.disconnect(); observer = null; unmount() })
  },
}
