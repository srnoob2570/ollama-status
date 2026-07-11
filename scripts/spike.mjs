/* global process, performance, fetch, console */
/* Run only against staging with explicitly supplied disposable keys. It records no token or generated text. */
const base = process.env.OLLAMA_BASE_URL ?? 'https://ollama.com/api'
const key = process.env.OLLAMA_API_KEY
if (!key) throw new Error('OLLAMA_API_KEY is required')
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
const call = async (path, init = {}) => {
  const started = performance.now(); const response = await fetch(`${base}${path}`, { ...init, headers }); const text = await response.text()
  let body; try { body = JSON.parse(text) } catch { body = {} }
  console.log(JSON.stringify({ path, status: response.status, elapsedMs: Math.round(performance.now() - started), keys: Object.keys(body), errorLength: typeof body.error === 'string' ? body.error.length : 0 }))
  return { response, body }
}
const tags = await call('/tags')
const model = tags.body.models?.[0]?.name
if (!model) throw new Error('No model returned by /tags')
await call('/show', { method: 'POST', body: JSON.stringify({ model }) })
await call('/generate', { method: 'POST', body: JSON.stringify({ model, prompt: '', stream: false, think: false, options: { num_predict: 1, temperature: 0 } }) })
await call('/generate', { method: 'POST', body: JSON.stringify({ model, prompt: '', stream: false, raw: true, think: false, options: { num_predict: 1, temperature: 0 } }) })
await call('/generate', { method: 'POST', body: JSON.stringify({ model: 'does-not-exist', prompt: '', stream: false }) })
await call('/generate', { method: 'POST', body: '{' })
