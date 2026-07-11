import { classifyHttp, isLatencyAnomalous, publicStatusFor } from './status'
import type { ProbeResult, Provider } from './types'

const timeoutMs = 45_000
const probeMessage = 'Reply with OK.'

type ChatChunk = { done?: boolean; error?: string; message?: { content?: string; thinking?: string }; total_duration?: number; load_duration?: number }

export class OllamaProvider {
  constructor(private readonly provider: Provider, private readonly apiKey: string, private readonly maxResponseTokens = 8) {}

  private headers() { return { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' } }
  private url(path: string) { return `${this.provider.base_url.replace(/\/$/, '')}${path}` }

  async tags(): Promise<{ models: Array<{ name: string; digest?: string }> }> {
    const response = await fetch(this.url('/tags'), { headers: this.headers() })
    if (!response.ok) throw new OllamaHttpError(response.status)
    const body = await response.json() as { models?: Array<{ name: string; digest?: string }> }
    if (!Array.isArray(body.models)) throw new Error('catalog_protocol')
    return { models: body.models }
  }

  async show(model: string): Promise<unknown> {
    const response = await fetch(this.url('/show'), { method: 'POST', headers: this.headers(), body: JSON.stringify({ model }) })
    if (!response.ok) throw new OllamaHttpError(response.status)
    return response.json()
  }

  async probe(model: string, baseline?: number): Promise<ProbeResult> {
    const started = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(this.url('/chat'), {
        method: 'POST', headers: this.headers(), signal: controller.signal,
        // Chat validates the account's model entitlement; an empty /generate request only preloads a model.
        body: JSON.stringify({ model, messages: [{ role: 'user', content: probeMessage }], stream: true, think: false, options: { num_predict: this.maxResponseTokens, temperature: 0 } }),
      })
      if (!response.ok) {
        // Inspect the response only in memory; errors and generated text are never persisted.
        const error = await response.text()
        const classification = response.status === 403 && /requires a subscription|upgrade for access/i.test(error)
          ? 'SUBSCRIPTION_REQUIRED' : classifyHttp(response.status)
        return { classification, publicStatus: publicStatusFor(classification), httpStatus: response.status, rttMs: performance.now() - started, errorCode: `http_${response.status}` }
      }
      return await firstChatToken(response, started, baseline)
    } catch (error) {
      const classification = error instanceof DOMException && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR'
      return { classification, publicStatus: publicStatusFor(classification), rttMs: performance.now() - started, errorCode: classification.toLowerCase() }
    } finally { clearTimeout(timer) }
  }
}

async function firstChatToken(response: Response, started: number, baseline?: number): Promise<ProbeResult> {
  if (!response.body) return protocolError(started, 'missing_stream')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = done ? '' : lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let chunk: ChatChunk
        try { chunk = JSON.parse(line) as ChatChunk } catch { return protocolError(started, 'invalid_stream') }
        if (chunk.error) return protocolError(started, 'stream_error')
        // Some thinking-capable models emit only a thinking fragment before the
        // configured token limit. Either field proves that inference started.
        if (chunk.message?.content || chunk.message?.thinking) {
          await reader.cancel()
          const rttMs = performance.now() - started
          const classification = isLatencyAnomalous(rttMs, baseline) ? 'HIGH_LATENCY' : 'SUCCESS'
          return { classification, publicStatus: publicStatusFor(classification), httpStatus: response.status, rttMs }
        }
      }
      if (done) return protocolError(started, 'stream_without_content')
    }
  } finally { reader.releaseLock() }
}

function protocolError(started: number, errorCode: string): ProbeResult {
  return { classification: 'PROTOCOL_ERROR', publicStatus: 'CONFIGURATION', rttMs: performance.now() - started, errorCode }
}

export class OllamaHttpError extends Error { constructor(readonly status: number) { super(`http_${status}`) } }
