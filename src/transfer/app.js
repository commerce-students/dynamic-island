'use strict'

/* ============================================================
   Accept or decline a LocalSend transfer.
   The HTTP answer is held open by the main process until this
   window replies, so closing the window is a decline.
   ============================================================ */

const els = {
  files: document.getElementById('files'),
  sender: document.getElementById('sender'),
  count: document.getElementById('count'),
  size: document.getElementById('size'),
  accept: document.getElementById('accept'),
  decline: document.getElementById('decline'),
  close: document.getElementById('close')
}

let current = null
let answered = false

function humanSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function render(request) {
  current = request
  answered = false

  const sender = request.sender || {}
  const where = [sender.alias || 'A nearby device', sender.deviceModel].filter(Boolean).join(' · ')
  els.sender.textContent = `From ${where}`

  els.files.replaceChildren()
  for (const file of request.files || []) {
    const row = document.createElement('div')
    row.className = 'file'

    const dot = document.createElement('span')
    dot.className = 'dot'

    const name = document.createElement('span')
    name.className = 'who'
    name.textContent = file.name

    const size = document.createElement('span')
    size.className = 'how'
    size.textContent = humanSize(file.size)

    row.append(dot, name, size)
    els.files.append(row)
  }

  const count = (request.files || []).length
  els.count.textContent = count === 1 ? '1 file' : `${count} files`
  els.size.textContent = humanSize(request.total)

  els.accept.disabled = count === 0
  els.accept.textContent = count === 1 ? 'Accept file' : `Accept ${count} files`
}

function answer(accept) {
  if (!current || answered) return
  answered = true
  const ids = (current.files || []).map((file) => file.id)
  window.islandTransfer.answer(accept, accept ? ids : [])
}

els.accept.addEventListener('click', () => answer(true))
els.decline.addEventListener('click', () => answer(false))
els.close.addEventListener('click', () => answer(false))

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') answer(false)
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    answer(true)
  }
})

window.islandTransfer.onRequest((request) => {
  if (request) render(request)
})
