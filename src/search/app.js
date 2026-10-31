'use strict'

/* ============================================================
   Spotlight window.
   The scan happens in the main process; this file only types,
   ranks nothing, and draws whatever comes back.
   ============================================================ */

const els = {
  q: document.getElementById('q'),
  results: document.getElementById('results'),
  empty: document.getElementById('empty'),
  ask: document.getElementById('ask'),
  timing: document.getElementById('timing'),
  close: document.getElementById('close')
}

let items = []
let active = 0
let ticket = 0
let queryIdle = null

function kindLabel(item) {
  return item.kind === 'app' ? 'App' : 'File'
}

function initial(item) {
  const name = String(item.name || '?').trim()
  return (name[0] || '?').toUpperCase()
}

/** The matched run in green, without ever injecting HTML. */
function nameNode(item, query) {
  const node = document.createElement('div')
  node.className = 'name'
  const text = String(item.name || '')
  const q = String(query || '').trim().toLowerCase()
  const at = q ? text.toLowerCase().indexOf(q) : -1

  if (at < 0 || !q) {
    node.textContent = text
    return node
  }

  node.append(document.createTextNode(text.slice(0, at)))
  const mark = document.createElement('mark')
  mark.textContent = text.slice(at, at + q.length)
  node.append(mark, document.createTextNode(text.slice(at + q.length)))
  return node
}

function render(query) {
  els.results.textContent = ''
  els.empty.hidden = items.length > 0
  els.results.hidden = items.length === 0
  els.ask.hidden = !(items.length === 0 && query.trim().length > 2)

  if (!items.length) return

  items.forEach((item, index) => {
    const row = document.createElement('div')
    row.className = 'row' + (index === active ? ' active' : '')
    row.dataset.index = String(index)
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', index === active ? 'true' : 'false')

    const icon = document.createElement('div')
    icon.className = `icon ${item.kind === 'app' ? 'app' : 'file'}`
    icon.textContent = initial(item)

    const text = document.createElement('div')
    text.className = 'text'
    text.append(nameNode(item, query))

    const detail = document.createElement('div')
    detail.className = 'detail'
    detail.textContent = item.detail || ''
    text.append(detail)

    const kind = document.createElement('div')
    kind.className = 'kind'
    kind.textContent = kindLabel(item)

    row.append(icon, text, kind)
    row.addEventListener('mousemove', () => setActive(index, false))
    row.addEventListener('click', (event) => open(index, event.ctrlKey))
    els.results.append(row)
  })
}

function scrollIntoView() {
  const row = els.results.querySelector('.row.active')
  if (row) row.scrollIntoView({ block: 'nearest' })
}

function setActive(index, scroll = true) {
  if (!items.length) return
  active = Math.max(0, Math.min(items.length - 1, index))
  for (const row of els.results.querySelectorAll('.row')) {
    const isActive = Number(row.dataset.index) === active
    row.classList.toggle('active', isActive)
    row.setAttribute('aria-selected', isActive ? 'true' : 'false')
  }
  if (scroll) scrollIntoView()
}

async function open(index, reveal) {
  const item = items[index]
  if (!item) return
  if (reveal) await window.islandSearch.reveal(item.id)
  else await window.islandSearch.open(item.id)
  if (!reveal) window.islandSearch.close()
}

async function runQuery() {
  const text = els.q.value
  const mine = ++ticket
  const started = performance.now()

  const response = await window.islandSearch.query(text).catch(() => null)
  if (mine !== ticket) return // a newer keystroke already won

  items = (response && response.items) || []
  active = 0
  render(text)

  const ms = Math.round(performance.now() - started)
  els.timing.textContent = items.length ? `${items.length} · ${ms} ms` : ''
}

function schedule() {
  clearTimeout(queryIdle)
  queryIdle = setTimeout(runQuery, 55)
}

els.q.addEventListener('input', schedule)

els.q.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    setActive(active + 1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    setActive(active - 1)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (items.length) open(active, event.ctrlKey)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    window.islandSearch.close()
  }
})

els.close.addEventListener('click', () => window.islandSearch.close())

els.ask.addEventListener('click', () => {
  window.islandSearch.ask(els.q.value.trim())
  window.islandSearch.close()
})

// The main process tells us when the window is shown again, so every visit
// starts from a clean field instead of the last search.
window.islandSearch.onShow(() => {
  els.q.value = ''
  items = []
  active = 0
  els.timing.textContent = ''
  render('')
  els.q.focus()
})

render('')
els.q.focus()
