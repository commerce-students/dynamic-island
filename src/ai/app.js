'use strict'

/* ============================================================
   AI chat window.
   The reply is fetched by the main process; this file only
   renders the thread and keeps the conversation in memory.
   ============================================================ */

const els = {
  thread: document.getElementById('thread'),
  empty: document.getElementById('empty'),
  scroll: document.getElementById('scroll'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  title: document.getElementById('title'),
  hint: document.getElementById('hint'),
  clear: document.getElementById('clear'),
  close: document.getElementById('close')
}

let messages = []
let busy = false
let info = { provider: 'groq', model: '', enabled: false, hasKey: false, label: 'Assistant' }

const LABELS = {
  groq: 'Groq',
  gemini: 'Gemini',
  openai: 'OpenAI',
  ollama: 'Ollama'
}

function scrollDown() {
  els.scroll.scrollTop = els.scroll.scrollHeight
}

function bubble(message) {
  const node = document.createElement('div')
  if (message.role === 'user') {
    node.className = 'msg user'
    node.textContent = message.content
  } else {
    node.className = 'msg bot'
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = LABELS[info.provider] || 'Assistant'
    node.append(who, document.createTextNode(message.content))
  }
  return node
}

function errorBubble(text) {
  const node = document.createElement('div')
  node.className = 'msg error'
  node.textContent = text
  return node
}

const EMPTY_HTML = els.empty.innerHTML

function blockedReason() {
  if (!info.enabled) return 'The assistant is switched off. Turn it on in Settings → AI.'
  if (!info.hasKey && info.provider !== 'ollama') {
    return 'No API key yet. Settings → AI explains how to get a free one from ' +
      (LABELS[info.provider] || 'your provider') + ', or switch to Ollama to run locally.'
  }
  return ''
}

function wireChips() {
  document.querySelectorAll('.chips [data-fill]').forEach((chip) => {
    chip.addEventListener('click', () => {
      els.input.value = chip.dataset.fill
      els.input.focus()
      els.input.setSelectionRange(els.input.value.length, els.input.value.length)
      els.send.disabled = false
    })
  })
  const go = document.getElementById('go-settings')
  if (go) go.addEventListener('click', () => window.ai.openSettings())
}

function render() {
  els.thread.replaceChildren()

  const reason = blockedReason()
  const showEmpty = messages.length === 0
  els.empty.hidden = !showEmpty

  if (showEmpty) {
    if (reason) {
      els.empty.innerHTML = '<p class="lead">' + reason + '</p>' +
        '<div class="chips"><button id="go-settings">Open AI settings</button></div>'
    } else if (!document.querySelector('.chips [data-fill]')) {
      els.empty.innerHTML = EMPTY_HTML
    }
    wireChips()
  }

  for (const message of messages) els.thread.append(bubble(message))
  scrollDown()
}

function setBusy(next) {
  busy = next
  els.send.disabled = next || !els.input.value.trim()
  els.input.disabled = next
  if (!next) els.input.focus()
}

function persistable() {
  return messages.slice(-12)
}

async function submit() {
  const text = els.input.value.trim()
  if (!text || busy) return

  messages.push({ role: 'user', content: text })
  els.input.value = ''
  els.input.style.height = 'auto'
  els.empty.hidden = true
  render()
  setBusy(true)

  const thinking = document.createElement('div')
  thinking.className = 'msg bot'
  thinking.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>'
  els.thread.append(thinking)
  scrollDown()

  const reply = await window.ai.send(persistable())
  thinking.remove()

  if (reply && reply.ok) {
    messages.push({ role: 'assistant', content: reply.text })
    els.thread.append(bubble(messages[messages.length - 1]))
  } else {
    els.thread.append(errorBubble((reply && reply.error) || 'Something went wrong.'))
  }

  scrollDown()
  setBusy(false)
}

els.input.addEventListener('input', () => {
  els.send.disabled = busy || !els.input.value.trim()
  els.input.style.height = 'auto'
  els.input.style.height = Math.min(96, els.input.scrollHeight) + 'px'
})

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
})

els.send.addEventListener('click', submit)

els.clear.addEventListener('click', () => {
  messages = []
  render()
  els.input.focus()
})

els.close.addEventListener('click', () => window.ai.close())

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.ai.close()
})

wireChips()

window.ai.info().then((data) => {
  if (!data) return
  info = data
  els.title.textContent = 'Assistant'
  els.hint.textContent = data.enabled
    ? `${LABELS[data.provider] || data.provider} · ${data.model}`
    : ''
  render()
  els.input.focus()
})
