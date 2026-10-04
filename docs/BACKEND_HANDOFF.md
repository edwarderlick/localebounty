# LocaleBounty backend handoff (Step 2)

Studio-dev only. This document does **not** authorize a git push, a new deploy, or a rewrite of archived Copy evidence. The six **public** screens at `/` are wired to the existing Studio-dev contract. The original Stitch demo remains under `/demo`. Stitch HTML, screenshots, and `DESIGN.md` are stored in `docs/design-source/`.

| Field | Value |
| --- | --- |
| Chain | GenLayer Studio Devnet |
| Chain ID | `61997` |
| RPC | `https://studio-dev.genlayer.com/api` |
| Explorer | `https://explorer-studio-dev.genlayer.com` |
| Product contract | `contracts/localebounty.py` |
| Class | `LocaleBounty` (`gl.contract.Contract`) |
| Runner | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` |
| Product source SHA-256 | `6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f` |
| Experimental probe | `contracts/experimental/settlement_probe.py` (unchanged) |

## Settlement proof (separate from this contract)

Narrow verdict for the **experimental** EOA probe, funded **browser-wallet** run: **YES** for both Studio-dev release and refund paths.

Full write-up: [`SETTLEMENT_PROBE.md`](SETTLEMENT_PROBE.md). Independent RPC artifact: [`evidence/2026-09-30-studio-dev-eoa-settlement-independent-verification.json`](evidence/2026-09-30-studio-dev-eoa-settlement-independent-verification.json).

The Backend Step 2 prompt’s Copy evidence body was the placeholder `[PASTE THE EXACT “COPY EVIDENCE” JSON HERE]`. UI-only private balance history was **not** invented.

Keep these concepts separate everywhere (probe and product):

| Field | Meaning |
| --- | --- |
| Consensus / execution | Parent `FINALIZED` + `FINISHED_WITH_RETURN` |
| `payout_submitted` | Parent emitted EthSend (`emit_transfer`) |
| Receipt delivery | Child EOA message: exact recipient, exact value, `value_credited` |
| EOA evidence | Measured wallet delta |

`payout_submitted` is not paid. Direct-test `deliver_last()` credits are **test doubles**, not live proof.

Historical `scripts/studio_dev_settlement_probe.py` **exit 2** is a no-key script result. It is not this verdict and is not claimed as exit 0.

## Product contract

Smallest complete translation-bounty lifecycle on the proven `@gl.evm.contract_interface` / `emit_transfer` → EthSend path.

### Writes

| Method | Payable | Who | What |
| --- | --- | --- | --- |
| `create_task(client_nonce, source_text, source_locale, target_locale, string_key, app_context, intended_meaning, semantic_criteria, translator, submit_by_unix, recover_after_unix) -> str` | yes | funder | Locks **exact** `message.value` as reward. Returns a 64-hex `task_id`. |
| `submit_translation(task_id, translation)` | no | named translator only | Stores one bounded translation **before** AI. |
| `evaluate_task(task_id)` | no | anyone | GenLayer AI + equivalence-principle check; then EthSend payout or refund. |
| `cancel_task(task_id)` | no | funder | Open task, no submission: EthSend refund to funder. |
| `recover_undecided_task(task_id)` | no | anyone | After `recover_after_unix`, if still submitted and undecided: EthSend refund. |

### Open-task cancellation (design only — not deployed)

**Current deployed rule** (`0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96`, source SHA-256 `6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f`): the funder may `cancel_task` whenever `state == open`, `translation == ""`, and `decision == none`. There is no grace end, no submit-window freeze, and no translator compensation. Direct tests already cover refund-on-cancel and `cancel not allowed` after submit. This contract is **not** being edited in this audit.

**Translator fairness risk:** a named translator can see the bounty and start work, then lose the entire attached reward if the funder cancels before `submit_translation` finalizes. Off-chain drafts are uncompensated. This is the unrestricted-poster-cancellation criticism.

**Options compared (none implemented):**

| Policy | On-chain change | When the translator can safely begin | When the funder can cancel | Open task with no submission after `submit_by_unix` |
| --- | --- | --- | --- | --- |
| A. 15-minute grace then freeze | Small: `CANCEL_GRACE_SECONDS = 900` on `cancel_task` | After `created_at_unix + 900`, until `submit_by_unix` | Before grace end, or at/after `submit_by_unix` if still empty | Funder `cancel_task` refunds the exact lock. `recover_undecided_task` still only covers `submitted`. |
| B. Translator acceptance write | Larger: new `accept_task` + states (`open` → `accepted` → `submitted`) | After `accept_task` finalizes | While `open` and unaccepted; frozen once accepted until deadline | If never accepted: funder cancel any time while open. If accepted and no submit: cancel at/after `submit_by_unix`. |
| C. Delayed work-start (UI only) | None | Convention: wait until some off-chain clock | Unchanged: any time while open + empty translation | Unchanged current refund | 

**Recommendation:** **A** (15-minute grace + freeze until `submit_by_unix`, then funder cancel if still empty). It is the smallest contract change that actually binds the funder. Policy C does not answer the steward criticism. Policy B is fairer (explicit acceptance, no silent 15-minute window) but adds a write, a new state, and extra races (`accept` vs `cancel`, `accept` after deadline). Keep B as a later revision if A is still too rough.

**Phase C1 (source only):** Policy B is implemented in `contracts/localebounty_v2.py` with `expire_unsubmitted_task` (anyone, `now > submit_by_unix`) instead of funder cancel after accept. It is **not** deployed. Public screens stay on the V1 pin. Details: [`PHASE_C1_HANDOFF.md`](PHASE_C1_HANDOFF.md).

**Safe-work rule under A:** do not start translation work until the execution clock is past `created_at_unix + 900` and `get_task` is still `open` with empty translation. Submit before `submit_by_unix`. After a stored translation, cancel stays forbidden; timeout recovery is the funder path.

**Future contract tests (add only after a new deploy; not run against the current pin):**

- cancel at `created_at + 899` succeeds; cancel at `created_at + 900` while `now < submit_by_unix` reverts `cancel frozen until submit deadline`
- cancel at `submit_by_unix` with empty translation succeeds (deadline refund)
- cancel at `submit_by_unix - 1` during freeze reverts
- translator `submit_translation` during freeze still allowed
- funder cancel and translator submit in the same timestamp: one winner; the other reverts (`cancel not allowed` or `not open`)
- unauthorized non-funder still reverts
- cancel after submit still reverts `cancel not allowed`
- `created_at + 900 > submit_by_unix` (short window): freeze never starts; cancel remains allowed until submit or deadline — document this degenerate case
- If B is chosen instead: `accept_task` unauthorized reverts; accept after cancel reverts; cancel after accept reverts until deadline; double accept reverts

**Redeploy impact:** any of A or B changes `contracts/localebounty.py`. The live source pin would break. A new Studio-dev address would be required. Phase A (create/cancel), B1 (approve), B2 (reject), public-app Decision, and timeout-recovery proofs would all need to be **repeated**. Do **not** modify or redeploy until this policy is accepted. The public UI discloses the **current** unrestricted cancel risk to the translator.

### Views (bounded / paginated)

| Method | Returns |
| --- | --- |
| `get_task(task_id)` | Full public task dict, including text fields and `recovery_opens_at_unix` |
| `task_count()` | `int` |
| `list_task_ids(offset, limit)` | `list[str]` (`limit` capped at 50) |
| `list_tasks(offset, limit)` | compact board summaries (`limit` capped at 50); **no** 4096-character text fields |
| `library_version_count(string_key, locale)` | `int` |
| `get_library_entry(string_key, locale, version)` | Library dict |
| `list_library(string_key, locale, offset, limit)` | `list[dict]` versions `offset+1` … (`limit` capped at 50) |

Public String Library (`/library`) discovers keys from unique approved `list_tasks` rows. Each `string_key` + locale loads **at most one** 50-version `list_library` page, then stores `nextVersionOffset`. **Load more versions for this key** fetches the next page only. Incomplete pair counts stay visible. RPC errors keep versions already loaded. Pair identity is a JSON tuple, not a NUL join (contract input may contain U+0000).

### Bounds

`MAX_TEXT` 4096, `MAX_KEY` 128, `MAX_LOCALE` 32, `MAX_NONCE` 128, `MAX_PAGE` 50, `MAX_RECOVERY_SECONDS` 30 days, `MIN_REVIEW_SECONDS` 3600.

Zero `message.value` and the zero translator address are rejected.

`list_tasks` returns compact summaries (ids, parties, locales, `string_key`, state, payment flags, timestamps). Full `source_text`, `translation`, `app_context`, `intended_meaning`, and `semantic_criteria` are only on `get_task`.

Library index/entry keys are UTF-8 **length-prefixed**, so `string_key` / locale values that contain `\x1f` cannot collide.

### Task ID correlation (never a list count)

```
sha256(sender_address || contract_address || client_nonce)
```

- The create **execution result** is the `task_id`. Store that string.
- `task_count()` / `list_task_ids` are indexes, not identity.
- `client_nonce` is a permanent idempotency key scoped to **funder + this contract**. Reuse reverts `client_nonce reused` even after a later timestamp / `vm.warp`.
- A different funder may use the same nonce string; that mints a different `task_id`.
- Frontend should send a unique `client_nonce` per create (UUID or similar).

Timestamps use `gl.vm.get_timestamp()` when available, else the transaction datetime. Not the browser clock.

### States

Task `state`: `open` → `submitted` → `approved` | `rejected` | `timed_out`. From `open` only: `cancelled`.

| Field | Values | Meaning |
| --- | --- | --- |
| `state` | `open`, `submitted`, `approved`, `rejected`, `cancelled`, `timed_out` | Lifecycle |
| `decision` | `none`, `approved`, `rejected`, `cancelled`, `timed_out` | Consensus-backed outcome once set |
| `payment_status` | `none`, `submitted` | EthSend **emission**, not delivery |
| `payment_kind` | `""`, `payout`, `refund` | Who the emit targeted |
| `payout_submitted` | bool | Same as payment emission |
| `delivery_proven_onchain` | always `false` | Contract does not prove EOA credit |

Decision is persisted **only after** a successful `emit_transfer`. A failed transfer submission raises `transfer submission failed` and leaves the task recoverable (still `open`/`submitted`, `decision=none`). Retry the same write. Do not treat emit as paid.

Library versions increment per `string_key` + **target** locale on **approval only**. Rejected, cancelled, and timed-out translations never enter the library. Each entry stores `task_id` and the exact translation. Composite keys are length-prefixed; adversarial pairs that used to share a `\x1f` join stay separate.

### Evaluation

- Submission is stored first. A later LLM failure does not erase it.
- Leader: `gl.nondet.exec_prompt` on source, translation, context, meaning, criteria.
- Those fields are wrapped as **untrusted task data**. They must not override evaluator role or transfer rules.
- Validators re-run the same assessment and compare `meaning_preserved`, `criteria_satisfied`, and `approved` — not JSON shape, an enum, a score band, or the leader’s prose.
- `approved` must equal both booleans. Malformed output, model failure, or disagreement **fail closed**; escrow stays until a later successful evaluate, cancel (if still open), or timeout recovery.

### Timeouts vs one-sitting tests

- `submit_by_unix` must be in the future at create. Submission at exactly `submit_by_unix` is allowed; later is `submission deadline passed`.
- At create, `recover_after_unix` must be ≥ `submit_by_unix + MIN_REVIEW_SECONDS` (1 hour) and ≤ now + 30 days. A funder cannot set recovery at the submit deadline.
- After a real submission, recovery also waits until `submitted_at_unix + MIN_REVIEW_SECONDS`. Last-minute submits still get a contract-derived review window. `recovery_opens_at_unix` on `get_task` is `max(recover_after_unix, submitted_at + MIN_REVIEW_SECONDS)`.
- Approve/reject can run as soon as a translation is submitted. They do not wait for the review window.
- Timeout recovery is for undecided submitted tasks. Direct tests cover it with `vm.warp`. Live timeout needs the chain timestamp to pass `recovery_opens_at_unix`.
- Recovery reverts `recovery too early` before that instant and `already decided` after a finalized decision. It cannot race a completed payout/refund.

EOA payout/refund uses the same helper shape as the live-proven probe: `self.balance` then `_EoaWallet(recipient).emit_transfer(value=amount)`. Emit runs before the decision is persisted.

## Economics (do not hardcode the probe amount)

The live probe locked `0.001 GEN` (`10**15` wei) only to prove EthSend. That payout **write** consumed `126304500000823` wei (`0.000126304500000823` GEN) in **actual** protocol fee (`primary_fee_spent`). 1 GEN = `10**18` wei. That is **not** `0.126 GEN`. Refund arithmetic in wei: funder net `873695499999177` + fee `126304500000823` = `1000000000000000`. The fee **quote** is a deposit required upfront; unused deposit is returned.

**Do not** treat `0.001 GEN` as a viable product bounty. Rewards are the creator’s `message.value` only. No multiplier, no protocol-funded payout, no hardcoded GEN/USD, no percentage platform fee.

Protocol fees are **separate from escrow**. Later UI must show quoted fee deposit, consumed fee, refunded fee, and reward as distinct figures.

| Write | Attached value | Protocol fee payer |
| --- | --- | --- |
| `create_task` | exact reward (escrow) | funder |
| `submit_translation` | 0 | named translator |
| `evaluate_task` | 0 | caller (anyone) |
| `cancel_task` | 0 | funder |
| `recover_undecided_task` | 0 | caller |

The payout/refund **parent** is a second write. That wallet also posts a protocol-fee **deposit** and pays the actual consumed fee, as in the probe. Escrow is not used to pay fees.

## Frontend (public app vs demo)

Public routes at `/` talk to contract `0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96` on chain `61997`:

| Route | Screen |
| --- | --- |
| `/` | Task Board (`list_tasks`) |
| `/tasks/new` | Create Task (`create_task`) |
| `/tasks/:id` | Task Detail (`get_task`, cancel, recover) |
| `/tasks/:id/submit` | Submit Translation |
| `/tasks/:id/decision` | Validation & Decision (`evaluate_task`) |
| `/library` | String Library (approval-only) |

Demo Stitch screens stay at `/demo` on `demoStore`. Persist is isolated: `localebounty.product-ui.create.v1` and `localebounty.product-ui.writes.v1` never share keys with Phase A/B1/B2/timeout harnesses or demo. Design HTML/screenshots: `docs/design-source/`.

Evidence columns stay separate:

1. Wallet / quote (live **fee deposit**)
2. Transaction status
3. Execution result (`FINISHED_WITH_RETURN` vs error)
4. Contract `state` / `decision` / `payment_status`
5. Child EthSend recipient + value + `value_credited`
6. EOA balance delta (fee payer may be the recipient; then net = reward − actual receipt fee)

Do not invent a relayer, staking, slashing, appeals, validator score breakdown, a fixed 67% threshold, or automatic on-chain proof of EOA delivery.

**WalletConnect (optional):** injected wallets work without config. Set public `VITE_WALLETCONNECT_PROJECT_ID` in `.env.local` (gitignored) to show WalletConnect. `.env.example` stays an empty placeholder. Absence hides only that option. No private keys. Production hosts must set `VITE_WALLETCONNECT_PROJECT_ID` at **build** time and rebuild; Vite inlines it and a runtime-only env change is not enough. **Opening the WalletConnect QR is not mobile pairing.** Pairing requires a user-controlled wallet to scan and approve the session. Network switching is a later wallet action. Neither is proven by showing the QR.

**Fee deposit vs actual fee vs delivery vs balance:** keep four fields separate. The pre-sign quote is a **fee deposit**. `primary_fee_spent` is **actual consumption**. Unused deposit is returned. Outgoing EthSend + child `value_credited` is **transfer delivery**. EOA delta is **balance evidence**. Reward is the create `message.value` only. Parent `FINALIZED` + `FINISHED_WITH_RETURN` is not delivery. `payout_submitted` is not paid.

## Tests run (pre-deploy repair)

GenVM lint (`python -m genvm_linter.cli lint contracts/localebounty.py`): **ok**, 3 checks. Schema extract **ok** (12 methods: 5 writes, 7 views). Runner pin matches Studio-dev `py-genlayer:5jycge4q8k…`.

Direct tests (`GENVM_VERSION=v0.6.0-rc7`):

```
tests/direct/test_localebounty.py ....................   20 passed
tests/direct/test_settlement_probe.py ............         12 passed
```

Covered on the product contract: approval payout emit, rejection refund emit, open cancel refund, timeout recovery, failed transfer (decision not persisted), unauthorized translator, duplicate submit/evaluate/payout, concurrent create IDs (not list counts), **nonce reuse after warp**, library version order, **adversarial library key/locale pairs**, malformed LLM, validator disagreement, prompt-injection text, length bounds, deadline races, submission at deadline, early recovery vs immediate evaluate, pagination, **compact `list_tasks` vs full `get_task`**, zero reward/translator.

Credits in those tests come from `DirectExternalTransfers.deliver_last()`. **Not live payout proof.**

Integration module is skipped unless `GENLAYER_INTEGRATION=1`. A skip or a local pass without Studio-dev tx IDs and wallet deltas is **not** live proof.

Frontend: `npm test` — 224 passed (19 files). `npm run build` — `tsc -b && vite build` succeeded.

## Phase A live product test (archived 2026-10-01)

Exact Copy evidence JSON is archived at [`evidence/2026-10-01-phase-a-live-product-copy-evidence.json`](evidence/2026-10-01-phase-a-live-product-copy-evidence.json). File SHA-256 is `17728D361A8B5751196130299F2EB93B88C5C855D03F124D8E7E3E55E46A507E` (551447 bytes). The archive is the original paste, including a historical transient `get_task` error.

| Field | Value |
| --- | --- |
| `live_result` | YES (Phase A deploy / create / cancel refund path) |
| Contract | `0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96` |
| Source SHA-256 | `6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f` (local = deployed) |
| Funder | `0x31e14df3b4f47f2428f3b78e7279691a78f70a05` |
| Named translator (unused in Phase A) | `0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253` |
| Reward | `0.5` GEN (`500000000000000000` wei) |
| `client_nonce` | `b3638915-9619-417c-b2ed-7474770f1055` (spent; do not reuse on this funder+contract) |
| `task_id` | `43664cb63318d83a1da900149ed46982e04865c994fb2e2271797ca930d8b1e8` |
| Deploy tx | `0x47c4796089a5c3fa83eaba7e6e636f76878746fdd67e7d56569595fa03406260` |
| Create tx | `0xc263867a1a9d4752e7b0535e04965b036f3a65188b50d7f79dd1ccf1ab5a88a4` `FINALIZED` / `FINISHED_WITH_RETURN` |
| Cancel tx | `0xdafc81730a100d256b66fd1e4b38b023122c9c0063146f6d84eba6b922cc909a` `FINALIZED` / `FINISHED_WITH_RETURN` |
| Child credit | `0xeb7d6e1e22d9981db5c2525738cd5e0096096a9420f918e54737b6ba5320922b` `value_credited` true, exact funder + reward, `triggered_by` cancel parent |
| Cancel receipt fee | `126310500000823` wei |
| Funder before cancel | `34732844451749803205` wei |
| Funder after wait | `35232718141249802382` wei (reward minus that receipt fee) |
| Named translator | unchanged |
| Contract after refund | `0` (was `0.5` GEN) |

Historical UI error kept in the JSON: `cancel.error` = `get_task after cancel: An unknown RPC error occurred.` In the same paste, `cancelTask.state` is `cancelled` with `decision=cancelled` and `payment_kind=refund`. A later successful `get_task` read is what shows cancelled; the transient RPC error is not rewritten out of the archive.

The same Phase A paste stored `historicalProbePayoutFeeNote` saying the probe fee was “about 0.126 GEN”. **That note is a unit error** (it treated `10**15` wei as 1 GEN). The archive is not rewritten. Correct conversion: `126304500000823` wei = `0.000126304500000823` GEN.

Frontend persist for this run is `localebounty.live-product.v1` (`/live-product`). Going forward, a successful `get_task` refresh clears stale `get_task…` UI errors. Do not treat that cleanup as a rewrite of this evidence file.

## Phase B1 live product test (archived 2026-10-01)

Exact Copy evidence JSON is archived at [`evidence/2026-10-01-phase-b1-live-product-copy-evidence.json`](evidence/2026-10-01-phase-b1-live-product-copy-evidence.json). File SHA-256 is `DE4418E4EC33693C1F1A3B59DA743DCF92A20319AF3D8D14ACA8C769E95326FE`. The archive is the original paste.

| Field | Value |
| --- | --- |
| `live_result` | YES (create → submit → evaluate **approved**) |
| Contract | `0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96` (existing deploy; not redeployed) |
| Funder | `0x31e14df3b4f47f2428f3b78e7279691a78f70a05` |
| Translator | `0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253` |
| Reward | `0.5` GEN (`500000000000000000` wei) |
| `client_nonce` | `5449056c-5920-43d9-bef7-2b5268afb1f0` |
| `task_id` | `b5554d6cfe8b7e9e0d3b9f26cc47421ec6faec03fb36d85f74542dd107202199` |
| Create tx | `0xe4e50d1c0808e8b3131e8b3994f99b07bb6df8da5d66ccb3e099e8b063940c6a` |
| Submit tx | `0x1a758949da1270bb2782915acf579343f25b936158514075a0057c2ad2b1af18` |
| Evaluate tx | `0x855de150b4b1d07a7bb63877bc159f8a204f65bebd9d06cc24b7b4d1834d8e10` `FINALIZED` / `FINISHED_WITH_RETURN` |
| Library | version **1** linked to that `task_id`, translation `Tu pedido ya va en camino.` (`checkout.delivery.on_the_way` / `es`) |
| Child credit | `0x8a95d3287c5c1e472a25fcbc4b4c96dd0e1be6c267b9007e9fda589a77abe0f7` `value_credited` true, **0.5 GEN** to the translator, `triggered_by` evaluate parent |
| Evaluate fee deposit (quote) | `760929600010352` wei |
| Evaluate actual fee consumed | `126529000000823` wei (`0.000126529000000823` GEN) |
| Funder delta at evaluate | `-126529000000823` wei (actual fee; unused deposit returned) |
| Translator delta | `+500000000000000000` wei |

Persist: `localebounty.live-product-b1.v1` (`/live-product-b1`). This harness is separate from the public Decision page approval below.

**GEN units:** `126529000000823` wei = `0.000126529000000823` GEN. The fee **deposit** quoted before sign is larger than the **actual** `primary_fee_spent`; unused deposit is returned. Do not describe this fee as `0.126 GEN`.

## Phase B2 live product test (archived 2026-10-01)

Exact Copy evidence JSON is archived at [`evidence/2026-10-01-phase-b2-live-product-copy-evidence.json`](evidence/2026-10-01-phase-b2-live-product-copy-evidence.json). File SHA-256 is `380F22509E094EF44B556E906F0DD0F63CF66720A5242B7C45B9873640C29833`. The archive is the original paste. The earlier UNPROVEN template at [`evidence/2026-10-01-phase-b2-live-product-copy-evidence.UNPROVEN.json`](evidence/2026-10-01-phase-b2-live-product-copy-evidence.UNPROVEN.json) is left in place and was not overwritten.

| Field | Value |
| --- | --- |
| `live_result` | YES (create → submit → evaluate **rejected**) |
| `unexpectedApproval` | false |
| Contract | `0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96` (existing deploy; not redeployed) |
| Funder | `0x31e14df3b4f47f2428f3b78e7279691a78f70a05` |
| Translator | `0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253` |
| Reward | `0.5` GEN (`500000000000000000` wei) |
| `client_nonce` | `41903485-a127-4703-a667-5c60670ac597` |
| `task_id` | `c4eeef810115ad3df4cabb52b28b89b6da2247923e8dfc077cd5f60d437e9f2e` |
| String key | `phase_b2.checkout.delivery.on_the_way` |
| Translation | `Tu pedido aún no ha sido enviado.` |
| Create tx | `0x56438746d6e37d80439618048515fb93e06fdd9e9481d50b87fb254a7253b199` |
| Submit tx | `0x1f40a59640756394d75252d172fe66a7e3d531a00e750081ad7f57dbf9db3f89` |
| Evaluate tx | `0x12fce3ae4c62a726f1d5e74a9891e2bee15c928e3c81bcff9e889f28eefc0fb7` `FINALIZED` / `FINISHED_WITH_RETURN` |
| Library | before **0** / after **0**, no entry for this task |
| Child credit | `0x6df1e152845bea2aedbc9d7423d50974854df614210f110e2bc333ed5bddb18f` `value_credited` true, **0.5 GEN** to the funder, `triggered_by` evaluate parent |
| Evaluate actual fee consumed | `126525250000823` wei (`0.000126525250000823` GEN) |
| Funder delta at evaluate | `+499873474749999177` wei (reward minus actual receipt fee) |
| Translator settlement delta | `0` |

Persist: `localebounty.live-product-b2.v1` (`/live-product-b2`). This harness is separate from the public Decision page approval below.

**GEN units:** `126525250000823` wei = `0.000126525250000823` GEN. `payout_submitted` is not child delivery.

## Timeout-recovery live product test (implementation only)

Separate route `/live-product-timeout`, persist `localebounty.live-product-timeout.v1`. Reuses the **existing** Studio-dev contract `0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96`. Does not modify `contracts/localebounty.py` and does not redeploy. Phase A/B1/B2 archives stay untouched. Public screens at `/` use a different persist. This page never calls `evaluate_task`.

Intended funded-wallet flow (agent does not sign):

1. Funder creates a **new** task with a fresh `client_nonce`, user-chosen reward, unique string key `phase_timeout.checkout.delivery.on_the_way`.
2. Named translator submits a translation. Create and submit tx IDs persist so the browser can close.
3. Show `get_task` `submitted` and exact `recovery_opens_at_unix` with a local date and countdown. Sign stays disabled until that contract time (`max(recover_after_unix, submitted_at + 3600)`).
4. At or after opening, funder Estimates and explicitly Signs `recover_undecided_task`.
5. YES only if `get_task` `timed_out` / `refund`; recover `FINALIZED` + `FINISHED_WITH_RETURN`; outgoing EthSend + child credit to the funder for the exact reward; funder delta = reward − actual receipt fee; translator settlement delta is zero; library count for this key unchanged and no entry for this task. `payout_submitted` and parent success alone are not payment.

The timeout-recovery opening timestamp (`recovery_opens_at_unix`) has been reached on the live task. Recovery is still **UNPROVEN** until the user’s wallet Estimates and Signs `recover_undecided_task` and the refund evidence is checked: `get_task` `timed_out` / `refund`, recover `FINALIZED` + `FINISHED_WITH_RETURN`, outgoing EthSend + child credit to the funder for the exact reward, funder delta = reward − actual receipt fee, translator settlement 0, library unchanged. Do not treat the public-app evaluate YES as timeout proof. The agent does not sign this.

## Public-app Decision approval (live, separate from Phase B1)

This is the public Validation & Decision screen (`/tasks/:id/decision`, persist `localebounty.product-ui.writes.v1`). It is **not** the Phase B1 harness archive. The contract was not redeployed. No extra evaluate transaction was submitted for this documentation pass.

The exact user-pasted Copy evidence JSON is archived at [`evidence/2026-10-01-public-ui-decision-copy-evidence.json`](evidence/2026-10-01-public-ui-decision-copy-evidence.json). File SHA-256: `87F271BE2F4066714C16AE84BF159AF6B71349142A9AC64B642F38237A323647`. The browser supplied create and submit hashes for this task; the archive preserves its original evidence fields and snapshots.

| Field | Value |
| --- | --- |
| `live_result` | YES (public `evaluate_task` **approved**, evaluator = translator) |
| Contract | `0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96` |
| Task id (from evaluate calldata) | `b82d9249344ce081c69f659bf95ca00f40b8b22b6218131025787b71e0023302` |
| Evaluator and translator | `0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253` |
| Reward / child credit | `500000000000000000` wei (0.5 GEN) |
| Create parent | `0xdde65fc88ced97a19bc532886893c49b97bfe4ff22a22ca7ec65842476491f02` `FINALIZED` / `FINISHED_WITH_RETURN` |
| Submit parent | `0x737de3eb38eb9971a0facf94da55f6715f9d9492063543f1de7b2d1c56e82eb2` `FINALIZED` / `FINISHED_WITH_RETURN` |
| Evaluate parent | `0xa1dbcd046445f8ccfaf4d8f2917e20628a55a19ef9f6c1262107ba75f681060b` `FINALIZED` / `FINISHED_WITH_RETURN` |
| Child credit | `0xa5817ff984a9591705eabe9e9abe7a5e2a0a628ec67454a8f14f24cf82af49e6` exact reward to the translator, `triggered_by` that parent |
| Receipt fee | `primary_fee_spent` `126529250000823` wei (`0.000126529250000823` GEN) |
| Translator net delta | `499873470749999177` wei |
| Funder delta | `0` |
| Equation | `translator_delta = reward − actual receipt fee` |
| Copy evidence | Public Decision **Copy evidence JSON** (create/submit hashes only if that browser stored them) |

Phase B1 used a **different** evaluate hash (`0x855de150…`) and a **different** `task_id` (`b5554d6c…`). Keep them separate.

## Next live deployment test (not done in this step)

Do this on Studio-dev `61997` only, with a funded browser wallet. Do not treat MetaMask “confirmed” as `FINISHED_WITH_RETURN`. The product contract is **already deployed**; do not redeploy unless source changes. Public screens are already wired.

1. Deploy `contracts/localebounty.py` with runner `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng`. Record deploy tx ID. Verify `gen_getContractCode` SHA-256 against `6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f` if the RPC still returns source.
2. Quote the live fee **deposit** separately from attached reward. The historical probe **actual** fee was `0.000126304500000823` GEN (`126304500000823` wei), not `0.126 GEN`. Unused deposit is returned.
3. **Approve path (one sitting):** `create_task` (unique `client_nonce`, named translator EOA, `submit_by_unix` a few minutes ahead, `recover_after_unix` ≥ submit deadline + 3600s) → `submit_translation` from that EOA → `evaluate_task` immediately (do not wait for the review window). Require parent `FINALIZED` + `FINISHED_WITH_RETURN`, library version 1 linked to that `task_id`, EthSend to the translator for **exact** reward, then child `value_credited` and translator delta.
4. **Reject path:** new task, poor translation, evaluate. Library unchanged. EthSend refund to funder; record fee vs net separately.
5. **Cancel path:** create, no submit, funder `cancel_task`. Refund emit + delivery.
6. **Timeout path:** create, submit, do **not** evaluate. `recover_undecided_task` must revert until `recovery_opens_at_unix` (`max(recover_after_unix, submitted_at + 3600)`). After that chain timestamp, recover refunds. Must revert if evaluate already succeeded. Do not expect a live timeout in a few minutes unless deadlines were set that tight **and** the 1-hour review window has elapsed.
7. Negative checks: wrong translator, duplicate submit, second evaluate, recover after approve, **reused `client_nonce` from the same funder**.
8. Copy public evidence only: addresses, tx IDs, statuses, execution results, outgoing message recipient/value, child delivery, measured deltas. Do not invent private history.

Phase A cancel, Phase B1 harness approve, Phase B2 harness reject, and the public-app Decision approve path have archived historical wallet-run YES Copy evidence. Independent public RPC replay of those hashes is a **separate** conclusion (`scripts/verify_archived_public_evidence.py`): HTTP 403 leaves replay **UNPROVEN** and does not erase the historical YES. Timeout-recovery live test is implemented; the opening timestamp has been reached; the refund is **UNPROVEN** until the user signs recover and evidence is checked. Remaining live gaps: timeout recovery wallet proof, independent RPC replay of archived txs, WalletConnect mobile pairing.

## Unresolved risks

- Product contract **is deployed** on Studio-dev at `0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96`. Phase A / B1 / B2 / public Decision have **historical wallet-run YES** archives. Those labels are not independent RPC replay. Public Decision parent `0xa1dbcd046445f8ccfaf4d8f2917e20628a55a19ef9f6c1262107ba75f681060b`, child `0xa5817ff984a9591705eabe9e9abe7a5e2a0a628ec67454a8f14f24cf82af49e6`, translator net `499873470749999177` wei = reward minus receipt `primary_fee_spent` `126529250000823` wei. Independent `eth_getTransactionByHash` / `gen_getTransaction` replay is currently **UNPROVEN** (Studio-dev HTTP 403). Timeout recovery opening time has been reached; refund remains **UNPROVEN** until a wallet signs it. Open-task cancel remains unrestricted on the deployed pin. Unit tests passing does not make the project steward-ready.
- If `emit_transfer` is accepted on the parent but the child EOA is not credited, the contract has already set `payout_submitted` and will not retry. Frontend must use receipt + wallet evidence; there is no automatic delivery proof.
- Validator disagreement or malformed LLM leaves escrow in `submitted` until a later successful evaluate or timeout recovery (up to 30 days).
- Live LLM jailbreaks are mitigated by wrapping untrusted fields and fail-closed consensus, not by a hard guarantee that every model ignores injected instructions.
- Same funder + `client_nonce` always reverts, including across later timestamps. Distinct nonces stay independent of list order.
- Direct-mode Address/LLM mocks are test doubles around the Studio-dev stdlib. They can pass while a live runner still fails.
- Protocol fees are separate from escrow. Quote the live deposit; the actual consumed fee on the probe was `0.000126304500000823` GEN, about 12.6% of the `0.001 GEN` probe lock, not 126× that lock.

Not in this contract (and not to be faked in UI): relayer, staking, slashing, appeals, validator score cards, 67% threshold, GEN/USD, percentage platform fee.
