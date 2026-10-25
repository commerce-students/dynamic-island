'use strict'

/* ============================================================
   AI providers.

   Everything here runs in the main process so the API key never
   touches the renderer. Four providers cover the useful cases:
   two with a genuinely free tier, one paid, one fully local.
   ============================================================ */

const SYSTEM = [
  'You are the assistant built into Dynamic Island, a small always-on-top app on the user\'s own Windows PC.',
  'You cannot control the PC; you answer questions and help the user think.',
  'Be brief and concrete. This is a narrow chat window, so keep answers under roughly 120 words unless the user asks for detail.',
  'Plain prose only — no markdown tables, no headings.'
].join(' ')

const PROVIDERS = {
  groq: {
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    needsKey: true
  },
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    needsKey: true
  },
  ollama: {
    label: 'Ollama',
    url: 'http://127.0.0.1:11434/v1/chat/completions',
    model: 'llama3.2',
    needsKey: false
  },
  gemini: {
    label: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    model: 'gemini-2.0-flash',
    needsKey: true
  }
}

async function postJson(url, body, headers, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const raw = await response.text()
    let data = null
    try { data = JSON.parse(raw) } catch { data = null }

    if (!response.ok) {
      const detail = data && data.error
        ? (data.error.message || data.error.status || JSON.stringify(data.error))
        : raw.slice(0, 240)
      return { ok: false, error: `${response.status} — ${detail}` }
    }
    return { ok: true, data }
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, error: 'The request timed out.' }
    return { ok: false, error: err && err.message ? err.message : 'Network error.' }
  } finally {
    clearTimeout(timer)
  }
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-16)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 8000)
    }))
}

async function ask(config, messages) {
  const conf = config || {}
  const provider = PROVIDERS[conf.provider] ? conf.provider : 'groq'
  const spec = PROVIDERS[provider]
  const key = (conf.apiKey || '').trim()
  const model = (conf.model || '').trim() || spec.model
  const maxTokens = Math.max(64, Math.min(2000, Number(conf.maxTokens) || 700))

  if (spec.needsKey && !key) {
    return { ok: false, error: `No API key yet. Settings → AI has links to get a free ${spec.label} key.` }
  }

  const history = cleanMessages(messages)
  if (!history.length) return { ok: false, error: 'Nothing to send.' }

  if (provider === 'gemini') {
    const result = await postJson(
      `${spec.url}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: history.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
      },
      {},
      60000
    )
    if (!result.ok) return result
    const candidate = result.data && result.data.candidates && result.data.candidates[0]
    const text = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts.map((p) => p.text || '').join('').trim()
      : ''
    if (!text) {
      const reason = candidate && candidate.finishReason ? ` (${candidate.finishReason})` : ''
      return { ok: false, error: `Gemini returned no text${reason}.` }
    }
    return { ok: true, text }
  }

  const headers = spec.needsKey ? { Authorization: `Bearer ${key}` } : {}
  const result = await postJson(
    spec.url,
    {
      model,
      messages: [{ role: 'system', content: SYSTEM }, ...history],
      max_tokens: maxTokens,
      temperature: 0.7
    },
    headers,
    60000
  )
  if (!result.ok) {
    if (provider === 'ollama' && /not found|does not support/i.test(result.error)) {
      return { ok: false, error: `${result.error}\n\nPull the model first:  ollama pull ${model}` }
    }
    return result
  }
  const choice = result.data && result.data.choices && result.data.choices[0]
  const text = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content.trim()
    : ''
  if (!text) return { ok: false, error: `${spec.label} returned an empty answer.` }
  return { ok: true, text }
}

async function test(config) {
  const provider = (config && config.provider) || 'groq'
  const result = await ask(config, [{ role: 'user', content: 'Reply with exactly: OK' }])
  if (!result.ok) return result
  return { ok: true, text: result.text.slice(0, 120), provider }
}

module.exports = { ask, test, PROVIDERS, SYSTEM }
