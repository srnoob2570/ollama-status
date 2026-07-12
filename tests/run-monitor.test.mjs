/* global Response */

import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
    MonitorRunHttpError,
    monitorRunConfigFromEnv,
    runMonitor,
    signedMonitorRunRequest,
} from '../scripts/run-monitor.mjs'

describe('manual monitor run script', () => {
    it('requires the deployment URL and shared confirmation secret', () => {
        expect(() => monitorRunConfigFromEnv({ CONFIRMATION_HMAC_SECRET: 'secret' })).toThrow(
            'OLLAMA_STATUS_URL is required',
        )
        expect(() => monitorRunConfigFromEnv({ OLLAMA_STATUS_URL: 'https://status.example' })).toThrow(
            'CONFIRMATION_HMAC_SECRET is required',
        )
        expect(() =>
            monitorRunConfigFromEnv({
                OLLAMA_STATUS_URL: 'not-a-url',
                CONFIRMATION_HMAC_SECRET: 'secret',
            }),
        ).toThrow('absolute HTTP(S) URL')
        expect(() =>
            monitorRunConfigFromEnv({
                OLLAMA_STATUS_URL: 'https://status.example?environment=staging',
                CONFIRMATION_HMAC_SECRET: 'secret',
            }),
        ).toThrow('must not include a query string or fragment')
        expect(() =>
            monitorRunConfigFromEnv({
                OLLAMA_STATUS_URL: 'https://status.example#monitor',
                CONFIRMATION_HMAC_SECRET: 'secret',
            }),
        ).toThrow('must not include a query string or fragment')
        expect(
            monitorRunConfigFromEnv({
                OLLAMA_STATUS_URL: 'https://status.example///',
                CONFIRMATION_HMAC_SECRET: ' secret ',
            }),
        ).toEqual({ baseUrl: 'https://status.example', secret: ' secret ' })
    })

    it('signs the exact timestamp JSON body with HMAC-SHA256', () => {
        const request = signedMonitorRunRequest(' secret ', 1_234_567)

        expect(request.body).toBe('{"timestamp":1234}')
        expect(request.signature).toBe(createHmac('sha256', ' secret ').update(request.body).digest('hex'))
    })

    it('posts the signed body and prints the successful JSON response', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ jobId: 'job_123', state: 'QUEUED' }), { status: 202 }))
        const logger = { log: vi.fn() }

        await expect(
            runMonitor(
                { baseUrl: 'https://status.example', secret: 'secret' },
                { fetchImpl, logger, now: () => 9_999 },
            ),
        ).resolves.toEqual({ jobId: 'job_123', state: 'QUEUED' })
        expect(fetchImpl).toHaveBeenCalledWith('https://status.example/api/internal/monitor-run', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-monitor-signature': createHmac('sha256', 'secret')
                    .update('{"timestamp":9}')
                    .digest('hex'),
            },
            body: '{"timestamp":9}',
        })
        expect(logger.log).toHaveBeenCalledWith('{"jobId":"job_123","state":"QUEUED"}')
    })

    it('prints the error response and fails for every non-2xx status, including 409', async () => {
        const fetchImpl = vi.fn(async () =>
            new Response(JSON.stringify({ error: 'Monitor run already active' }), { status: 409 }),
        )
        const logger = { log: vi.fn() }

        await expect(
            runMonitor(
                { baseUrl: 'https://status.example', secret: 'secret' },
                { fetchImpl, logger, now: () => 9_999 },
            ),
        ).rejects.toMatchObject({ name: 'MonitorRunHttpError', status: 409 })
        expect(logger.log).toHaveBeenCalledWith('{"error":"Monitor run already active"}')
        await expect(
            runMonitor(
                { baseUrl: 'https://status.example', secret: 'secret' },
                { fetchImpl: async () => new Response('{}', { status: 500 }), logger },
            ),
        ).rejects.toBeInstanceOf(MonitorRunHttpError)
    })
})
