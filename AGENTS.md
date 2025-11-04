# Repository Guidelines

## Project Structure & Module Organization
The static client lives in `docs/`, with `index.html`, `app.js`, and assets under `docs/assets/`. Historical and latest price payloads sit under `docs/electricity/<AREA>/<YYYY>/<MM>/<DD>/index.json`. Python ingestion utilities sit in `scripts/`, sharing serializers through `scripts/base.py`. The Cloudflare worker and its `wrangler.toml` live in `cloudflare/`, and `requirements.txt` pins the Python dependencies.

## Build, Test, and Development Commands
- `python -m venv .venv && source .venv/bin/activate` — create a virtualenv.
- `pip install -r requirements.txt` — install the ingestion stack (`httpx`, `attrs`, `structlog`, etc.).
- `python scripts/get_spot_prices.py` — download fresh Nord Pool prices for SE1–SE4 and regenerate the JSON tree in `docs/electricity/`.
- `python scripts/calculate_stats_per_day.py` — recompute `stats.json` files with daily min/max/average values.
- `python scripts/serve_docs_with_cors.py --port 8001` — serve the site locally with permissive CORS for tunnelling or service worker testing.
- `python scripts/notify_on_price_update.py [ZONE …]` — detect fresh prices for one or more bidding zones (or all when omitted), send Web Push alerts, and persist the latest timestamp in the Worker (used by the scheduled GitHub Action).

## Coding Style & Naming Conventions
Use 4-space indentation and type hints in Python modules; follow the existing `attrs` patterns and reuse the struct/unstruct helpers in `base.py`. Favor `snake_case` for functions and variables, and keep constants like `PRICE_AREAS` uppercase. JSON outputs should retain ISO8601 timestamps and stringified price values to match the current API contract. In the static client, keep modules lightweight and colocated in `docs/app.js`; asset filenames should stay lowercase with hyphens where applicable.

## Testing Guidelines
There is no automated suite, so rely on scripted verification. After touching ingestion logic, run `python scripts/get_spot_prices.py` and spot-check the regenerated `docs/electricity/.../index.json` files for the affected zones. For statistics changes, rerun `python scripts/calculate_stats_per_day.py` and confirm the updated `stats.json` entries. When updating the worker, use `cd cloudflare && wrangler dev` to exercise subscribe and admin endpoints against a mock KV.

## Commit & Pull Request Guidelines
Keep commits concise and imperative, mirroring history such as “Added new prices” or “Fixed manifest.” Group related data updates together so downstream deploys stay reproducible. Pull requests should summarize the change, list any scripts run (`get_spot_prices.py`, `wrangler publish`, etc.), and note manual verification steps. Attach screenshots for visible UI tweaks and link tracking issues or incidents when relevant.

## Security & Configuration Tips
Do not hard-code secrets; rely on `wrangler secret put ADMIN_TOKEN` for Cloudflare credentials and local `.env` files ignored by git. When sharing tunnels, use the CORS-enabled dev server and prefer HTTPS origins so push notifications mirror production behaviour. Review `cloudflare/wrangler.toml` before publishing to ensure the `subscriptions` KV binding and `ALLOWED_ORIGIN` are correct for the target environment.
