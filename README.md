# Ollama Cloud Status

Cloudflare Worker and React dashboard that monitors the Ollama Cloud free and paid accounts. It discovers one global catalog, probes each model with both accounts without retaining output, groups models by free or paid entitlement, and publishes public status.

Models are categorized from the free-account result: a successful free probe means **Free**; a `403` saying the model requires a subscription means **Paid**. That response is expected entitlement information, not an outage or an excluded model. The paid account is still probed for both categories because it can use free models while consuming quota.

## Local setup

1. Copy `.dev.vars.example` to `.dev.vars` and set disposable Ollama keys.
2. Create a local D1 state: `npx wrangler d1 migrations apply ollama-status --local`.
3. Run `npm run build`, then `npm run dev:worker`.

The dashboard is public at `/`; APIs are under `/api/v1`.

`OLLAMA_MAX_TOKENS` configures the `num_predict` limit for each probe. It defaults to `8`; use a whole number from `1` to `4096`. Higher values make each check slower and consume more Ollama quota.

## Deploy safely

Replace all `REPLACE_WITH_*_D1_ID` values in `wrangler.jsonc`, configure the custom-domain routes in Cloudflare, and create both named queues. Apply migrations before each Worker deployment:

```sh
npx wrangler d1 migrations apply ollama-status-staging --remote --env staging
npm run deploy:staging
# Observe the staging monitor for 24 hours, run the spike, then promote manually.
npx wrangler d1 migrations apply ollama-status --remote --env production
npm run deploy:production
```

Use `wrangler secret put --env <staging|production>` for `OLLAMA_API_KEY_FREE`, `OLLAMA_API_KEY_PAID`, alert webhook URLs, and confirmation secrets. Do not put secrets in `wrangler.jsonc`, D1, or browser code.

Run `npm run spike` in staging before enabling any request variant with `raw`; the production probe intentionally omits it until that result is validated.
