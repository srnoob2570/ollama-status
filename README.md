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

## Run the monitor remotely

`npm run monitor:run` submits one authenticated monitor job to an existing Cloudflare or Node/Coolify deployment. It uses the ordinary monitor flow, including its lock, catalog recovery, cleanup, and normal `next_check_at` cadence: it does not force probes for models that are not yet due.

Set these variables in the shell that invokes the command. The script deliberately does not load `.dev.vars` or any env file.

| Variable | Description |
| --- | --- |
| `OLLAMA_STATUS_URL` | Public deployment base URL, for example `https://status.example.com`. A trailing slash is accepted. |
| `CONFIRMATION_HMAC_SECRET` | Same secret used for external confirmation callbacks; it signs the timestamped request body with HMAC-SHA256. |

```sh
OLLAMA_STATUS_URL=https://status.example.com \
CONFIRMATION_HMAC_SECRET=replace-with-the-configured-secret \
npm run monitor:run
```

The command prints the endpoint JSON response and exits successfully for `202 { jobId, state: "QUEUED" }`. Only one manual job may be active; a concurrent request receives the active job ID. The runner records the final result in normal monitor history and logs. Invalid/expired timestamps return `400`, invalid signatures `401`, an absent shared secret `503`, and oversized requests `413`.

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

Cloudflare is the primary target, but the same code also runs on Node.js for Coolify. This target replaces D1 with managed PostgreSQL, the Workers Cache API with an in-process `Map`, and Cron Triggers with a private runner — the monitor and API logic in `src/worker/` are shared between both targets.

### Local setup

Set `DATABASE_URL` plus the required runner secrets, then start the Compose stack. PostgreSQL is deliberately external to this file (a Coolify managed resource in production).

```sh
DATABASE_URL=postgres://user:password@host:5432/ollama_status \
OLLAMA_API_KEY_FREE=... OLLAMA_API_KEY_PAID=... \
CONFIRMATION_HMAC_SECRET=... \
docker compose up --build
```

`migrate` applies the PostgreSQL-only migrations before `web` and `runner` start. `web` serves the SPA, public API, health check, confirmations, and manual-job enqueueing. `runner` has no published port, keeps the `*/5 * * * *` UTC cadence, and polls the manual queue every five seconds.

### Deployment through Cloudflare Tunnel

1. In Cloudflare Zero Trust, create a remotely managed tunnel and configure its public hostname with the service URL `http://web:3000`.
2. Save the tunnel token in the deployment host's `.dev.vars` file as `TUNNEL_TOKEN=...`. Keep this file out of Git.
3. Deploy the stack:

   ```sh
   docker compose --env-file .dev.vars up --build -d
   ```

4. Validate the service at `https://ollama-status-staging.bitario.dev/api/health`, then open `https://ollama-status-staging.bitario.dev` to check the dashboard.

`cloudflared` is part of the main Compose stack and waits for `web` to be healthy. No container port is exposed on the host; the tunnel reaches `web` through the internal Compose network at `http://web:3000`.

To iterate without Docker:

```sh
npm run build
npm run migrate:node
npm run dev:node
```

### Variables

Same names as the Cloudflare `vars`/secrets tables above — set them as plain environment variables (or in `.dev.vars` for local Docker use, or through the Coolify UI in production). Additionally:

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | _(required)_ | PostgreSQL connection URL provided by Coolify; use its full internal hostname when the stack joins the predefined network. |
| `PORT` | `3000` | HTTP port of the public `web` service. |
| `TUNNEL_TOKEN` | _(required)_ | Token for the remotely managed Cloudflare Tunnel used by the `cloudflared` service. |

The PostgreSQL database used by this target is independent from Cloudflare D1 — there is no data sync between a Cloudflare deployment and a Node/Coolify deployment of the same app.

If the cron cadence (`*/5 * * * *`) is ever changed, update it in all three places that must stay in sync: `wrangler.jsonc` (Cron Trigger), `src/node/server.ts` (`node-cron` schedule), and `CRON_INTERVAL_MS` in `src/worker/status.ts`.

### Deploying to Coolify

1. Create PostgreSQL as a managed Coolify database, then enable **Connect to Predefined Network** for this Compose stack. Set `DATABASE_URL` from Coolify's full internal hostname; do not commit it.
2. Create a **Docker Compose** application using this repository. Coolify detects the interpolated variables: `DATABASE_URL` is required by all three services; Ollama keys and GitHub confirmation credentials are required only by `runner`; `web` receives neither Ollama nor GitHub credentials.
3. Configure the Cloudflare Tunnel public hostname to point to `http://web:3000`, and set `TUNNEL_TOKEN` in the application's environment. Do not assign Coolify domains or host ports to any service.
4. Configure the database's S3 backup in Coolify for daily 02:00 UTC backups with 30-day retention. Keep S3 credentials only in Coolify. Restore one backup into a temporary instance before declaring the deployment complete.
5. Deploy an empty PostgreSQL resource, let `migrate` complete, verify `/api/health`, submit `npm run monitor:run`, and observe a periodic runner cycle.
