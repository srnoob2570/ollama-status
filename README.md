# Ollama Cloud Status

Cloudflare Worker and React dashboard that monitors the Ollama Cloud free and paid accounts. It discovers one global catalog, probes each model with both accounts without retaining output, groups models by free or paid entitlement, and publishes public status.

Models are categorized from the free-account result: a successful free probe means **Free**; a `403` saying the model requires a subscription means **Paid**. That response is expected entitlement information, not an outage or an excluded model. The paid account is still probed for both categories because it can use free models while consuming quota.

## Local setup

1. Copy `.dev.vars.example` to `.dev.vars` and set disposable Ollama keys.
2. Create a local D1 state: `npx wrangler d1 migrations apply ollama-status --local`.
3. Run `npm run build`, then `npm run dev:worker`.

The dashboard is public at `/`; APIs are under `/api/v1`.

`OLLAMA_MAX_TOKENS` configures the `num_predict` limit for each probe. It defaults to `8`; use a whole number from `1` to `4096`. Higher values make each check slower and consume more Ollama quota.

## Controlled quota test

`npm run quota:test` is a standalone, intentional quota-consumption script. It does not call the Worker, D1, or dashboard APIs. It performs 20 sequential non-streaming chats with `gemma4:31b`, requests up to 256 generated tokens each, and waits one second between requests. It prints request status, duration, and token totals only; generated text is neither printed nor stored.

Supply the key for the Ollama account whose dashboard you want to inspect:

```sh
OLLAMA_API_KEY=replace-with-disposable-key npm run quota:test
```

Before spending quota, validate the effective settings without issuing an API request:

```sh
OLLAMA_API_KEY=replace-with-disposable-key npm run quota:test -- --dry-run
```

Optional variables are `OLLAMA_BASE_URL` (default `https://ollama.com/api`), `OLLAMA_QUOTA_MODEL` (default `gemma4:31b`), `OLLAMA_QUOTA_REQUESTS` (15–30; default `20`), and `OLLAMA_QUOTA_MAX_TOKENS` (1–4096; default `256`). The script continues after failures, including `429`, without retries so its final JSON summary shows all attempted consumption. Review the Ollama usage dashboard manually after it finishes; usage can appear with a delay.

## Deploy safely

Replace all `REPLACE_WITH_*_D1_ID` values in `wrangler.jsonc` and configure the custom-domain routes in Cloudflare. Apply migrations before each Worker deployment:

```sh
npx wrangler d1 migrations apply ollama-status-staging --remote --env staging
npm run deploy:staging
# Observe the staging monitor for 24 hours, run the spike, then promote manually.
npx wrangler d1 migrations apply ollama-status --remote --env production
npm run deploy:production
```

Use `wrangler secret put --env <staging|production>` for `OLLAMA_API_KEY_FREE`, `OLLAMA_API_KEY_PAID`, and confirmation secrets. Do not put secrets in `wrangler.jsonc`, D1, or browser code.

Run `npm run spike` in staging before enabling any request variant with `raw`; the production probe intentionally omits it until that result is validated.
