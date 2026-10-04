# LocaleBounty GEN settlement probe

**Network:** GenLayer Studio-dev only (`studio_devnet`)

| Field | Value |
| --- | --- |
| Chain ID | `61997` |
| RPC | `https://studio-dev.genlayer.com/api` |
| Explorer | `https://explorer-studio-dev.genlayer.com` |

This is **not** studionet (`61999`).

## Verdict (narrow, current)

**YES** — both experimental Studio-dev **EOA** settlement paths succeeded on the corrected runner, in a funded **browser-wallet** live run (not the Python helper script).

| Path | Parent | Outgoing EthSend | Delivery |
| --- | --- | --- | --- |
| Release to named wallet | `FINALIZED` + `FINISHED_WITH_RETURN` | recipient `0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253`, value `1000000000000000` wei | child `value_credited: true`; named EOA gained **exactly** `1000000000000000` wei |
| Refund to funder | `FINALIZED` + `FINISHED_WITH_RETURN` | recipient `0x31e14df3b4f47F2428F3B78E7279691A78f70a05`, value `1000000000000000` wei | child `value_credited: true`; funder **net** gain `873695499999177` wei after payout-write `primary_fee_spent` `126304500000823` wei |

Arithmetic check: `873695499999177 + 126304500000823 = 1000000000000000`.

This YES is **only** for the experimental `ExperimentalSettlementProbe` on Studio-dev using `@gl.evm.contract_interface` / `EthSend`. It is not a product-bounty cost claim, not a GenLayer mainnet claim, and not a claim that `payout_submitted` equals paid.

## Concepts that must stay separate

| Concept | What it is | What it is not |
| --- | --- | --- |
| `payout_submitted` | Contract flag after `emit_transfer` (outgoing EthSend recorded on the parent) | Proof the EOA was credited |
| Receipt delivery | Child EOA transfer: exact recipient, exact value, `value_credited` | The parent write’s execution result |
| EOA balance evidence | Named +`10**15` wei (release); funder net of **receipt** `primary_fee_spent` (refund) | Parent `isSuccessful` alone |

Do not treat emit as settlement. Do not treat MetaMask “confirmed” as GenLayer `FINISHED_WITH_RETURN`.

## Evidence artifact

Independent Studio-dev RPC verification (deploy / lock / release / refund, messages, delivery, source hash):

[`docs/evidence/2026-09-30-studio-dev-eoa-settlement-independent-verification.json`](evidence/2026-09-30-studio-dev-eoa-settlement-independent-verification.json)

The Backend Step 2 prompt’s “COPY EVIDENCE JSON” body was the placeholder `[PASTE THE EXACT “COPY EVIDENCE” JSON HERE]`. That UI clipboard payload was **not** pasted. Missing UI-only fields (private historical `eth_getBalance` snapshots, quote bindings, session metadata) are **not invented**.

Public tx IDs were re-read from `https://studio-dev.genlayer.com/api` (`sim_getTransactionsForAddress`, `eth_getTransactionByHash`, `gen_getTransactionStatus`, `gen_getContractCode`).

## Probe source hash

| Item | Value |
| --- | --- |
| Local file | `contracts/experimental/settlement_probe.py` |
| SHA-256 | `93bd2a7539040a2625d12d7d1a942c8a6f84dd8fb9c96ef7a6b96b8b72647cff` |
| RPC | `gen_getContractCode` returns the source as base64 |
| Release instance `0xa22bF39D1EEe217D58c16CEf109d7ff13D70efe7` | decoded source SHA-256 **matches** local file |
| Refund instance `0x2765F738bD6F7536Bf9bD9855435AA6178f77C2D` | decoded source SHA-256 **matches** local file |

## Live browser-wallet transactions (verified)

Funder EOA: `0x31e14df3b4f47F2428F3B78E7279691A78f70a05`  
Named recipient EOA: `0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253`  
Lock amount: `1000000000000000` wei (`0.001 GEN`) — **probe amount only**

### Release lane

| Step | Tx ID | Status | Execution |
| --- | --- | --- | --- |
| Deploy | `0xf50b2dfb99466df6e3bdebf9f119ba805ded381f1dcd2f4eb3ab89009eb52aee` | FINALIZED | FINISHED_WITH_RETURN |
| Lock | `0x312850397acbfb344a360889a179d80f253531ad8e284fd91b9582b82d6f71af` | FINALIZED | FINISHED_WITH_RETURN |
| `release_to_named_wallet` | `0x9d7eca9fc20750c7aace2f05f3c92c9fabc392f6c3426c1a7d06f259b5942626` | FINALIZED | FINISHED_WITH_RETURN |
| Child EOA delivery | `0x4df8588228199999864fbc176e040467fa9741de57c44b727ebb798dbe3c2bbb` | FINALIZED | `value_credited: true` (not an IC vote) |

Outgoing message on the parent: `is_eth_send: true`, `on: finalized`, recipient named wallet, value `1000000000000000`.

### Refund lane

