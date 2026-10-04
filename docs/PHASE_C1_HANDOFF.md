# Phase C1 handoff — LocaleBounty V2 acceptance lifecycle

**Status:** source + direct tests only. V2 is **not** deployed, **not** live, and **not** steward-ready. The public six screens stay on the existing Studio-dev pin.

| Pin that must stay intact | Value |
| --- | --- |
| Live product file | `contracts/localebounty.py` (unchanged) |
| Live address | `0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96` |
| Live source SHA-256 | `6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f` |
| V2 source (local only) | `contracts/localebounty_v2.py` |
| V2 source SHA-256 (this revision) | `3cbb7ff08dca3909b9765ce0467e7ddc8c6ec0d7c104e142c892cfafd169a43d` |
| Runner | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` |

Direct-test EthSend credits use `deliver_last()`. That is a test double. It is not Studio-dev delivery.

## New method signatures

Writes (GenVM schema: 7 write, 7 view):

| Method | Payable | Caller | Attached GEN | Protocol fee payer |
| --- | --- | --- | --- | --- |
| `create_task(client_nonce, source_text, source_locale, target_locale, string_key, app_context, intended_meaning, semantic_criteria, translator, submit_by_unix, recover_after_unix) -> str` | yes | funder | exact reward escrow | funder |
| `accept_task(task_id)` | no | named translator | none | translator (write fee only) |
| `submit_translation(task_id, translation)` | no | named translator | none | translator |
| `evaluate_task(task_id)` | no | anyone | none | caller |
| `cancel_task(task_id)` | no | funder | none | funder |
| `expire_unsubmitted_task(task_id)` | no | anyone | none | caller (refund still goes to stored funder) |
| `recover_undecided_task(task_id)` | no | anyone | none | caller |

Views unchanged in shape except `get_task` / compact `list_tasks` now include `accepted_at_unix`.

## States

`open` → `accepted` → `submitted` → `approved` | `rejected` | `timed_out`

From `open` only: `cancelled` (funder, unaccepted).

From `open` or `accepted` with empty translation and `now > submit_by_unix`: `expired` (anyone).

| Instant | `accept_task` | `submit_translation` (if already `accepted`) | `expire_unsubmitted_task` | `cancel_task` |
| --- | --- | --- | --- | --- |
| `now < submit_by_unix` | named translator, while `open` | allowed | reverts `submission deadline not passed` | funder, only while `open` and unaccepted |
| `now == submit_by_unix` | reverts `accept deadline passed` | allowed (inclusive) | reverts `submission deadline not passed` | same as above |
| `now > submit_by_unix` | reverts `accept deadline passed` | reverts `submission deadline passed` | OPEN or ACCEPTED, empty translation; refund funder | still allowed only if still `open` and unaccepted |

Translator rule (frontend + ops, not an extra on-chain lock): wait until `accept_task` is `FINALIZED` with `FINISHED_WITH_RETURN` **and** `get_task` reports `accepted` before beginning work.

After `submitted`, only `evaluate_task` or `recover_undecided_task` can settle. Approval pays the translator; reject / review-timeout / cancel / expire refund the funder. Each settlement emits the exact stored reward to the state-derived recipient **before** persisting the terminal decision. `payout_submitted` is emission only.

## Frontend changes needed (do not ship against V1)

Keep `/` on `PRODUCT_UI_CONTRACT` `0x84dA…7D96` until a later deploy.

When a future slice points at V2:

- Board / detail: render `accepted` and `expired`; show `accepted_at_unix`.
- Translator: `accept_task` write, value `0`, fresh fee quote. Disable submit until finalized `accepted`.
- Submit: require `state == accepted`, named translator, execution time `<= submit_by_unix`.
- Cancel: enable only for funder while `open` and `accepted_at_unix == 0`.
- Expire: anyone, only when chain time `> submit_by_unix` and translation empty in `open` or `accepted`. Label that the caller pays the write fee and the refund recipient is the stored funder.
- Decision / timeout: unchanged after `submitted`.
- Library: already fail-closed. Approved compact row + `library_version_count == 0` stays visible as incomplete with an inconsistency error (shipped on the public library in this phase).

## New deployment and source-hash requirements

V2 cannot replace the live pin in place. A later deploy must:

1. Deploy `contracts/localebounty_v2.py` with runner `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng`.
2. Record the new address and deploy tx. Leave `0x84dA…7D96` and SHA-256 `6db9fb80…c93f` documented as the V1 pin.
3. Hash the exact deployed bytes and compare to the local V2 file (`3cbb7ff0…a43d` for this revision; recompute if the file changes).
4. Switch `PRODUCT_UI_CONTRACT` only after that hash match. This Phase C1 did **not** switch it.

## Live proofs that must be repeated after deploy

Do not reuse V1 Copy evidence as V2 proof. Repeat, with parent `FINALIZED` + `FINISHED_WITH_RETURN`, child EthSend, and EOA delta kept separate:

- `create_task` lock (exact `message.value`)
- `accept_task` (translator; unauthorized and duplicate revert; no GEN attached)
- funder `cancel_task` while OPEN unaccepted (exact refund)
- cancel after accept reverts during the window
- `submit_translation` at the inclusive deadline; expire exclusive of that instant
- `expire_unsubmitted_task` by a third party; refund still the funder
- `evaluate_task` approve payout to translator and reject refund to funder
- `recover_undecided_task` after the review window
- failed transfer leaves escrow recoverable
- library version 1 only on approval
- measured fee quotes for **new** writes (`accept_task`, `expire_unsubmitted_task`)

## Measured fee profile (not generated)

Installed `genlayer estimate-fees` could not produce a measured profile for the new write branches.

1. Phase C1 forbids deploy and signing, so V2 has no Studio-dev address to simulate against.
2. A no-address `genlayer estimate-fees --json` failed: `TypeError: client.estimateTransactionFees is not a function` (CLI vs genlayer-js mismatch).
3. Direct tests do not record protocol `primary_fee_spent`.

No fee numbers are invented here. After a V2 deploy, quote `accept_task` and `expire_unsubmitted_task` the same way V1 writes were quoted (fee deposit vs actual `primary_fee_spent` vs unused return).
