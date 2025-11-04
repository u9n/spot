#!/usr/bin/env python3
"""Detect fresh prices and notify subscribers.

Run this script with zero or more bidding zones:

    python scripts/notify_on_price_update.py           # process every zone
    python scripts/notify_on_price_update.py SE1 DK1   # process a subset

When a zone publishes a newer timestamp than the one stored in Cloudflare
Worker KV, the script sends a Web Push notification to all subscribers, prunes
stale endpoints, and records the new timestamp so future runs stay idempotent.
"""

from __future__ import annotations

import json
import os
from hashlib import sha256
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import click
import httpx
from dotenv import load_dotenv
from pywebpush import WebPushException, webpush

from scripts.base import PRICE_AREAS


load_dotenv()


DEFAULT_DATA_ORIGIN = os.getenv("SPOT_DATA_ORIGIN", "https://spot.utilitarian.io")
DEFAULT_ENDPOINT = os.getenv("SPOT_SUBSCRIPTION_ENDPOINT", "https://subscribe.spot.utilitarian.io")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def latest_record(entries: Iterable[Dict[str, Any]]) -> Tuple[str, Dict[str, Any]]:
    best_ts = None
    best_entry: Optional[Dict[str, Any]] = None
    for entry in entries:
        ts = entry.get("timestamp")
        if not isinstance(ts, str):
            continue
        if best_ts is None or ts > best_ts:
            best_ts = ts
            best_entry = entry
    if not best_ts or not best_entry:
        raise click.ClickException("No valid timestamp found in latest price feed.")
    return best_ts, best_entry


def build_payload(zone: str, timestamp: str) -> Dict[str, Any]:
    return {
        "zone": zone,
        "timestamp": timestamp,
        "title": f"New prices available for {zone}",
        "body": "Day-ahead rates were just published.",
        "url": f"/explorer/?zones={zone}",
    }


def load_latest(origin: str, zone: str, client: httpx.Client) -> Tuple[str, Dict[str, Any]]:
    url = f"{origin}/electricity/{zone}/latest/index.json"
    response = client.get(url, timeout=20)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise click.ClickException(f"Unexpected payload shape for {zone}")
    return latest_record(payload)


def fetch_worker_timestamp(endpoint: str, zone: str, token: str, client: httpx.Client) -> Optional[str]:
    url = f"{endpoint}/admin/ts/{zone}"
    response = client.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=20)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    data = response.json()
    ts = data.get("timestamp")
    return ts if isinstance(ts, str) and ts else None


def update_worker_timestamp(endpoint: str, zone: str, token: str, timestamp: str, client: httpx.Client) -> None:
    url = f"{endpoint}/admin/ts/{zone}"
    response = client.put(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        content=json.dumps({"timestamp": timestamp}),
        timeout=20,
    )
    response.raise_for_status()


