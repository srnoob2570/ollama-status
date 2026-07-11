/* global console, fetch, performance, process, setTimeout */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const DEFAULT_BASE_URL = 'https://ollama.com/api'
const DEFAULT_MODEL = 'gemma4:31b'
const DEFAULT_REQUESTS = 20
const DEFAULT_MAX_TOKENS = 256
const REQUEST_DELAY_MS = 1_000

const quotaPrompt =
    'Escribe un ensayo técnico de aproximadamente 220 palabras que explique cómo se diseña una prueba de carga responsable para una API de modelos de lenguaje. Incluye objetivos, métricas, límites de seguridad y cómo interpretar errores de cuota. No uses listas.'

function integerFromEnv(env, name, defaultValue, minimum, maximum) {
    const value = env[name]
    if (value === undefined || value.trim() === '') return defaultValue
    if (!/^\d+$/.test(value))
        throw new Error(`${name} must be a whole number between ${minimum} and ${maximum}`)

    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
        throw new Error(`${name} must be a whole number between ${minimum} and ${maximum}`)
    return parsed
}

export function quotaConfigFromEnv(env = process.env) {
    const apiKey = env.OLLAMA_API_KEY?.trim()
    if (!apiKey) throw new Error('OLLAMA_API_KEY is required')

    const baseUrl = (env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
    const model = env.OLLAMA_QUOTA_MODEL?.trim() || DEFAULT_MODEL
    return {
        apiKey,
        baseUrl,
        model,
        requests: integerFromEnv(env, 'OLLAMA_QUOTA_REQUESTS', DEFAULT_REQUESTS, 15, 30),
        maxTokens: integerFromEnv(env, 'OLLAMA_QUOTA_MAX_TOKENS', DEFAULT_MAX_TOKENS, 1, 4096),
    }
}

function optionalCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

async function responseBody(response) {
    try {
        return await response.json()
    } catch {
        return null
    }
}

export async function quotaAttempt(config, fetchImpl = fetch, clock = performance) {
    const started = clock.now()
    try {
        const response = await fetchImpl(`${config.baseUrl}/chat`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${config.apiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: config.model,
                messages: [{ role: 'user', content: quotaPrompt }],
                stream: false,
                think: false,
                options: { num_predict: config.maxTokens, temperature: 0 },
            }),
        })
        const body = await responseBody(response)
        return {
            ok: response.ok,
            status: response.status,
            elapsedMs: Math.round(clock.now() - started),
            promptTokens: optionalCount(body?.prompt_eval_count),
            generatedTokens: optionalCount(body?.eval_count),
        }
    } catch {
        return {
            ok: false,
            status: 'NETWORK_ERROR',
            elapsedMs: Math.round(clock.now() - started),
            promptTokens: null,
            generatedTokens: null,
        }
    }
}

export function quotaSummary(config, attempts) {
    const statusCounts = {}
    let successfulRequests = 0
    let totalPromptTokens = 0
    let totalGeneratedTokens = 0
    let totalElapsedMs = 0

    for (const attempt of attempts) {
        if (attempt.ok) successfulRequests += 1
        statusCounts[attempt.status] = (statusCounts[attempt.status] ?? 0) + 1
        totalPromptTokens += attempt.promptTokens ?? 0
        totalGeneratedTokens += attempt.generatedTokens ?? 0
        totalElapsedMs += attempt.elapsedMs
    }

    return {
        event: 'quota-test:summary',
        model: config.model,
        requestedAttempts: config.requests,
        successfulRequests,
        failedRequests: attempts.length - successfulRequests,
        totalPromptTokens,
        totalGeneratedTokens,
        totalElapsedMs,
        statusCounts,
    }
}

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

export async function runQuotaTest(config, { fetchImpl = fetch, sleepImpl = sleep, logger = console, clock = performance } = {}) {
    logger.log(
        JSON.stringify({
            event: 'quota-test:start',
            model: config.model,
            requests: config.requests,
            maxTokens: config.maxTokens,
            delayMs: REQUEST_DELAY_MS,
        }),
    )

    const attempts = []
    for (let index = 0; index < config.requests; index += 1) {
        const attempt = await quotaAttempt(config, fetchImpl, clock)
        attempts.push(attempt)
        logger.log(JSON.stringify({ event: 'quota-test:attempt', attempt: index + 1, ...attempt }))
        if (index < config.requests - 1) await sleepImpl(REQUEST_DELAY_MS)
    }

    const summary = quotaSummary(config, attempts)
    logger.log(JSON.stringify(summary))
    return summary
}

export async function main(argv = process.argv.slice(2), env = process.env) {
    const config = quotaConfigFromEnv(env)
    if (argv.includes('--dry-run')) {
        console.log(
            JSON.stringify({
                event: 'quota-test:dry-run',
                baseUrl: config.baseUrl,
                model: config.model,
                requests: config.requests,
                maxTokens: config.maxTokens,
                delayMs: REQUEST_DELAY_MS,
            }),
        )
        return
    }
    await runQuotaTest(config)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : 'quota test failed')
        process.exitCode = 1
    })
}
