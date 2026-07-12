/* global URL, console, fetch, process */

import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const MONITOR_RUN_PATH = '/api/internal/monitor-run'

export class MonitorRunHttpError extends Error {
    constructor(status) {
        super(`Monitor run request failed with HTTP ${status}`)
        this.name = 'MonitorRunHttpError'
        this.status = status
    }
}

export function monitorRunConfigFromEnv(env = process.env) {
    const rawUrl = env.OLLAMA_STATUS_URL?.trim()
    if (!rawUrl) throw new Error('OLLAMA_STATUS_URL is required')

    let url
    try {
        url = new URL(rawUrl)
    } catch {
        throw new Error('OLLAMA_STATUS_URL must be an absolute HTTP(S) URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('OLLAMA_STATUS_URL must be an absolute HTTP(S) URL')
    if (url.search || url.hash)
        throw new Error('OLLAMA_STATUS_URL must not include a query string or fragment')

    const secret = env.CONFIRMATION_HMAC_SECRET
    if (!secret?.trim()) throw new Error('CONFIRMATION_HMAC_SECRET is required')

    return { baseUrl: rawUrl.replace(/\/+$/, ''), secret }
}

export function signedMonitorRunRequest(secret, now = Date.now()) {
    const body = JSON.stringify({ timestamp: Math.floor(now / 1_000) })
    const signature = createHmac('sha256', secret).update(body).digest('hex')
    return { body, signature }
}

async function responseJson(response) {
    const raw = await response.text()
    try {
        return JSON.parse(raw)
    } catch {
        return { error: raw || 'The monitor endpoint returned an invalid JSON response' }
    }
}

export async function runMonitor(config, { fetchImpl = fetch, logger = console, now = Date.now } = {}) {
    const signed = signedMonitorRunRequest(config.secret, now())
    const response = await fetchImpl(`${config.baseUrl}${MONITOR_RUN_PATH}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-monitor-signature': signed.signature,
        },
        body: signed.body,
    })
    const body = await responseJson(response)
    logger.log(JSON.stringify(body))

    if (!response.ok) throw new MonitorRunHttpError(response.status)
    return body
}

export async function main(env = process.env, dependencies = {}) {
    return runMonitor(monitorRunConfigFromEnv(env), dependencies)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : 'monitor run failed')
        process.exitCode = 1
    })
}
