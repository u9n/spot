#!/usr/bin/env python3
"""
Send a single Web Push notification to an existing subscription.

The script loads VAPID credentials from environment variables (optionally via
a `.env` file) and prompts for the subscription JSON so you can paste it
directly from Worker KV exports.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

import click
from dotenv import load_dotenv
from pywebpush import WebPushException, webpush

# Load environment variables from .env (if present) before we inspect os.environ.
load_dotenv()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json_value(value: str) -> Dict[str, Any]:
    """Accept a file path or inline JSON string and return the parsed object."""
    candidate = Path(value)
    if candidate.exists():
        try:
            with candidate.open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except OSError as err:
            raise click.ClickException(f"Unable to read {candidate}: {err}") from err
        except json.JSONDecodeError as err:
            raise click.ClickException(f"Invalid JSON in {candidate}: {err}") from err

    try:
        return json.loads(value)
    except json.JSONDecodeError as err:
        raise click.ClickException(f"Provided value is not valid JSON: {err}") from err


def load_payload(payload: Optional[str], payload_file: Optional[str]) -> Dict[str, Any]:
    if payload and payload_file:
        raise click.ClickException("Use either --payload or --payload-file, not both.")
    if payload_file:
        return load_json_value(payload_file)
    if payload:
        return load_json_value(payload)
    # Default payload if nothing supplied.
    return {
        "title": "Spot",
        "body": "Manual web push test",
        "tag": "manual-test",
    }


def load_private_key(value: str) -> str:
    candidate = Path(value)
    if candidate.exists():
        try:
            return candidate.read_text(encoding="utf-8").strip()
        except OSError as err:
            raise click.ClickException(f"Unable to read private key file {value}: {err}") from err
    return value.strip()


def prompt_subscription() -> Dict[str, Any]:
    click.echo("Paste the subscription JSON (single line) and press Enter:")
    raw = click.get_text_stream("stdin").readline().strip()
    if not raw:
        raise click.ClickException("No subscription data provided.")
    return load_json_value(raw)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command(context_settings={"help_option_names": ["-h", "--help"]})
@click.option(
    "--subscription-file",
    "-s",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Optional path to the subscription JSON (if omitted you will be prompted).",
)
@click.option(
    "--payload",
    "-p",
    help="Inline JSON payload.",
)
@click.option(
    "--payload-file",
    "-f",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Path to a payload JSON file.",
)
@click.option(
    "--vapid-private-key",
    "-k",
    help="Override VAPID private key (PEM file path or base64 string). Defaults to env VAPID_PRIVATE_KEY.",
)
@click.option(
    "--vapid-subject",
    "-u",
    default=lambda: os.getenv("VAPID_SUBJECT", "mailto:alerts@example.com"),
    show_default=True,
    help="VAPID subject / contact URI.",
)
@click.option(
    "--ttl",
    type=int,
    default=60,
    show_default=True,
    help="Time-to-live for the push message in seconds.",
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Print the prepared request without sending it.",
)
def main(
    subscription_file: Optional[Path],
    payload: Optional[str],
    payload_file: Optional[Path],
    vapid_private_key: Optional[str],
    vapid_subject: str,
    ttl: int,
    dry_run: bool,
) -> None:
    """
    Trigger a Web Push notification for an existing subscription.
    """
    if subscription_file:
        subscription = load_json_value(str(subscription_file))
    else:
        subscription = prompt_subscription()

    payload_data = load_payload(payload, str(payload_file) if payload_file else None)
    vapid_key_source = vapid_private_key or os.getenv("VAPID_PRIVATE_KEY")

    if not vapid_key_source:
        vapid_key_source = click.prompt(
            "VAPID private key (PEM path or base64)", hide_input=False
        )
    vapid_key = load_private_key(vapid_key_source)

    payload_bytes = json.dumps(payload_data, separators=(",", ":")).encode("utf-8")

    if dry_run:
        click.echo("Dry run — prepared request:")
        click.echo(
            json.dumps(
                {
                    "endpoint": subscription.get("endpoint"),
                    "payload": payload_data,
                    "ttl": ttl,
                    "subject": vapid_subject,
                },
                indent=2,
            )
        )
        return

    try:
        webpush(
            subscription_info=subscription,
            data=payload_bytes,
            ttl=ttl,
            vapid_private_key=vapid_key,
            vapid_claims={"sub": vapid_subject},
        )
    except WebPushException as err:
        status = err.response.status_code if err.response else "n/a"
        body = err.response.text if err.response else str(err)
        raise click.ClickException(f"Push delivery failed (status {status}): {body}") from err

    click.echo("Push notification sent successfully.")


if __name__ == "__main__":
    main()