def fetch_subscriptions(endpoint: str, zone: str, token: str, client: httpx.Client) -> List[Dict[str, Any]]:
    url = f"{endpoint}/admin/subs"
    response = client.get(
        url,
        params={"zone": zone},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise click.ClickException(f"Unexpected subscription payload for {zone}")
    return payload


def subscription_identifier(subscription: Dict[str, Any]) -> Optional[str]:
    endpoint = subscription.get("endpoint")
    if isinstance(endpoint, str) and endpoint:
        return sha256(endpoint.encode("utf-8")).hexdigest()
    return None


def delete_subscription(endpoint: str, subscription_id: str, token: str, client: httpx.Client) -> None:
    url = f"{endpoint}/subscribe/{subscription_id}"
    client.delete(url, headers={"Authorization": f"Bearer {token}"}, timeout=15)


def send_push(subscription: Dict[str, Any], payload: Dict[str, Any], ttl: int, vapid_key: str, vapid_subject: str) -> None:
    webpush(
        subscription_info=subscription,
        data=json.dumps(payload, separators=(",", ":")),
        ttl=ttl,
        vapid_private_key=vapid_key,
        vapid_claims={"sub": vapid_subject},
    )


def process_zone(
    zone: str,
    origin: str,
    endpoint: str,
    client: httpx.Client,
    admin_token: str,
    vapid_key: str,
    vapid_subject: str,
    ttl: int,
) -> None:
    click.echo(f"Processing zone {zone}…")

    try:
        latest_ts, _ = load_latest(origin, zone, client)
    except httpx.HTTPStatusError as err:
        if err.response.status_code == 404:
            click.echo("  · Latest data not found (404); skipping.")
            return
        raise click.ClickException(f"Failed to fetch latest data for {zone}: {err}") from err
    except httpx.HTTPError as err:
        raise click.ClickException(f"Failed to fetch latest data for {zone}: {err}") from err

    try:
        stored_ts = fetch_worker_timestamp(endpoint, zone, admin_token, client)
    except httpx.HTTPError as err:
        raise click.ClickException(f"Failed to read worker timestamp for {zone}: {err}") from err

    if not stored_ts:
        click.echo("  · No previous timestamp stored; writing current value and exiting.")
        try:
            update_worker_timestamp(endpoint, zone, admin_token, latest_ts, client)
        except httpx.HTTPError as err:
            raise click.ClickException(f"Failed to update timestamp for {zone}: {err}") from err
        return

    if latest_ts <= stored_ts:
        click.echo("  – No new data.")
        return

    click.echo(f"  + New data detected ({stored_ts} → {latest_ts}).")
    payload = build_payload(zone, latest_ts)

    try:
        subscriptions = fetch_subscriptions(endpoint, zone, admin_token, client)
    except httpx.HTTPError as err:
        raise click.ClickException(f"Failed to fetch subscriptions for {zone}: {err}") from err

    if not subscriptions:
        click.echo("  · No subscribers for this zone; updating cursor.")
        try:
            update_worker_timestamp(endpoint, zone, admin_token, latest_ts, client)
        except httpx.HTTPError as err:
            raise click.ClickException(f"Failed to update timestamp for {zone}: {err}") from err
        return

    sent = 0
    removed = 0
    for subscription in subscriptions:
        try:
            send_push(subscription, payload, ttl, vapid_key, vapid_subject)
            sent += 1
        except WebPushException as err:
            status = err.response.status_code if err.response else None
            click.echo(f"    ! Push failed (status {status}); pruning subscription.")
            sub_id = subscription_identifier(subscription)
            if sub_id:
                delete_subscription(endpoint, sub_id, admin_token, client)
                removed += 1
        except Exception as err:  # noqa: BLE001
            click.echo(f"    ! Unexpected push failure: {err}")

    try:
        update_worker_timestamp(endpoint, zone, admin_token, latest_ts, client)
    except httpx.HTTPError as err:
        raise click.ClickException(f"Failed to persist timestamp for {zone}: {err}") from err

    click.echo(f"  · Sent {sent} notification(s); removed {removed} stale subscription(s).")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


@click.command(context_settings={"help_option_names": ["-h", "--help"]})
@click.argument("zones", nargs=-1)
@click.option("--data-origin", default=DEFAULT_DATA_ORIGIN, show_default=True, help="Base URL for price JSON.")
@click.option(
    "--endpoint",
    default=DEFAULT_ENDPOINT,
    show_default=True,
    help="Cloudflare Worker endpoint (subscription API).",
)
@click.option("--ttl", type=int, default=300, show_default=True, help="Notification TTL in seconds.")
def main(zones: Sequence[str], data_origin: str, endpoint: str, ttl: int) -> None:
    """Detect fresh prices for ZONES (or all zones if none provided)."""

    admin_token = os.getenv("SPOT_ADMIN_TOKEN") or os.getenv("ADMIN_TOKEN")
    if not admin_token:
        raise click.ClickException("Environment variable SPOT_ADMIN_TOKEN (or ADMIN_TOKEN) is required.")

    vapid_key = os.getenv("VAPID_PRIVATE_KEY")
    if not vapid_key:
        raise click.ClickException("Environment variable VAPID_PRIVATE_KEY is required.")

    vapid_subject = os.getenv("SPOT_VAPID_SUBJECT", "mailto:alerts@example.com")

    if zones:
        requested = [zone.upper() for zone in zones]
        unknown = sorted(set(requested) - PRICE_AREAS)
        if unknown:
            raise click.ClickException(
                f"Unsupported zone(s): {', '.join(unknown)}. Available zones: {', '.join(sorted(PRICE_AREAS))}"
            )
        zone_list = requested
    else:
        zone_list = sorted(PRICE_AREAS)

    origin = data_origin.rstrip("/")
    endpoint = endpoint.rstrip("/")

    errors = 0

    with httpx.Client() as client:
        for zone in zone_list:
            try:
                process_zone(zone, origin, endpoint, client, admin_token, vapid_key, vapid_subject, ttl)
            except click.ClickException as err:
                errors += 1
                click.echo(f"  ! {err}", err=True)
            except Exception as err:  # noqa: BLE001
                errors += 1
                click.echo(f"  ! Unexpected error for zone {zone}: {err}", err=True)

    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
