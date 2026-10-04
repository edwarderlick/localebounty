#!/usr/bin/env python3
"""Studio-dev integration probe for ExperimentalSettlementProbe (EOA path).

Does not prompt for a private key. If no authorized funded signer is already
available, prints the limit and exits 2 (UNPROVEN).

Exit 0 requires **wallet settlement evidence** for BOTH release and refund.
Parent transaction ``is_successful`` alone is not enough.

Fee path (genlayer-py 0.19 RC, verified in this install):

    estimate = client.estimate_transaction_fees_for_write(...)
    client.write_contract(..., fees={
        "distribution": estimate["distribution"],
        "feeValue": estimate["feeValue"],
        # plus messageAllocations when the SDK returns it
    })

After parent finalization, poll EOA balances for a bounded time so a
finalized external ``EthSend`` can land. Protocol fees are tracked
separately from the locked GEN amount.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from eth_account.signers.local import LocalAccount
from genlayer_py import create_account, create_client
from genlayer_py.chains import studio_devnet
from genlayer_py.transactions import is_successful

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "contracts" / "experimental" / "settlement_probe.py"
STUDIO_DEV_CHAIN_ID = 61997
STUDIO_DEV_RPC = "https://studio-dev.genlayer.com/api"
LOCK_WEI = 10**15  # 0.001 GEN
EXTERNAL_WAIT_SECONDS = 90
EXTERNAL_POLL_SECONDS = 3
KEY_ENV_VARS = (
    "SETTLEMENT_PROBE_PRIVATE_KEY",
    "GENLAYER_PRIVATE_KEY",
    "ACCOUNT_PRIVATE_KEY_1",
)


def _load_signer() -> LocalAccount | None:
    for name in KEY_ENV_VARS:
        raw = os.environ.get(name, "").strip()
        if raw:
            return create_account(raw)
    return None


def _addr(account: LocalAccount) -> str:
    return account.address


def _balance(client, address: str) -> int:
    return int(client.w3.eth.get_balance(client.w3.to_checksum_address(address)))


def _balances(client, funder: str, named: str, contract: str) -> dict:
    return {
        "funder": _balance(client, funder),
        "named": _balance(client, named),
        "contract": _balance(client, contract),
        "unix_ms": int(time.time() * 1000),
    }


def _summarize_receipt(receipt: dict) -> dict:
    lifecycle = receipt.get("lifecycle") or {}
    return {
        "status": receipt.get("status_name", receipt.get("status")),
        "lifecycle_state": lifecycle.get("state"),
        "lifecycle_outcome": lifecycle.get("outcome"),
        "tx_execution_result": receipt.get("tx_execution_result"),
        "tx_execution_result_name": receipt.get("tx_execution_result_name"),
        "is_successful": bool(is_successful(receipt)),
        "contract_address": (receipt.get("tx_data_decoded") or {}).get(
            "contract_address"
        )
        or (receipt.get("data") or {}).get("contract_address"),
    }


def _fees_from_estimate(estimate: dict) -> dict:
    fees = {
        "distribution": estimate["distribution"],
        "feeValue": estimate["feeValue"],
    }
    if estimate.get("messageAllocations") is not None:
        fees["messageAllocations"] = estimate["messageAllocations"]
    return fees


def _wait_parent(client, tx_id):
    return client.wait_for_finalization(
        tx_id,
        interval=3000,
        retries=80,
        full_transaction=True,
    )


def _write(client, address, function_name, args, value=0):
    estimate = client.estimate_transaction_fees_for_write(
        address=address,
        function_name=function_name,
        args=args,
        value=value,
    )
    fees = _fees_from_estimate(estimate)
    tx_id = client.write_contract(
        address=address,
        function_name=function_name,
        args=args,
        value=value,
        fees=fees,
    )
    receipt = _wait_parent(client, tx_id)
    return {
        "tx_id": tx_id.hex() if hasattr(tx_id, "hex") else str(tx_id),
        "estimate_fee_value": int(estimate["feeValue"]),
        "submitted_fee_value": int(fees["feeValue"]),
        "submitted_distribution": fees["distribution"],
        "receipt": _summarize_receipt(receipt),
        "parent_successful": bool(is_successful(receipt)),
    }


def _deploy(client, code: str):
    estimate = client.estimate_transaction_fees(
        {
            "leaderTimeunitsAllocation": 125,
            "validatorTimeunitsAllocation": 250,
            "executionBudgetPerRound": 786_500,
            "totalMessageFees": 0,
            "appealRounds": 1,
            "rotations": [1, 1],
        }
    )
    fees = _fees_from_estimate(estimate)
    tx_id = client.deploy_contract(code=code, args=[], fees=fees)
    receipt = _wait_parent(client, tx_id)
    summary = _summarize_receipt(receipt)
    if not summary["contract_address"]:
        raise RuntimeError(f"deploy receipt missing contract address: {summary}")
    return {
        "tx_id": tx_id.hex() if hasattr(tx_id, "hex") else str(tx_id),
        "estimate_fee_value": int(estimate["feeValue"]),
        "submitted_fee_value": int(fees["feeValue"]),
        "submitted_distribution": fees["distribution"],
        "receipt": summary,
        "contract_address": summary["contract_address"],
        "parent_successful": bool(is_successful(receipt)),
    }


def _read(client, address, function_name, args=None):
    return client.read_contract(
        address=address,
        function_name=function_name,
        args=args or [],
    )


def _wait_external_effect(client, funder, named, contract, kind, before, fee_value):
    """Poll EOA balances after parent finalization.

    Release: named wallet must gain exactly LOCK_WEI.
    Refund: funder delta must equal LOCK_WEI minus a protocol fee in
    ``[0, submitted_fee_value]``. Named must not gain the lock.
    """
    deadline = time.time() + EXTERNAL_WAIT_SECONDS
    samples = []
    last = _balances(client, funder, named, contract)
    samples.append(last)
    while True:
        if kind == "release":
            if last["named"] - before["named"] == LOCK_WEI:
                return last, samples, True
        else:
            funder_delta = last["funder"] - before["funder"]
            implied_fee = LOCK_WEI - funder_delta
            named_gain = last["named"] - before["named"]
            if named_gain == 0 and 0 <= implied_fee <= fee_value:
                return last, samples, True
        if time.time() >= deadline:
            return last, samples, False
        time.sleep(EXTERNAL_POLL_SECONDS)
        last = _balances(client, funder, named, contract)
        samples.append(last)


def _release_evidence(before, after) -> dict:
    named_gain = after["named"] - before["named"]
    funder_delta = after["funder"] - before["funder"]
    contract_delta = after["contract"] - before["contract"]
    passed = named_gain == LOCK_WEI
    return {
        "passed": passed,
        "named_gain_wei": named_gain,
        "expected_named_gain_wei": LOCK_WEI,
        "funder_delta_wei": funder_delta,
        "contract_delta_wei": contract_delta,
        "protocol_fee_separated": True,
        "note": (
            "Named EOA must gain exactly the locked GEN. Funder delta is "
            "protocol fees for the payout write, not the lock."
        ),
    }


def _refund_evidence(before, after, fee_value) -> dict:
    named_gain = after["named"] - before["named"]
    funder_delta = after["funder"] - before["funder"]
    implied_fee = LOCK_WEI - funder_delta
    contract_delta = after["contract"] - before["contract"]
    passed = named_gain == 0 and 0 <= implied_fee <= fee_value
    return {
        "passed": passed,
        "named_gain_wei": named_gain,
        "funder_delta_wei": funder_delta,
        "locked_gen_wei": LOCK_WEI,
        "implied_protocol_fee_wei": implied_fee,
        "submitted_fee_value_wei": fee_value,
        "contract_delta_wei": contract_delta,
        "protocol_fee_separated": True,
        "note": (
            "Funder EOA delta must equal locked GEN minus a protocol fee "
            "between 0 and the submitted feeValue. Named must not be credited."
        ),
    }


def run_outcome(client, funder: LocalAccount, named: LocalAccount, kind: str) -> dict:
    funder_addr = _addr(funder)
    named_addr = _addr(named)
    code = CONTRACT_PATH.read_text(encoding="utf-8")

    before_deploy = {
        "funder": _balance(client, funder_addr),
        "named": _balance(client, named_addr),
        "contract": None,
        "unix_ms": int(time.time() * 1000),
    }
    deploy = _deploy(client, code)
    contract = deploy["contract_address"]
    after_deploy = _balances(client, funder_addr, named_addr, contract)

    before_lock = _balances(client, funder_addr, named_addr, contract)
    lock = _write(
        client,
        contract,
        "lock",
        args=[named_addr],
        value=LOCK_WEI,
    )
    after_lock = _balances(client, funder_addr, named_addr, contract)
    lock_funder_drop = before_lock["funder"] - after_lock["funder"]
    lock_implied_fee = lock_funder_drop - LOCK_WEI

    method = (
        "release_to_named_wallet" if kind == "release" else "refund_to_funder"
    )
    before_payout = _balances(client, funder_addr, named_addr, contract)
    payout = _write(client, contract, method, args=[])
    after_parent = _balances(client, funder_addr, named_addr, contract)
    after_external, external_samples, external_landed = _wait_external_effect(
        client,
        funder_addr,
        named_addr,
        contract,
        kind,
        before_payout,
        int(payout["submitted_fee_value"]),
    )

    if kind == "release":
        evidence = _release_evidence(before_payout, after_external)
    else:
        evidence = _refund_evidence(
            before_payout,
            after_external,
            int(payout["submitted_fee_value"]),
        )
    evidence["external_effect_observed_within_wait"] = external_landed
    evidence["parent_successful"] = bool(payout["parent_successful"])
    # Parent success is recorded but is not sufficient.
    evidence["passed"] = bool(evidence["passed"] and external_landed)

    snapshot = None
    try:
        snapshot = _read(client, contract, "get_snapshot")
    except Exception as exc:  # noqa: BLE001
        snapshot = {"read_error": str(exc)}

    return {
        "kind": kind,
        "contract_address": contract,
        "deploy": deploy,
        "lock": lock,
        "payout": payout,
        "stages": {
            "before_deploy": before_deploy,
            "after_deploy": after_deploy,
            "before_lock": before_lock,
            "after_lock": after_lock,
            "before_payout": before_payout,
            "after_parent_finalized": after_parent,
            "after_external_wait": after_external,
        },
        "lock_accounting": {
            "locked_gen_wei": LOCK_WEI,
            "funder_drop_wei": lock_funder_drop,
            "implied_protocol_fee_wei": lock_implied_fee,
            "submitted_fee_value_wei": int(lock["submitted_fee_value"]),
            "contract_gain_wei": after_lock["contract"] - before_lock["contract"],
        },
        "external_wait_seconds": EXTERNAL_WAIT_SECONDS,
        "external_balance_samples": external_samples,
        "settlement_evidence": evidence,
        "snapshot": snapshot,
    }


def _outcome_settled(outcome: dict) -> bool:
    evidence = outcome.get("settlement_evidence") or {}
    return bool(
        evidence.get("passed")
        and outcome.get("payout", {}).get("parent_successful")
        and outcome.get("payout", {}).get("tx_id")
    )


def main() -> int:
    report: dict = {
        "network": {
            "name": studio_devnet.name,
            "chain_id_expected": STUDIO_DEV_CHAIN_ID,
            "chain_id_sdk": studio_devnet.id,
            "rpc_expected": STUDIO_DEV_RPC,
            "rpc_sdk": studio_devnet.rpc_urls["default"]["http"][0],
        },
        "lock_wei": LOCK_WEI,
        "payout_path": "eoa_external_eth_send",
        "payout_api": "gl.evm.contract_interface.emit_transfer",
        "signer_available": False,
        "live_run": False,
        "limit": None,
        "outcomes": [],
        "exit_0_requires": (
            "Both release and refund must show parent is_successful AND "
            "verified EOA wallet balance changes equal to the locked GEN "
            "(refund after subtracting a protocol fee in [0, feeValue])."
        ),
    }

    if studio_devnet.id != STUDIO_DEV_CHAIN_ID:
        report["limit"] = (
            f"SDK studio_devnet id is {studio_devnet.id}, expected {STUDIO_DEV_CHAIN_ID}"
        )
        print(json.dumps(report, indent=2, default=str))
        return 1

    signer = _load_signer()
    if signer is None:
        report["limit"] = (
            "No authorized funded signer is available in this environment. "
            "Looked for SETTLEMENT_PROBE_PRIVATE_KEY, GENLAYER_PRIVATE_KEY, "
            "and ACCOUNT_PRIVATE_KEY_1. Did not prompt for a private key. "
            "Live Studio-dev settlement is UNPROVEN. This script is ready: "
            "set one of those env vars to a Studio-dev funded key and rerun "
            "`python scripts/studio_dev_settlement_probe.py`."
        )
        print(json.dumps(report, indent=2, default=str))
        return 2

    report["signer_available"] = True
    client = create_client(chain=studio_devnet, account=signer)
    named = create_account()
    funder_balance = _balance(client, _addr(signer))
    report["funder_address"] = _addr(signer)
    report["named_wallet_address"] = _addr(named)
    report["funder_balance_before"] = funder_balance

    if funder_balance < 4 * LOCK_WEI:
        report["limit"] = (
            f"Signer {_addr(signer)} is present but balance {funder_balance} wei "
            f"is below the 4 * {LOCK_WEI} wei headroom used for this probe. "
            "Not claiming live success. Fund the account from the Studio-dev "
            "faucet and rerun."
        )
        print(json.dumps(report, indent=2, default=str))
        return 2

    report["live_run"] = True
    report["outcomes"].append(run_outcome(client, signer, named, "release"))
    report["outcomes"].append(run_outcome(client, signer, named, "refund"))
    report["funder_balance_after"] = _balance(client, _addr(signer))

    kinds = {o["kind"] for o in report["outcomes"]}
    both_kinds = kinds == {"release", "refund"}
    both_settled = both_kinds and all(_outcome_settled(o) for o in report["outcomes"])
    report["both_outcomes_settled"] = both_settled
    print(json.dumps(report, indent=2, default=str))
    return 0 if both_settled else 1


if __name__ == "__main__":
    sys.exit(main())
