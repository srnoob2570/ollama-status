# Ollama Cloud Status

Cloudflare Worker and React dashboard that monitors the Ollama Cloud free and paid accounts. It discovers one global catalog, probes each model with the free account without retaining output, groups models by free or paid entitlement, and publishes public status.

Models are categorized from the free-account result: a successful free probe means **Free**; a `403` saying the model requires a subscription means **Paid**. That response is expected entitlement information, not an outage or an excluded model. The paid account is probed only after the free response identifies a model as requiring a subscription.

## Local setup

1. Copy `.dev.vars.example` to `.dev.vars` and set disposable Ollama keys.
2. Create a local D1 state: `npx wrangler d1 migrations apply ollama-status --local`.
3. Run `npm run build`, then `npm run dev:worker`.

The dashboard is public at `/`; APIs are under `/api/v1`.

## Options

Worker options are configured under `vars` in `wrangler.jsonc`. The same values are repeated for
each deployment environment so they can be adjusted independently.

| Variable                      | Default                  | Description                                                                                                                                                                               |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OLLAMA_BASE_URL`             | `https://ollama.com/api` | Base URL for the Ollama API.                                                                                                                                                              |
| `OLLAMA_MAX_TOKENS`           | `8`                      | `num_predict` limit for each probe. Use a whole number from `1` to `4096`; larger values make checks slower and consume more quota.                                                       |
| `FREE_CHECK_INTERVAL_MINUTES` | `5`                      | Normal interval between checks of free and unknown models. Allowed values: `5`, `10`, `15`, `20`, `30`, or `60`; other values use the default.                                            |
| `PAID_CHECK_INTERVAL_MINUTES` | `10`                     | Normal interval between checks of paid models. Allowed values: `5`, `10`, `15`, `20`, `30`, or `60`; other values use the default.                                                        |
| `FREE_PROBE_CONCURRENCY`      | `1`                      | Number of free-account probes processed concurrently. Values below `1` fall back to `1`; values above `16` are capped at `16`. Keep this at `1` to avoid free-key `429` responses.       |
| `PAID_PROBE_CONCURRENCY`      | `6`                      | Number of paid-account probes processed concurrently after the corresponding free probe returns `SUBSCRIPTION_REQUIRED`. Values below `1` fall back to `1`; values above `16` are capped at `16`. |
| `PROBE_DELAY_MIN_MS`          | `0`                      | Minimum random delay, in milliseconds, applied before each model check.                                                                                                                   |
| `PROBE_DELAY_MAX_MS`          | `5000`                   | Maximum random delay, in milliseconds, applied before each model check. This value also contributes to the run deadline, so a large value can cause a run to finish only partially.       |
| `EXCLUDED_MODELS`             | _(unset)_                | Comma-separated model names to exclude from monitoring. Set it as a Worker variable when needed.                                                                                          |
| `CONFIRMATION_CALLBACK_URL`   | _(unset)_                | Public endpoint that receives external incident confirmations. It must be set together with the GitHub confirmation options below.                                                        |

The `1h` history is a strict rolling 60-minute window with one bucket per real scheduled model
execution. Bucket counts therefore follow each model's effective interval. Longer ranges keep
their hourly or daily aggregation.

The following values are secrets and must be configured with `wrangler secret put --env <staging|production>`, never in `wrangler.jsonc` or browser code.

| Secret                     | Description                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `OLLAMA_API_KEY_FREE`      | API key used for catalog discovery and free-account probes.                                       |
| `OLLAMA_API_KEY_PAID`      | API key used to check models that require a paid entitlement. Leave it unset to skip paid probes. |
| `CONFIRMATION_HMAC_SECRET` | HMAC secret used to validate incoming external-confirmation callbacks.                            |
| `GITHUB_REPOSITORY`        | Repository in `owner/repository` form whose confirmation workflow is dispatched.                  |
| `GITHUB_ACTIONS_TOKEN`     | Token authorized to dispatch that GitHub Actions workflow.                                        |

External confirmation dispatch is enabled only when `CONFIRMATION_CALLBACK_URL`,
`GITHUB_REPOSITORY`, and `GITHUB_ACTIONS_TOKEN` are all configured. `ENVIRONMENT` is present in
the current environment configuration as a label, but the Worker does not currently read it.

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

## Node.js + Docker (Coolify)

Cloudflare is the primary target, but the same code also runs as a plain Node.js process, so it can be deployed on a VPS with Coolify, plain Docker Compose, or any container platform. This target replaces D1 with `node:sqlite`, the Workers Cache API with an in-process `Map`, and Cron Triggers with `node-cron` — the monitor and API logic in `src/worker/` are unchanged and shared between both targets.

### Local setup

```sh
docker compose up --build
```

This reuses the same `.dev.vars` file as `wrangler dev` (via `env_file` in `docker-compose.yml`) for the Ollama API keys. On first start it runs `scripts/migrate-node.mjs`, applying the same SQL files from `migrations/` against a SQLite database stored in the `sqlite-data` volume (`/app/data/ollama-status.sqlite`); later starts skip migrations already applied. The dashboard is then available at `http://localhost:3000/`.

To iterate without Docker:

```sh
npm run build
npm run migrate:node
npm run dev:node
```

### Variables

Same names as the Cloudflare `vars`/secrets tables above — set them as plain environment variables (or in `.dev.vars` for local Docker use, or through the Coolify UI in production). Additionally:

| Variable  | Default                          | Description                                                    |
| --------- | --------------------------------- | --------------------------------------------------------------- |
| `PORT`    | `3000`                            | HTTP port the Node server listens on.                          |
| `DB_PATH` | `./data/ollama-status.sqlite`     | Path to the SQLite database file (set to `/app/data/ollama-status.sqlite` in `docker-compose.yml` to match the persisted volume). |

The SQLite database used by this target is independent from Cloudflare D1 — there is no data sync between a Cloudflare deployment and a Node/Docker deployment of the same app.

If the cron cadence (`*/5 * * * *`) is ever changed, update it in all three places that must stay in sync: `wrangler.jsonc` (Cron Trigger), `src/node/server.ts` (`node-cron` schedule), and `CRON_INTERVAL_MS` in `src/worker/status.ts`.

An `ExperimentalWarning: SQLite is an experimental feature` line in the logs is expected and benign — it comes from Node's built-in `node:sqlite` module.

### Deploying to Coolify

1. Point Coolify at this repository; it will detect the `Dockerfile`.
2. Attach a persistent volume mounted at `/app/data` (holds the SQLite database).
3. Set the environment variables from the table above (and the Ollama API keys) through the Coolify UI — do not bake secrets into the image.
4. Expose port `3000`.

This path has not been verified against a live Coolify instance from this environment; it has been verified locally with `docker build`, `docker compose up`, and a full monitor cycle against the containerized server.
