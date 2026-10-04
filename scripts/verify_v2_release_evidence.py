"""Offline consistency check for the exact V2 signing-browser evidence archive.

This checks the saved browser record and local contract bytes. It does not replay
Studio-dev RPC and must not be described as independent on-chain payment proof.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "docs/evidence/2026-10-03-v2-approved-decision-copy-evidence.json"
CONTRACT = ROOT / "contracts/localebounty_v2.py"
ARCHIVE_SHA256 = "ea2d071fb84dc3363ce93fa3f31caa926ee822b74acefaca42b76de3b39d2fbc"
SOURCE_SHA256 = "3cbb7ff08dca3909b9765ce0467e7ddc8c6ec0d7c104e142c892cfafd169a43d"
CONTRACT_ADDRESS = "0x3b06e08182db177a61b1707f7b5a84834a45f431"
TASK_ID = "7e1974679cc5f3423573e8cf52b2446ed2a3de6bf4ad5415054f8532bf2c6352"


def require(condition: bool, description: str) -> None:
    if not condition:
        raise ValueError(description)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    require(sha256(ARCHIVE) == ARCHIVE_SHA256, "Evidence archive SHA-256 changed")
    require(sha256(CONTRACT) == SOURCE_SHA256, "Local V2 source SHA-256 changed")
    evidence = json.loads(ARCHIVE.read_text(encoding="utf-8"))

    require(evidence["kind"] == "localebounty.product-ui-v2.decision-evidence.v1", "Wrong evidence kind")
    require(evidence["network"]["chainIdExpected"] == 61997, "Wrong chain")
    require(evidence["network"]["chainIdWallet"] == 61997, "Wallet chain mismatch")
    require(evidence["contract"].lower() == CONTRACT_ADDRESS, "Wrong contract")
    require(evidence["sourceSha256Pin"].lower() == SOURCE_SHA256, "Wrong source pin")
    require(evidence["taskId"] == TASK_ID, "Wrong task")

    writes = [evidence[f"{action}Tx"] for action in ("create", "accept", "submit", "evaluate")]
    tx_ids = [item["txId"].lower() for item in writes]
    require(len(set(tx_ids)) == 4, "Duplicate write hashes")
    require(all(item["statusName"] == "FINALIZED" and item["executionName"] == "FINISHED_WITH_RETURN" and item["parentSuccessful"] is True for item in writes), "One write lacks finalized successful execution")
    require(evidence["createTx"]["expectedTaskId"] == TASK_ID, "Create/task correlation mismatch")
    require(evidence["createTx"]["boundRewardWei"] == evidence["rewardWei"], "Bound reward mismatch")
    require(evidence["createTx"]["boundFunder"].lower() == evidence["funder"].lower(), "Bound funder mismatch")
    require(evidence["createTx"]["boundTranslator"].lower() == evidence["translator"].lower(), "Bound translator mismatch")
    require(evidence["acceptTx"]["wallet"].lower() == evidence["translator"].lower(), "Accept signer mismatch")
    require(evidence["submitTx"]["wallet"].lower() == evidence["translator"].lower(), "Submit signer mismatch")
    require(evidence["evaluateTx"]["wallet"].lower() == evidence["evaluator"].lower(), "Evaluate signer mismatch")

    parent = evidence["finalizedParentReceipt"]
    require(evidence["evaluateTx"]["txId"].lower() == evidence["parentTxId"].lower() == parent["hash"].lower(), "Evaluate parent hash mismatch")
    require(parent["statusName"] == "FINALIZED" and parent["txExecutionResultName"] == "FINISHED_WITH_RETURN", "Parent receipt unsuccessful")
    require(parent["from_address"].lower() == evidence["evaluator"].lower(), "Parent caller mismatch")
    require(parent["to_address"].lower() == CONTRACT_ADDRESS, "Parent recipient mismatch")
    reward = int(evidence["rewardWei"])
    fee = int(evidence["actualReceiptFeeWei"])
    require(evidence["actualReceiptFeeSource"] == "primary_fee_spent", "Fee source mismatch")
    require(int(parent["data"]["fee_accounting"]["primary_fee_spent"]) == fee, "Receipt fee mismatch")
    require(int(evidence["quotedFeeDepositWei"]) == int(parent["data"]["fee_value"]), "Quoted deposit mismatch")

    outgoing = evidence["exactOutgoing"]
    require(outgoing["isEthSend"] is True and outgoing["recipient"].lower() == evidence["translator"].lower() and int(outgoing["valueWei"]) == reward, "Outgoing EthSend mismatch")
    require(any(message["recipient"].lower() == evidence["translator"].lower() and int(message["value"]) == reward for message in parent["messages"]), "Parent message mismatch")
    child = evidence["matchingChildCredit"]
    require(child["found"] is True and child["valueCredited"] is True, "Child not credited")
    require(child["txId"].lower() == evidence["childTxId"].lower(), "Child hash mismatch")
    require(child["triggeredBy"].lower() == evidence["parentTxId"].lower(), "Child parent mismatch")
    require(child["to"].lower() == evidence["translator"].lower() and int(child["valueWei"]) == reward, "Child delivery mismatch")

    before, after = evidence["beforeSnapshot"], evidence["afterSnapshot"]
    for snapshot in (before, after):
        require(snapshot["contract"].lower() == CONTRACT_ADDRESS, "Snapshot contract mismatch")
        require(snapshot["funder"].lower() == evidence["funder"].lower(), "Snapshot funder mismatch")
        require(snapshot["named"].lower() == evidence["translator"].lower(), "Snapshot translator mismatch")
    require(int(after["namedWei"]) - int(before["namedWei"]) == reward, "Translator balance delta mismatch")
    require(int(after["funderWei"]) - int(before["funderWei"]) == -fee, "Funder fee delta mismatch")
    require(int(evidence["translatorDeltaWei"]) == reward and int(evidence["funderDeltaWei"]) == -fee, "Reported deltas mismatch")
    require(evidence["libraryCountBefore"] == 0 and evidence["libraryCountAfter"] == 1, "Library count mismatch")
    library = evidence["libraryEntry"]
    require(evidence["libraryEntryLinkedToTask"] is True and library["task_id"] == TASK_ID, "Library task mismatch")
    require(library["translation"] == evidence["translation"] and library["string_key"] == evidence["string_key"], "Library content mismatch")
    require(evidence["state"] == evidence["decision"] == "approved" and evidence["verdict"] == evidence["live_result"] == "YES", "Decision/verdict mismatch")

    print(json.dumps({
        "archive_consistency": "PASS",
        "archive_sha256": ARCHIVE_SHA256,
        "local_source_sha256": SOURCE_SHA256,
        "historical_signing_browser_verdict": "YES",
        "independent_live_rpc_replay": "UNPROVEN (not performed by this offline check)",
        "create_tx": tx_ids[0],
        "accept_tx": tx_ids[1],
        "submit_tx": tx_ids[2],
        "evaluate_tx": tx_ids[3],
        "child_tx": evidence["childTxId"],
    }, indent=2))


if __name__ == "__main__":
    main()
