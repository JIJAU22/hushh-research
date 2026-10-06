"""Read-only synthetic B2B discovery. No directory, profile or PKM writes."""

from __future__ import annotations

import asyncio
from typing import Any

from starlette.concurrency import run_in_threadpool

from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.runtime_settings import one_business_uat_fixture_enabled


class BusinessSuggestionUnavailable(RuntimeError):
    """Current verified identity could not be established; never use cached identity."""


def build_uat_business_candidate() -> dict[str, Any]:
    """A stable test identity, never a claimant UID or production directory row."""
    return {
        "business_uid": "urn:hushh:business:uat:hushh.ai:v1",
        "synthetic": True,
        "source_identity": {"source": "uat_fixture", "source_key": "hushh.ai:v1"},
        "match_evidence": [{"kind": "verified_email_domain", "domain": "hushh.ai"}],
        "draft": {"name": "Hushh — UAT Test Business", "website": "https://hushh.ai"},
        "ownership_verified": False,
        "claim_created": False,
        "verification_required": ["business_authority"],
    }


def _lookup_identity(user_id: str):
    # Both Admin initialization and its synchronous provider I/O stay off the
    # API event loop. Firebase's shared helper sets a four-second HTTP timeout.
    app = get_firebase_auth_app()
    if app is None:
        raise BusinessSuggestionUnavailable()
    from firebase_admin import auth as firebase_auth

    return firebase_auth.get_user(user_id, app=app)


async def get_business_suggestion(user_id: str) -> dict[str, Any]:
    result: dict[str, Any] = {
        "contract_version": "b2b-profile-suggestion.v1",
        "scope": "b2b",
        "status": "disabled",
        "candidates": [],
        "pkm_written": False,
    }
    # Gate BEFORE provider access. A conflicting deployment label always wins.
    if not one_business_uat_fixture_enabled():
        return result
    try:
        record = await asyncio.wait_for(
            run_in_threadpool(_lookup_identity, user_id), timeout=5
        )
    except Exception:
        raise BusinessSuggestionUnavailable() from None
    # A fresh primary Firebase email, not token claims, aliases or request input.
    if getattr(record, "uid", None) != user_id or getattr(record, "disabled", True):
        raise BusinessSuggestionUnavailable()
    email = getattr(record, "email", None)
    eligible = (
        getattr(record, "email_verified", False) is True
        and isinstance(email, str)
        and email.count("@") == 1
        and bool(email.split("@")[0])
        and not any(char.isspace() for char in email)
        and email.split("@")[1].lower() == "hushh.ai"
    )
    result["status"] = "suggestion_available" if eligible else "no_match"
    if eligible:
        result["candidates"] = [build_uat_business_candidate()]
    return result
