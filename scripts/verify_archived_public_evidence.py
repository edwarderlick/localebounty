#!/usr/bin/env python3
"""Read-only check of archived public Studio-dev Decision evidence.

Three distinct conclusions:

1. archived JSON arithmetic is internally consistent
2. historical wallet-run evidence reports YES / NO / UNPROVEN / MISSING
3. independent live RPC replay is OBSERVED, UNPROVEN, or CONTRADICTED

HTTP 403 (or any unavailable RPC) makes independent replay UNPROVEN. It does not
erase conclusion 2. A transaction hash existing is not payment verification.
"""

from __future__ import annotations

import hashlib
import json
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "docs" / "evidence" / "2026-10-01-public-ui-decision-copy-evidence.json"
CONTRACT_PATH = ROOT / "contracts" / "localebounty.py"
RPC = "https://studio-dev.genlayer.com/api"
PINNED_SHA = "6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f"
CONTRACT = "0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96"

RpcCall = Callable[[str, list[Any]], Any]

REQUIRED_LIVE_FIELDS = (
    "deployed_source_sha256",
    "parent_status",
    "parent_execution",
    "outgoing_ethsend_recipient",
    "outgoing_ethsend_value",
    "child_triggered_by",
    "child_value_credited",
    "child_recipient",
    "child_value",
    "receipt_fee",
)


def _int(value: Any) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, bool):
        raise ValueError(f"not an integer: {value!r}")
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    raise ValueError(f"not an integer: {value!r}")


def _hex_int(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text.lstrip("-").isdigit():
            return int(text)
        if text.lower().startswith("0x"):
            try:
                return int(text, 16)
            except ValueError:
                return None
    return None


def load_archive() -> dict[str, Any]:
    return json.loads(ARCHIVE.read_text(encoding="utf-8"))


def local_source_sha256() -> str:
    return hashlib.sha256(CONTRACT_PATH.read_bytes()).hexdigest()


def snapshot_checks(archive: dict[str, Any]) -> list[str]:
    """Internal consistency of the archived JSON. Not live payment proof."""
    errors: list[str] = []
    reward = _int(archive["rewardWei"])
    fee = _int(archive["actualReceiptFeeWei"])
    named = _int(archive["namedDeltaWei"])
    funder = _int(archive["funderDeltaWei"])
    expected_net = reward - fee
    if named != expected_net:
        errors.append(f"namedDeltaWei {named} != reward-fee {expected_net}")
    if funder != 0:
        errors.append(f"funderDeltaWei {funder} != 0 for evaluator=translator archive")
    before = archive["beforeSnapshot"]
    after = archive["afterSnapshot"]
    observed = _int(after["namedWei"]) - _int(before["namedWei"])
    if observed != named:
        errors.append(f"snapshot named delta {observed} != namedDeltaWei {named}")
    observed_funder = _int(after["funderWei"]) - _int(before["funderWei"])
    if observed_funder != funder:
        errors.append(f"snapshot funder delta {observed_funder} != funderDeltaWei {funder}")
    parent = str(archive["parentTxId"]).lower()
    child = str(archive["childTxId"]).lower()
    if parent == child:
        errors.append("parentTxId equals childTxId")
    if archive["outgoingValueWei"] != archive["rewardWei"]:
        errors.append("outgoing EthSend value is not exact reward")
    if archive["outgoingRecipient"].lower() != archive["translator"].lower():
        errors.append("outgoing recipient is not translator")
    if archive["sourceSha256Pin"] != PINNED_SHA:
        errors.append("archive sourceSha256Pin does not match deployed pin")
    local = local_source_sha256()
    if local != PINNED_SHA:
        errors.append(f"local contracts/localebounty.py sha256 {local} != pin {PINNED_SHA}")
    if archive["contract"].lower() != CONTRACT.lower():
        errors.append("archive contract address mismatch")
    credit = str(archive.get("childCredit", "")).lower()
    if parent not in credit:
        errors.append("childCredit does not cite parent tx as triggered_by")
    if "value_credited true" not in credit:
        errors.append("childCredit does not record value_credited true")
    return errors


def historical_wallet_run(archive: dict[str, Any]) -> dict[str, Any]:
    raw = archive.get("live_result")
    status = raw if raw in ("YES", "NO", "UNPROVEN") else "MISSING"
    return {
        "status": status,
        "note": (
            "Archive live_result is the historical wallet-run label from the signing browser. "
            "Independent RPC replay is a separate conclusion. This label is not erased by HTTP 403."
        ),
        "parentTxId": archive.get("parentTxId"),
        "childTxId": archive.get("childTxId"),
        "verdict": archive.get("verdict"),
    }


def default_rpc(method: str, params: list[Any], timeout: float = 20.0) -> Any:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"HTTP {err.code} {err.reason} for {method}") from err
    if payload.get("error"):
        raise RuntimeError(str(payload["error"]))
    return payload.get("result")