| Step | Tx ID | Status | Execution |
| --- | --- | --- | --- |
| Deploy | `0xcc500a542ef7f1c68fdbfdfd22c9159ec5dd758b308de20cc7ce6c296b9573ad` | FINALIZED | FINISHED_WITH_RETURN |
| Lock | `0x6fe9a6a2aefa6275d0b676f2aa0f30032b5e960afc3cf8cfc27b31576a991a67` | FINALIZED | FINISHED_WITH_RETURN |
| `refund_to_funder` | `0x007aac7c44a879fe2463f9d5a33f7ba8b7d71f3e3bd07eb2c4b63a886290f4a5` | FINALIZED | FINISHED_WITH_RETURN |
| Child EOA delivery | `0x421969059863be771841972a7609019532012bc4e4bf32bc8525d63d95684c39` | FINALIZED | `value_credited: true` (not an IC vote) |

Outgoing message on the parent: `is_eth_send: true`, `on: finalized`, recipient funder, value `1000000000000000`.

Payout-write `primary_fee_spent` (top-up `primaryAmount` minus refund `primary`): **`126304500000823` wei** (`0.000126304500000823` GEN). 1 GEN = `10**18` wei. Same figure on both payout parents in this run. That is **not** `0.126 GEN`. The fee quote is a deposit required upfront; unused deposit is returned.

Funder net on refund = lock − that fee = `873695499999177` wei. Historical private balance series was not re-fetched.

## Economics (do not treat the probe amount as a product bounty)

- The `0.001 GEN` lock was only large enough to prove the EthSend path.
- The **payout write** consumed `0.000126304500000823 GEN` (`126304500000823` wei) in actual protocol fee, about 12.6% of the `0.001 GEN` lock. It was not more than a hundred times the locked reward. A mistaken `0.126 GEN` figure treated `10**15` wei as 1 GEN.
- **Do not** hardcode `0.001 GEN` as a viable LocaleBounty reward.
- Rewards are funded by the task creator’s `message.value`. Protocol fees are **separate** and paid by the wallet that submits each write.
- Do not hardcode a GEN/USD quote or a percentage platform fee.

## History — this YES is not the Step 1 script result

### 1. First probe (wrong payout path, then UNPROVEN live)

The first experimental contract used `gl.get_contract_at(recipient).emit_transfer` (`PostMessage`, IC-child). Funder and named recipient are **EOAs**, so that path was incorrect.

Correct EOA path (still used):

```python
@gl.evm.contract_interface
class _EoaWallet:
    class View:
        pass
    class Write:
        pass

_EoaWallet(recipient).emit_transfer(value=amount)
```

### 2. Python live script — historical exit 2 (not this verdict)

`python .\scripts\studio_dev_settlement_probe.py` had **no authorized funded signer** in the agent environment.

- `live_run`: false
- Exit code: **2**
- No transaction IDs from that process

That exit **2** is a historical **script** result. It is **not** the verdict of the later browser-wallet run. This document does **not** claim the script exited 0.

Step 1 documentation therefore correctly said **UNPROVEN** until a funded live run existed.

### 3. Failed Studio-dev runner (browser deploys)

Pinned runner `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` with old `gl.Contract` / `from genlayer import *` style **failed** on current Studio-dev (`invalid_contract` / runner malformed), for example:

- `0xcff25696bcfbb8f0709dd11b1c07adb4e7a43f7f3c6f2144383004612c211008` → `0x261ba97DA7C5f161AD9Dcb9286571d3CF0a5EA32` — `FINALIZED` / `FINISHED_WITH_ERROR`
- `0x492b62ee858688e4d1c92935447230dfbb522321fcb267f646b53b1088e539d4` → `0x83a605DdA87e83f013BB87106747388644A45203` — `FINALIZED` / `FINISHED_WITH_ERROR`

Those receipt addresses are **not** live probe instances.

### 4. Corrected runner (this YES)

Working pin, matching the successful live deploys:

| Item | Value |
| --- | --- |
| Runner | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` |
| Class | `gl.contract.Contract` |
| Import | `import genlayer as gl` and `from genlayer import *` |

Do **not** copy syntax from the old runner.

## Transfer path (unchanged, proven live)

Official docs: [Value Transfers](https://docs.genlayer.com/developers/intelligent-contracts/features/value-transfers), [Messages](https://docs.genlayer.com/developers/intelligent-contracts/features/messages).

| Path | `gl_call` body | Use |
| --- | --- | --- |
| IC → IC | `PostMessage` | Not this probe |
| IC → EOA | `EthSend` `{address, calldata: b'', value}` | This probe and the product contract |

External messages are finalized-only. There is no `on=` on the EVM proxy.

IC-child rule (“failed child does not auto-return value”) applies to **internal** `PostMessage`, not to this EOA path.

## Direct tests (not live proof)

```powershell
$env:PYTHONIOENCODING='utf-8'
$env:GENVM_VERSION='v0.6.0-rc7'
python -m pytest .\tests\direct\test_settlement_probe.py -v
```

Credits in those tests come from the labeled `DirectExternalTransfers` test double after `deliver_last()`. They are **not** Studio-dev payout proof.

## What this means for the product contract

* Pay EOAs with `@gl.evm.contract_interface` / `EthSend`
* Keep decision, `payout_submitted`, receipt delivery, and EOA deltas as separate frontend fields
* Size rewards knowing payout-write protocol fees can exceed `0.001 GEN`
* Public Create / Submit / Decision / Library screens are now wired at `/`. The Stitch demo stays under `/demo`. This probe page is `/live-settlement` and is not the product UI.
