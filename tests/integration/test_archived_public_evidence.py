"""Read-only verification of archived public Studio-dev Decision evidence.

Three conclusions stay separate: archive arithmetic, historical wallet-run
label, and independent RPC replay. Unavailable RPC is UNPROVEN (skip), never pass.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from verify_archived_public_evidence import (  # noqa: E402
    REQUIRED_LIVE_FIELDS,
    conclusions,
    historical_wallet_run,
    live_observations,
    load_archive,
    snapshot_checks,
)

REWARD = 500_000_000_000_000_000
FEE = 126_529_250_000_823
PARENT = "0xa1dbcd046445f8ccfaf4d8f2917e20628a55a19ef9f6c1262107ba75f681060b"
CHILD = "0xa5817ff984a9591705eabe9e9abe7a5e2a0a628ec67454a8f14f24cf82af49e6"
TRANSLATOR = "0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253"
PIN = "6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f"
CONTRACT = "0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96"


def _parent_receipt(**overrides):
    receipt = {
        "hash": PARENT,
        "status": "FINALIZED",
        "txExecutionResultName": "FINISHED_WITH_RETURN",
        "primary_fee_spent": FEE,
        "messages": [
            {
                "messageType": "0",
                "recipient": TRANSLATOR,
                "value": str(REWARD),
            }
        ],
    }
    receipt.update(overrides)
    return receipt


def _child_receipt(**overrides):
    receipt = {
        "hash": CHILD,
        "to": TRANSLATOR,
        "value": REWARD,
        "value_credited": True,
        "triggered_by": PARENT,
    }
    receipt.update(overrides)
    return receipt


def _rpc(parent=None, child=None, source="class LocaleBounty\n", http_error=None):
    def call(method: str, params: list):
        if http_error:
            raise RuntimeError(http_error)
        if method == "gen_getContractCode":
            return source
        tx_id = str(params[0]).lower() if params else ""
        if tx_id == PARENT.lower():
            return parent
        if tx_id == CHILD.lower():
            return child
        return None

    return call


def test_archived_public_decision_snapshot_is_internally_consistent():
    archive = load_archive()
    errors = snapshot_checks(archive)
    assert errors == [], errors
    assert archive["kind"] == "localebounty.product-ui.decision-evidence.v1"
    assert archive["payoutSubmittedNote"]


def test_historical_wallet_run_yes_is_separate_from_rpc():
    archive = load_archive()
    hist = historical_wallet_run(archive)
    assert hist["status"] == "YES"
    live = live_observations(archive, _rpc(http_error="HTTP 403 Forbidden for eth_getTransactionByHash"))
    assert live["status"] == "UNPROVEN"
    assert live["payment_verified"] is False
    assert hist["status"] == "YES"


def test_http_403_marks_each_required_field_unproven_and_does_not_pass():
    archive = load_archive()
    live = live_observations(archive, _rpc(http_error="HTTP 403 Forbidden for eth_getTransactionByHash"))
    assert live["status"] == "UNPROVEN"
    assert live["payment_verified"] is False
    for name in REQUIRED_LIVE_FIELDS:
        assert live["fields"][name]["status"] == "UNPROVEN", name
    assert "UNPROVEN fields:" in " ".join(live["notes"])


def test_hash_presence_alone_is_not_payment_verified():
    archive = load_archive()
    live = live_observations(
        archive,
        _rpc(parent={"hash": PARENT}, child={"hash": CHILD}, source=None),
    )
    assert live["parent"]["present"] is True
    assert live["child"]["present"] is True
    assert live["payment_verified"] is False
    assert live["status"] == "UNPROVEN"
    assert live["fields"]["parent_status"]["status"] == "UNPROVEN"
    assert live["fields"]["child_value_credited"]["status"] == "UNPROVEN"


def test_mismatched_child_triggered_by_is_contradicted():
    archive = load_archive()
    live = live_observations(
        archive,
        _rpc(
            parent=_parent_receipt(),
            child=_child_receipt(triggered_by="0x" + "11" * 32),
            source="class LocaleBounty\n",
        ),
    )
    assert live["fields"]["child_triggered_by"]["status"] == "CONTRADICTED"
    assert live["status"] == "CONTRADICTED"
    assert live["payment_verified"] is False


def test_mismatched_amount_is_contradicted():
    archive = load_archive()
    live = live_observations(
        archive,
        _rpc(
            parent=_parent_receipt(messages=[{"messageType": "0", "recipient": TRANSLATOR, "value": "1"}]),
            child=_child_receipt(value=1),
            source="class LocaleBounty\n",
        ),
    )
    assert live["fields"]["outgoing_ethsend_value"]["status"] == "CONTRADICTED"
    assert live["fields"]["child_value"]["status"] == "CONTRADICTED"
    assert live["status"] == "CONTRADICTED"


def test_mismatched_recipient_is_contradicted():
    archive = load_archive()
    other = "0x31e14df3b4f47F2428F3B78E7279691A78f70a05"
    live = live_observations(
        archive,
        _rpc(
            parent=_parent_receipt(messages=[{"messageType": "0", "recipient": other, "value": str(REWARD)}]),
            child=_child_receipt(to=other),
            source="class LocaleBounty\n",
        ),
    )
    assert live["fields"]["outgoing_ethsend_recipient"]["status"] == "CONTRADICTED"
    assert live["fields"]["child_recipient"]["status"] == "CONTRADICTED"
    assert live["status"] == "CONTRADICTED"


def test_mismatched_status_is_contradicted():
    archive = load_archive()
    live = live_observations(
        archive,
        _rpc(
            parent=_parent_receipt(status="PENDING", txExecutionResultName="FINISHED_WITH_ERROR"),
            child=_child_receipt(),
            source="class LocaleBounty\n",
        ),
    )
    assert live["fields"]["parent_status"]["status"] == "CONTRADICTED"
    assert live["fields"]["parent_execution"]["status"] == "CONTRADICTED"
    assert live["status"] == "CONTRADICTED"


def test_mismatched_source_hash_is_contradicted():
    archive = load_archive()
    live = live_observations(
        archive,
        _rpc(
            parent=_parent_receipt(),
            child=_child_receipt(),
            source="class LocaleBounty\n# different source\n",
        ),
    )
    assert live["fields"]["deployed_source_sha256"]["status"] == "CONTRADICTED"
    assert live["fields"]["deployed_source_sha256"]["observed"] != PIN
    assert live["status"] == "CONTRADICTED"


def test_complete_receipt_is_observed_but_not_payment_verified():
    archive = load_archive()
    source = Path(ROOT / "contracts" / "localebounty.py").read_text(encoding="utf-8")
    live = live_observations(
        archive,
        _rpc(parent=_parent_receipt(), child=_child_receipt(), source=source),
    )
    assert live["status"] == "OBSERVED"
    assert live["payment_verified"] is False
    for name in REQUIRED_LIVE_FIELDS:
        assert live["fields"][name]["status"] == "OBSERVED", name
    assert live["fields"]["deployed_source_sha256"]["observed"] == PIN
    assert CONTRACT.lower() == archive["contract"].lower()


def test_conclusions_keep_historical_yes_when_rpc_is_403():
    archive = load_archive()
    result = conclusions(archive, _rpc(http_error="HTTP 403 Forbidden"))
    assert result["archive_arithmetic"]["status"] == "PASS"
    assert result["historical_wallet_run"]["status"] == "YES"
    assert result["independent_rpc"]["status"] == "UNPROVEN"
    assert result["independent_rpc"]["payment_verified"] is False


def test_live_rpc_read_only_archived_parent_and_child():
    archive = load_archive()
    live = live_observations(archive)
    if live["status"] == "CONTRADICTED":
        pytest.fail("Independent RPC contradicted the archive: " + json.dumps(live["fields"], default=str))
    if live["status"] != "OBSERVED":
        pytest.skip(
            "UNPROVEN independent RPC replay; historical wallet-run remains "
            + historical_wallet_run(archive)["status"]
            + ". "
            + "; ".join(live["notes"])
        )
    assert live["payment_verified"] is False
    for name in REQUIRED_LIVE_FIELDS:
        assert live["fields"][name]["status"] == "OBSERVED"


def test_archive_file_is_not_rewritten_by_this_suite():
    path = ROOT / "docs" / "evidence" / "2026-10-01-public-ui-decision-copy-evidence.json"
    before = path.read_bytes()
    archive = json.loads(before)
    clone = copy.deepcopy(archive)
    clone["live_result"] = "NO"
    assert snapshot_checks(archive) == []
    assert path.read_bytes() == before
