/* global Response */

import { describe, expect, it, vi } from 'vitest'
import { quotaAttempt, quotaConfigFromEnv, quotaSummary, runQuotaTest } from '../scripts/quota-test.mjs'

const config = {
    apiKey: 'test-key',
    baseUrl: 'https://example.test/api',
    model: 'gemma4:31b',
    requests: 20,
    maxTokens: 256,
}

describe('quota test script', () => {
    it('uses defaults and rejects an unsafe request count', () => {
        expect(quotaConfigFromEnv({ OLLAMA_API_KEY: 'key' })).toMatchObject({
            baseUrl: 'https://ollama.com/api',
            model: 'gemma4:31b',
            requests: 20,
            maxTokens: 256,
        })
        expect(() => quotaConfigFromEnv({ OLLAMA_API_KEY: 'key', OLLAMA_QUOTA_REQUESTS: '31' })).toThrow(
            'OLLAMA_QUOTA_REQUESTS',
        )
        expect(() => quotaConfigFromEnv({ OLLAMA_API_KEY: 'key', OLLAMA_QUOTA_MAX_TOKENS: 'nope' })).toThrow(
            'OLLAMA_QUOTA_MAX_TOKENS',
        )
    })

    it('reports token counts without exposing generated text', async () => {
        const fetchImpl = vi.fn(async () =>
            new Response(
                JSON.stringify({ response: 'private generated text', prompt_eval_count: 12, eval_count: 34 }),
                { status: 200 },
            ),
        )
        const attempt = await quotaAttempt(config, fetchImpl, { now: () => 10 })

        expect(attempt).toEqual({
            ok: true,
            status: 200,
            elapsedMs: 0,
            promptTokens: 12,
            generatedTokens: 34,
        })
        expect(JSON.stringify(attempt)).not.toContain('private generated text')
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
            model: 'gemma4:31b',
            stream: false,
            think: false,
            options: { num_predict: 256 },
        })
    })

    it('continues after failed requests and aggregates statuses and tokens', async () => {
        const responses = [
            new Response(JSON.stringify({ prompt_eval_count: 10, eval_count: 20 }), { status: 200 }),
            new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }),
        ]
        const fetchImpl = vi.fn(async () => responses.shift())
        const logger = { log: vi.fn() }
        const sleepImpl = vi.fn(async () => {})
        const summary = await runQuotaTest(
            { ...config, requests: 2 },
            { fetchImpl, sleepImpl, logger, clock: { now: () => 5 } },
        )

        expect(summary).toMatchObject({
            successfulRequests: 1,
            failedRequests: 1,
            totalPromptTokens: 10,
            totalGeneratedTokens: 20,
            statusCounts: { 200: 1, 429: 1 },
        })
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(sleepImpl).toHaveBeenCalledOnce()
        expect(quotaSummary({ ...config, requests: 2 }, []).failedRequests).toBe(0)
    })
})
