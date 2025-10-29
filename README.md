# spot
Access to energy spot prices

## Dev notification harness

A lightweight notification/badging test panel ships with the production build but stays hidden unless you opt in.

- To enable it on any device, open `https://spot.utilitarian.io/?dev-harness=1` (or append `?dev-harness=1` to whatever origin you’re testing). The preference is stored in `localStorage`, so the panel will continue to appear on that device until you turn it off.
- Disable it again with `?dev-harness=0`, or run `disableSpotHarness()` from the console. Re-enable with `enableSpotHarness()`.
- When the panel is visible you can pick the data source (production, local files, or a custom origin such as an ngrok tunnel), trigger a synthetic notification, clear the app badge, and request Notification permission without relying on background sync. Choose **Custom…** and enter the HTTPS base URL (for example `https://verified-akita-positive.ngrok-free.app`) to proxy all service-worker fetches through your tunnel; the worker appends `?ngrok-skip-browser-warning=true` and sets the matching header so the browser bypasses ngrok’s splash screen automatically. When tunnelling, start the local server with CORS enabled—either `npx serve -s ./docs -l 8001 --cors` or `python scripts/serve_docs_with_cors.py`.

## App settings flyout

- A cog icon in the header (desktop) or floating in the top-right corner (mobile) opens a dark flyout for managing Spot’s app settings.
- Pick your country and bidding zone inside the flyout. The main chart mirrors the selected country automatically, and the selection is stored in `localStorage`.
- Set your preferred timezone to control how timestamps render across the site (defaults to the browser’s timezone on first load and persists afterwards).
- Settings are stored client-side using Alpine’s persist plugin so the flyout remembers your choices across reloads and devices (per browser profile).
- Toggle **Enable price update notifications** to subscribe to Web Push (uses the Cloudflare Worker at `spot-subscribe.utilitarian.io` plus the hard-coded VAPID public key). The client fetches the latest timestamp when you enable alerts so the first push only fires for newer data.
- The primary notification card on the homepage reflects the current zone and shows the last timestamp seen; the badge is cleared automatically whenever the page regains focus.
- If Push / Service Worker APIs are unavailable (for example on Safari or non-HTTPS origins) the flyout explains the limitation and disables the toggle.

## Cloudflare Worker

- `cloudflare/worker.js` stores Web Push subscriptions and per-zone timestamps in KV.
- `wrangler.toml` targets `spot-subscribe.utilitarian.io` and expects:
  - KV namespace bound as `subscriptions`
  - `ALLOWED_ORIGIN` (defaults to `https://spot.utilitarian.io`)
  - Secret `ADMIN_TOKEN` (`wrangler secret put ADMIN_TOKEN`)
- The public VAPID key is hard-coded in `docs/assets/spot-notify.js`; store the private key wherever your GitHub Action runs so it can send actual pushes later.
- Public endpoints:
  - `POST /subscribe` `{ subscription, zone }` → `{ id, zone }`
  - `DELETE /subscribe/:id`
- Admin endpoints (require `Authorization: Bearer <ADMIN_TOKEN>`):
  - `GET /admin/subs?zone=SE3`
  - `GET|PUT /admin/ts/:zone`
