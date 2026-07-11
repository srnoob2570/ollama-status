# Tier-specific check intervals

## Goal

Make the normal monitoring cadence configurable independently for models classified as
free and paid. The defaults will be five minutes for free models and ten minutes for paid
models.

## Configuration

Add two non-secret Worker variables to the base, staging, and production `vars` blocks:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FREE_CHECK_INTERVAL_MINUTES` | `5` | Normal interval between checks of a `FREE` model. |
| `PAID_CHECK_INTERVAL_MINUTES` | `10` | Normal interval between checks of a `PAID` model. |

They will also be available in `.dev.vars.example` and documented in the README options
table. Values are whole minutes. Missing, invalid, or non-positive values fall back to the
defaults so a misconfigured deployment cannot stop model scheduling.

## Runtime behavior

The Worker will add the variables to `Env` and pass the configuration into the normal
cadence calculation. `FREE` models use the free interval; `PAID` models use the paid
interval; `UNKNOWN` models retain the free interval as the safe default.

Existing exceptional scheduling remains unchanged: authentication failures wait 60 minutes,
rate limiting honors `Retry-After` with its existing lower bound, and degraded/outage states
are retried after 15 minutes. The new variables only control the healthy, nominal cadence.

Cloudflare's cron remains the five-minute tick. The monitor selects only records due at that
time, so the ten-minute paid cadence naturally runs every other tick without a second
scheduler or monitor path.

## Verification

Tests will assert the defaults, both configured tier intervals, invalid-value fallbacks, and
that exceptional status backoffs still override normal tier cadence. Type checking and the
existing test suite will be run after the changes.