def _as_record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _lower(value: Any) -> str:
    return str(value).strip().lower() if value is not None else ""


def _pick(record: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in record and record[key] is not None:
            return record[key]
    return None


def extract_python_source(result: Any) -> str | None:
    if isinstance(result, str) and result:
        if "class LocaleBounty" in result or "py-genlayer:" in result:
            return result
        trimmed = result.strip()
        if not trimmed:
            return None
        try:
            import base64

            decoded = base64.b64decode(trimmed).decode("utf-8", errors="ignore")
            if "class LocaleBounty" in decoded or "class " in decoded:
                return decoded
        except Exception:
            return None
        return None
    if isinstance(result, list):
        for item in result:
            found = extract_python_source(item)
            if found:
                return found
        return None
    if isinstance(result, dict):
        for key in ("code", "source", "contract_code", "contractCode", "data", "result"):
            if key in result:
                found = extract_python_source(result[key])
                if found:
                    return found
    return None


def _status_name(tx: dict[str, Any]) -> str | None:
    raw = _pick(tx, "status", "statusName", "txStatus", "consensus_status")
    if raw is None:
        return None
    return str(raw).upper()


def _execution_name(tx: dict[str, Any]) -> str | None:
    raw = _pick(tx, "txExecutionResultName", "executionName", "execution", "result_name")
    if raw is None:
        nested = tx.get("consensus_data")
        if isinstance(nested, dict):
            leader = nested.get("leader_receipt")
            if isinstance(leader, dict):
                raw = _pick(leader, "execution_result", "executionResult", "result")
    if raw is None:
        return None
    text = str(raw)
    if "FINISHED_WITH_RETURN" in text.upper().replace(" ", "_"):
        return "FINISHED_WITH_RETURN"
    return text


def _messages(tx: dict[str, Any]) -> list[dict[str, Any]]:
    raw = tx.get("messages")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _outgoing_ethsend(tx: dict[str, Any]) -> tuple[str | None, int | None]:
    for message in _messages(tx):
        message_type = message.get("messageType") or message.get("message_type")
        is_send = message.get("is_eth_send") is True or message.get("isEthSend") is True or str(message_type) == "0"
        if not is_send:
            continue
        recipient = _pick(message, "recipient", "to", "address")
        value = _hex_int(_pick(message, "value_wei", "valueWei", "value"))
        return (str(recipient) if recipient else None, value)
    return (None, None)


def _receipt_fee(tx: dict[str, Any]) -> int | None:
    accounting = tx.get("feeAccounting") or tx.get("fee_accounting") or {}
    pool = {**tx, **(_as_record(accounting))}
    spent = _hex_int(_pick(pool, "primary_fee_spent", "primaryFeeSpent"))
    if spent is not None:
        return spent
    required = _hex_int(_pick(pool, "primary_fee_required", "primaryFeeRequired"))
    refunded = _hex_int(_pick(pool, "primary_fee_refunded", "primaryFeeRefunded"))
    if required is not None and refunded is not None and required >= refunded:
        return required - refunded
    return None


def _fetch_tx(rpc_call: RpcCall, tx_id: str) -> tuple[dict[str, Any] | None, str | None]:
    errors: list[str] = []
    for method in ("gen_getTransaction", "eth_getTransactionByHash"):
        try:
            result = rpc_call(method, [tx_id])
        except Exception as err:  # noqa: BLE001 — callers need the exact RPC failure
            errors.append(f"{method}: {err}")
            continue
        if result is None:
            errors.append(f"{method}: null result")
            continue
        if isinstance(result, dict):
            return result, None
        errors.append(f"{method}: non-object result")
    return None, "; ".join(errors) if errors else "no transaction method succeeded"


def _field(status: str, observed: Any = None, expected: Any = None, note: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {"status": status, "observed": observed, "expected": expected}
    if note:
        out["note"] = note
    return out


def live_observations(archive: dict[str, Any], rpc_call: RpcCall | None = None) -> dict[str, Any]:
    """Independent public RPC replay. Hash presence is not payment verification."""
    call = rpc_call or default_rpc
    fields: dict[str, dict[str, Any]] = {
        name: _field("UNPROVEN", note="not fetched yet") for name in REQUIRED_LIVE_FIELDS
    }
    notes: list[str] = [
        "Independent RPC replay. Hash presence is not payment verification.",
        "Historical wallet-run YES is a separate conclusion.",
    ]
    out: dict[str, Any] = {
        "status": "UNPROVEN",
        "rpc": RPC,
        "payment_verified": False,
        "fields": fields,
        "notes": notes,
        "parent": None,
        "child": None,
        "source": None,
    }

    parent_id = str(archive["parentTxId"])
    child_id = str(archive["childTxId"])
    reward = _int(archive["rewardWei"])
    expected_recipient = str(archive["outgoingRecipient"])
    expected_fee = _int(archive["actualReceiptFeeWei"])
    expected_sha = str(archive["sourceSha256Pin"])

    try:
        code = call("gen_getContractCode", [archive["contract"]])
        source = extract_python_source(code)
        if not source:
            fields["deployed_source_sha256"] = _field(
                "UNPROVEN",
                note="gen_getContractCode did not return hashable LocaleBounty source",
            )
        else:
            sha = hashlib.sha256(source.encode("utf-8")).hexdigest()
            out["source"] = {"sha256": sha}
            if sha.lower() == expected_sha.lower():
                fields["deployed_source_sha256"] = _field("OBSERVED", sha, expected_sha)
            else:
                fields["deployed_source_sha256"] = _field("CONTRADICTED", sha, expected_sha)
    except Exception as err:  # noqa: BLE001
        fields["deployed_source_sha256"] = _field("UNPROVEN", note=str(err))

    parent, parent_err = _fetch_tx(call, parent_id)
    child, child_err = _fetch_tx(call, child_id)
    out["parent"] = {"present": parent is not None, "error": parent_err}
    out["child"] = {"present": child is not None, "error": child_err}

    if parent is None:
        for name in (
            "parent_status",
            "parent_execution",
            "outgoing_ethsend_recipient",
            "outgoing_ethsend_value",
            "receipt_fee",
        ):
            fields[name] = _field("UNPROVEN", note=parent_err or "parent tx unavailable")
    else:
        parent_hash = _lower(_pick(parent, "hash", "tx_id", "txId"))
        if parent_hash and parent_hash != parent_id.lower():
            notes.append("Live parent hash does not match archive parentTxId.")
        status = _status_name(parent)
        execution = _execution_name(parent)
        if status is None:
            fields["parent_status"] = _field("UNPROVEN", note="status field missing on parent receipt")
        elif status == "FINALIZED":
            fields["parent_status"] = _field("OBSERVED", status, "FINALIZED")
        else:
            fields["parent_status"] = _field("CONTRADICTED", status, "FINALIZED")
        if execution is None:
            fields["parent_execution"] = _field(
                "UNPROVEN",
                note="execution result missing; hash presence is not FINISHED_WITH_RETURN",
            )
        elif execution == "FINISHED_WITH_RETURN":
            fields["parent_execution"] = _field("OBSERVED", execution, "FINISHED_WITH_RETURN")
        else:
            fields["parent_execution"] = _field("CONTRADICTED", execution, "FINISHED_WITH_RETURN")
        recipient, value = _outgoing_ethsend(parent)
        if recipient is None:
            fields["outgoing_ethsend_recipient"] = _field(
                "UNPROVEN",
                note="parent messages had no EthSend recipient",
            )
        elif recipient.lower() == expected_recipient.lower():
            fields["outgoing_ethsend_recipient"] = _field("OBSERVED", recipient, expected_recipient)
        else:
            fields["outgoing_ethsend_recipient"] = _field("CONTRADICTED", recipient, expected_recipient)
        if value is None:
            fields["outgoing_ethsend_value"] = _field("UNPROVEN", note="parent EthSend value missing")
        elif value == reward:
            fields["outgoing_ethsend_value"] = _field("OBSERVED", value, reward)
        else:
            fields["outgoing_ethsend_value"] = _field("CONTRADICTED", value, reward)
        fee = _receipt_fee(parent)
        if fee is None:
            fields["receipt_fee"] = _field("UNPROVEN", note="primary_fee_spent (or required−refunded) missing")
        elif fee == expected_fee:
            fields["receipt_fee"] = _field("OBSERVED", fee, expected_fee)
        else:
            fields["receipt_fee"] = _field("CONTRADICTED", fee, expected_fee)

    if child is None:
        for name in ("child_triggered_by", "child_value_credited", "child_recipient", "child_value"):
            fields[name] = _field("UNPROVEN", note=child_err or "child tx unavailable")
    else:
        triggered = _pick(child, "triggered_by", "triggeredBy")
        if triggered is None:
            fields["child_triggered_by"] = _field("UNPROVEN", note="triggered_by missing on child")
        elif _lower(triggered) == parent_id.lower():
            fields["child_triggered_by"] = _field("OBSERVED", triggered, parent_id)
        else:
            fields["child_triggered_by"] = _field("CONTRADICTED", triggered, parent_id)
        credited = _pick(child, "value_credited", "valueCredited")
        if credited is None:
            fields["child_value_credited"] = _field(
                "UNPROVEN",
                note="value_credited missing; hash presence is not child credit",
            )
        elif credited is True:
            fields["child_value_credited"] = _field("OBSERVED", True, True)
        else:
            fields["child_value_credited"] = _field("CONTRADICTED", credited, True)
        child_to = _pick(child, "to", "to_address", "recipient")
        if child_to is None:
            fields["child_recipient"] = _field("UNPROVEN", note="child recipient missing")
        elif _lower(child_to) == expected_recipient.lower():
            fields["child_recipient"] = _field("OBSERVED", child_to, expected_recipient)
        else:
            fields["child_recipient"] = _field("CONTRADICTED", child_to, expected_recipient)
        child_value = _hex_int(_pick(child, "value", "value_wei", "valueWei"))
        if child_value is None:
            fields["child_value"] = _field("UNPROVEN", note="child value missing")
        elif child_value == reward:
            fields["child_value"] = _field("OBSERVED", child_value, reward)
        else:
            fields["child_value"] = _field("CONTRADICTED", child_value, reward)

    statuses = [fields[name]["status"] for name in REQUIRED_LIVE_FIELDS]
    if any(status == "CONTRADICTED" for status in statuses):
        out["status"] = "CONTRADICTED"
        notes.append("One or more independently observed fields contradict the archive.")
    elif all(status == "OBSERVED" for status in statuses):
        out["status"] = "OBSERVED"
        notes.append(
            "Independent RPC observed source SHA, parent FINALIZED + FINISHED_WITH_RETURN, "
            "outgoing EthSend, child credit fields, and receipt fee. "
            "This is not a new wallet-run payment proof and does not label the tx payment verified."
        )
    else:
        missing = [name for name in REQUIRED_LIVE_FIELDS if fields[name]["status"] == "UNPROVEN"]
        notes.append("UNPROVEN fields: " + ", ".join(missing))
        out["status"] = "UNPROVEN"
    out["fields"] = fields
    out["notes"] = notes
    return out


def conclusions(archive: dict[str, Any], rpc_call: RpcCall | None = None) -> dict[str, Any]:
    arithmetic_errors = snapshot_checks(archive)
    return {
        "archive_arithmetic": {
            "status": "FAIL" if arithmetic_errors else "PASS",
            "errors": arithmetic_errors,
        },
        "historical_wallet_run": historical_wallet_run(archive),
        "independent_rpc": live_observations(archive, rpc_call),
    }


def main() -> int:
    archive = load_archive()
    result = conclusions(archive)
    print("=== 1. archived JSON arithmetic ===")
    print(f"archive: {ARCHIVE}")
    print(f"taskId: {archive.get('taskId')}")
    print(f"status: {result['archive_arithmetic']['status']}")
    if result["archive_arithmetic"]["errors"]:
        for item in result["archive_arithmetic"]["errors"]:
            print(f"FAIL {item}")
        return 1
    print("PASS snapshot consistency")
    print("=== 2. historical wallet-run evidence ===")
    hist = result["historical_wallet_run"]
    print(f"status: {hist['status']}")
    print(hist["note"])
    print(f"parentTxId: {hist['parentTxId']}")
    print(f"childTxId: {hist['childTxId']}")
    print("=== 3. independent live RPC replay ===")
    live = result["independent_rpc"]
    print(f"live_status: {live['status']}")
    print(f"payment_verified: {live['payment_verified']}")
    for name in REQUIRED_LIVE_FIELDS:
        field = live["fields"][name]
        extra = field.get("note") or field.get("observed")
        print(f"  {name}: {field['status']}" + (f" ({extra})" if extra is not None else ""))
    for note in live["notes"]:
        print(note)
    if live["status"] == "CONTRADICTED":
        print("CONTRADICTED independent RPC")
        return 3
    if live["status"] != "OBSERVED":
        print("UNPROVEN independent RPC")
        return 2
    print("PASS independent RPC observed required receipt fields")
    return 0


if __name__ == "__main__":
    sys.exit(main())
