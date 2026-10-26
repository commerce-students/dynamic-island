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
  pollinations: {
    label: 'Pollinations',
    url: 'https://text.pollinations.ai/openai',
    model: 'openai',
    needsKey: false,
    free: true
  },
  gemini: {
    label: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    model: 'gemini-3.5-flash',
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

/**
 * Pollinations, GET path.
 *
 * The POST composer endpoint queues anonymous calls and sometimes just holds
 * the connection, which feels broken. The plain GET endpoint answers in under
 * a second, so it is tried first and the POST shape is only the fallback.
 */
async function pollinationsGet(model, history) {
  const tail = history.slice(-6)
  const prompt = tail
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n\n')
    .slice(-3500)

  const url = 'https://text.pollinations.ai/' + encodeURIComponent(prompt + '\n\nAssistant:') +
    `?model=${encodeURIComponent(model)}&system=${encodeURIComponent(SYSTEM)}&private=true`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 40000)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Dynamic-Island' },
      signal: controller.signal
    })
    if (!response.ok) return { ok: false, error: `${response.status}` }
    const text = (await response.text()).trim()
    if (!text) return { ok: false, error: 'empty answer' }
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'timed out' : String(err && err.message) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Last resort: the user's own Ollama, if it is running and has a model.
 * No key, no internet, no rate limit — just slower and less clever.
 */
async function ollamaLocal(history, maxTokens) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  let models = []
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal })
    if (!response.ok) return { ok: false }
    const data = await response.json()
    models = (data.models || []).map((m) => m.name).filter(Boolean)
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }

  if (!models.length) return { ok: false }

  const model = models.find((name) => /llama3\.2/i.test(name)) || models[0]
  const result = await postJson(
    'http://127.0.0.1:11434/v1/chat/completions',
    {
      model,
      messages: [{ role: 'system', content: SYSTEM }, ...history],
      max_tokens: maxTokens,
      temperature: 0.7
    },
    {},
    90000
  )
  if (!result.ok) return { ok: false }
  const choice = result.data && result.data.choices && result.data.choices[0]
  const text = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content.trim()
    : ''
  return text ? { ok: true, text, local: true } : { ok: false }
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
    const endpoint = `${spec.url}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`
    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: history.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    }

    let result = await postJson(endpoint, payload, {}, 60000)

    // Google returns 503 "high demand" often enough that one retry is worth it.
    if (!result.ok && /^(429|5\d\d)/.test(result.error)) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      result = await postJson(endpoint, payload, {}, 60000)
    }

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
  const body = {
    model,
    messages: [{ role: 'system', content: SYSTEM }, ...history],
    max_tokens: maxTokens,
    temperature: 0.7
  }
  const timeout = provider === 'pollinations' ? 45000 : 60000

  if (provider === 'pollinations') {
    const viaGet = await pollinationsGet(model, history)
    if (viaGet.ok) return viaGet
  }

  let result = await postJson(spec.url, body, headers, timeout)

  // The free tier is a shared public service: a 429 or a cold start is normal.
  // One quiet retry turns most of those into a working answer.
  if (!result.ok && provider === 'pollinations' && /^(429|5\d\d)/.test(result.error)) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    result = await postJson(spec.url, body, headers, timeout)
  }

  if (!result.ok) {
    if (provider === 'pollinations') {
      const local = await ollamaLocal(history, maxTokens)
      if (local.ok) return local
      return {
        ok: false,
        error: 'The free service is busy right now and no local model answered. Wait a few seconds, or paste a Groq key in Settings → AI for a faster, steadier answer.'
      }
    }
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
