# Ollama Cloud Status

Node app and React dashboard that monitors the Ollama Cloud free and paid accounts. It discovers one global catalog, probes each model with the free account without retaining output, groups models by free or paid entitlement, and publishes public status.

Models are categorized from the free-account result: a successful free probe means **Free**; a `403` saying the model requires a subscription means **Paid**. That response is expected entitlement information, not an outage or an excluded model. The paid account is probed only after the free response identifies a model as requiring a subscription.

## Local setup

### Option A: Docker (recommended)

```sh
docker compose up -d --build
```

This starts PostgreSQL, runs migrations, then launches the web server and the periodic runner. The dashboard is at `http://localhost:3000`.

### Option B: Direct Node

Requires a local PostgreSQL on port 5432.

```sh
cp .env.example .env
# Edit .env with your Ollama API keys
npm install
npm run build
npm run migrate:node
npm run dev:node
```

The dashboard is public at `/`; APIs are under `/api/v1`.

## Options

Environment variables are configured in `.env` (or set directly in the deployment environment).

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
| `EXCLUDED_MODELS`             | _(unset)_                | Comma-separated model names to exclude from monitoring.                                                                                                                                   |
| `CONFIRMATION_CALLBACK_URL`   | _(unset)_                | Public endpoint that receives external incident confirmations. It must be set together with the GitHub confirmation options below.                                                        |

The `1h` history is a strict rolling 60-minute window with one bucket per real scheduled model
execution. Bucket counts therefore follow each model's effective interval. Longer ranges keep
their hourly or daily aggregation.

The following values are secrets and must be set as environment variables, never in code or version control.

| Secret                     | Description                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `OLLAMA_API_KEY_FREE`      | API key used for catalog discovery and free-account probes.                                       |
| `OLLAMA_API_KEY_PAID`      | API key used to check models that require a paid entitlement. Leave it unset to skip paid probes. |
| `CONFIRMATION_HMAC_SECRET` | HMAC secret used to validate incoming external-confirmation callbacks.                            |
| `GITHUB_REPOSITORY`        | Repository in `owner/repository` form whose confirmation workflow is dispatched.                  |
| `GITHUB_ACTIONS_TOKEN`     | Token authorized to dispatch that GitHub Actions workflow.                                        |

External confirmation dispatch is enabled only when `CONFIRMATION_CALLBACK_URL`,
`GITHUB_REPOSITORY`, and `GITHUB_ACTIONS_TOKEN` are all configured. `ENVIRONMENT` is present in
the current environment configuration as a label, but the app does not currently read it.

## Controlled quota test

`npm run quota:test` is a standalone, intentional quota-consumption script. It does not call the app, database, or dashboard APIs. It performs 20 sequential non-streaming chats with `gemma4:31b`, requests up to 256 generated tokens each, and waits one second between requests. It prints request status, duration, and token totals only; generated text is neither printed nor stored.

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

`npm run monitor:run` submits one authenticated monitor job to an existing deployment. It uses the ordinary monitor flow, including its lock, catalog recovery, cleanup, and normal `next_check_at` cadence: it does not force probes for models that are not yet due.

Set these variables in the shell that invokes the command. The script deliberately does not load `.env` or any env file.

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

## Deployment

The app runs as a Docker Compose stack behind a Cloudflare Tunnel (cloudflared). PostgreSQL is the backing store.

### Services

| Service      | Role                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- |
| `postgres`   | PostgreSQL 16 database.                                                                 |
| `migrate`    | Applies schema migrations, then exits.                                                   |
| `web`        | Serves the React SPA, public API, health check, confirmations, and manual-job enqueueing. |
| `runner`     | Keeps a `*/5 * * * *` UTC cadence and polls the manual queue every five seconds.          |
| `cloudflared`| Cloudflare Tunnel ingress; reaches `web` at `http://web:3000` over the internal network. |

### Setup

1. Copy `.env.example` to `.env` and set all required values (Ollama API keys, database URL, confirmation secret, tunnel token).
2. In Cloudflare Zero Trust, create a remotely managed tunnel and configure its public hostname with the service URL `http://web:3000`.
3. Save the tunnel token as `TUNNEL_TOKEN` in `.env`.
4. Deploy the stack:

   ```sh
   docker compose --env-file .env up --build -d
   ```

5. Validate the service at `https://your-domain.com/api/health`, then open the dashboard.

`cloudflared` waits for `web` to be healthy. No container port is exposed on the host; the tunnel reaches `web` through the internal Compose network at `http://web:3000`.

### Variables

All environment variables from the Options table above apply. Additionally:

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | _(required)_ | PostgreSQL connection URL. With Docker Compose the override file sets it to `postgres://postgres:postgres@postgres:5432/ollama_status`. |
| `PORT` | `3000` | HTTP port of the public `web` service. |
| `TUNNEL_TOKEN` | _(required)_ | Token for the remotely managed Cloudflare Tunnel used by the `cloudflared` service. |

### Iterating without Docker

```sh
npm run build
npm run migrate:node
npm run dev:node
```

Run `npm run spike` in staging before enabling any request variant with `raw`; the production probe intentionally omits it until that result is validated.
