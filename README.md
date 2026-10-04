# LocaleBounty

Vite + React UI for a translation-bounty intelligent contract on **GenLayer Studio Devnet** (`61997`).

**The public landing page `/` opens the deployed V2 app at `/v2`.** The historical V1 board remains at `/v1`; its task URLs remain under `/tasks/...`. The original Stitch demo remains isolated under `/demo`.

The six V2 product screens — Task Board, Create Task, Task Detail, Submit Translation, Validation & Decision, String Library — read and write the deployed V2 contract. The demo never mixes with live task or wallet tracking.

This repo does not sign, deploy, or push for you. Wallet writes are user-initiated.

## Network

| Field | Value |
| --- | --- |
| Chain | GenLayer Studio Devnet |
| Chain ID | `61997` |
| RPC | `https://studio-dev.genlayer.com/api` |
| Studio / faucet UI | `https://studio-dev.genlayer.com` |
| Explorer | `https://explorer-studio-dev.genlayer.com` |
| Public V2 contract | [`0x3B06e08182Db177a61B1707f7b5A84834A45F431`](https://explorer-studio-dev.genlayer.com/address/0x3B06e08182Db177a61B1707f7b5A84834A45F431) |
| V2 source SHA-256 | `3cbb7ff08dca3909b9765ce0467e7ddc8c6ec0d7c104e142c892cfafd169a43d` |
| Historical V1 contract | [`0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96`](https://explorer-studio-dev.genlayer.com/address/0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96) |
| V1 source SHA-256 | `6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f` |

This is **not** studionet (`61999`).

## Run locally

```powershell
npm install
npm run dev
```

Then open `http://127.0.0.1:5173/`. It redirects to the V2 board. Vite is pinned to port `5173` (`strictPort`); stop another app on that port before starting LocaleBounty.

## V2 public app

| Route | Screen |
| --- | --- |
| `/` → `/v2` | V2 Task Board |
| `/v2/tasks/new` | Create Task |
| `/v2/tasks/:id` | Task Detail, accept/cancel/expire/recover actions |
| `/v2/tasks/:id/submit` | Submit Translation |
| `/v2/tasks/:id/decision` | Validation & Decision, Copy V2 evidence JSON |
| `/v2/library` | Approved String Library |

Create tracking uses `localebounty.product-ui-v2.create.v1`; action tracking uses `localebounty.product-ui-v2.writes.v1`. Wallet signatures are user-initiated. A transaction hash is persisted before receipt tracking and is never silently resubmitted.

### Verified V2 walkthrough

Open the approved task in the app at `/v2/tasks/7e1974679cc5f3423573e8cf52b2446ed2a3de6bf4ad5415054f8532bf2c6352`, then its Decision page and `/v2/library`. The approved Spanish string is **“Tu pedido ya está en camino.”** The version 1 library entry links to that task.

The [exact signing-browser evidence JSON](docs/evidence/2026-10-03-v2-approved-decision-copy-evidence.json) records create, accept, submit, and evaluate hashes; the [evaluate parent](https://explorer-studio-dev.genlayer.com/tx/0xb8347951b9428e16edc3178d3915f89206c24ca28178b9f520f8eaa399365923) finalized with `FINISHED_WITH_RETURN`. Its outgoing EthSend and [credited child](https://explorer-studio-dev.genlayer.com/tx/0x045207e2ac7c0fc29de8bfd452ae3bcd51b7fe80ac13370a8fa24a3cea1e8682) each show `500000000000000000` wei to the named translator. The translator balance gained exactly that amount; the evaluator/funder paid the receipt fee `126528500000823` wei. Archive SHA-256: `EA2D071FB84DC3363CE93FA3F31CAA926EE822B74ACEFACA42B76DE3B39D2FBC`.

The [V2 Lane A archive](docs/evidence/2026-10-03-v2-phase-c2-lane-a-evidence.json) proves the unaccepted cancel/refund path. The [Lane B archive](docs/evidence/2026-10-03-v2-phase-c2-lane-b-evidence.json) proves acceptance; its expiry/refund remains **UNPROVEN**. WalletConnect mobile pairing remains untested. See the [release audit](docs/V2_RELEASE_AUDIT.md) and [prior steward feedback matrix](docs/STEWARDS_REVIEW_MATRIX.md).

## Historical V1 app

| Route | Screen | Contract |
| --- | --- | --- |
| `/v1` | Task Board | `task_count` / `list_tasks` |
| `/tasks/new` | Create Task | `create_task` (user signs) |
| `/tasks/:id` | Task Detail | `get_task`; funder cancel / timeout recover |
| `/tasks/:id/submit` | Submit Translation | `submit_translation` (named translator) |
| `/tasks/:id/decision` | Validation & Decision | `evaluate_task` (any Studio-dev wallet) |
| `/library` | String Library | approval-only `list_library` / `get_library_entry` (one 50-version page per key, then Load more versions) |

Persist keys (do not mix with harnesses or demo):

- Create tracking: `localebounty.product-ui.create.v1`
- Submit / evaluate / cancel / recover: `localebounty.product-ui.writes.v1`

## V2 route details

| Route | Screen | Contract |
| --- | --- | --- |
| `/v2` | V2 Task Board | `task_count` / `list_tasks` on the V2 contract |
| `/v2/tasks/new` | V2 Create Task | `create_task`; disabled until this page load rechecks the pinned V2 source |
| `/v2/tasks/:id` | V2 Task Detail | `get_task`; accept/cancel/expire/recover actions by state |
| `/v2/tasks/:id/submit` | V2 Submit Translation | `submit_translation` (named translator only, accepted task, now <= `submit_by_unix`) |
| `/v2/tasks/:id/decision` | V2 Validation & Decision | `evaluate_task` (any connected Studio-dev wallet); displays the stored decision |
| `/v2/library` | V2 String Library | approval-only `list_library`; bounded fail-closed pagination |

V2 persist keys:

- Create tracking: `localebounty.product-ui-v2.create.v1`
- Accept / cancel / submit / evaluate / expire / recover: `localebounty.product-ui-v2.writes.v1`

V2 evidence uses the Copy V2 evidence JSON action on `/v2/tasks/:id/decision`. It exports only hashes, receipts, child credit, snapshots, and library entries stored in this signing browser.

`payout_submitted` is not paid. Parent `FINALIZED` + `FINISHED_WITH_RETURN` is not child delivery. Outgoing EthSend + child `value_credited` is transfer delivery. EOA delta is balance evidence. Decision Copy evidence JSON uses get_task, this browser’s evaluate snapshots, and the parent receipt. Create/submit hashes appear only when this browser stored them for that task.

### Fee deposit vs actual fee

The quote shown before Sign is a **fee deposit required upfront**. After finalization, `primary_fee_spent` (or required − refunded) is the **actual consumed fee**. Unused deposit is returned. Reward/escrow is a separate attached value on `create_task` only.

| Label | Meaning |
| --- | --- |
| Fee deposit (quote, required upfront) | Amount the wallet must post with the write |
| Actual fee consumed (receipt) | `primary_fee_spent` from the parent receipt |
| Unused fee deposit returned | Deposit minus actual fee |

1 GEN = `10**18` wei. Do not treat `~1.26e14` wei as `0.126 GEN`.

When the evaluator is also the payout recipient, the EOA net delta is **reward − actual receipt fee**. Outgoing EthSend and matching child credit stay exact reward and are separate fields.

### WalletConnect (optional)

Injected EIP-6963 wallets work without extra config.

To show WalletConnect locally, copy `.env.example` to `.env.local` and set a **public** Reown project ID:

```
VITE_WALLETCONNECT_PROJECT_ID=your_public_project_id
```

Restart Vite. If the variable is absent, only that option is hidden. `.env.local` is gitignored; keep `.env.example` as an empty placeholder. Do not commit or hardcode the project ID.

**Production hosting:** Vite inlines `VITE_*` at **build** time. Set `VITE_WALLETCONNECT_PROJECT_ID` in the host’s build environment and **rebuild**. Changing the variable after `npm run build` has no effect until the next build.

Opening the WalletConnect QR is **not** mobile pairing. Pairing needs a user-controlled wallet to scan and approve. Network switching is a later wallet action. Neither is proven by showing the QR.

This app never requests, generates, exports, logs, stores, or transmits private keys. There is no backend signer.

## Demo screens

`http://127.0.0.1:5173/demo` — six Stitch screens on `demoStore` / localStorage. Demo Owner / Demo Translator is not wallet authorization. Demo does not lock or pay GEN.

Original Stitch `code.html` / `screen.png` pairs and `DESIGN.md` tokens live under [`docs/design-source/`](docs/design-source/). The Vite app does not import those files.

## Live evidence (separate runs)

Do not collapse these into one verdict. Archives under `docs/evidence/` are not rewritten.

| Run | Route / persist | Result |
| --- | --- | --- |
| Experimental EOA probe | `/live-settlement` | Archived YES (release + refund) |
| Phase A create / cancel refund | `/live-product` · `localebounty.live-product.v1` | Archived YES |
| Phase B1 create / submit / **approve** | `/live-product-b1` · `localebounty.live-product-b1.v1` | Archived YES |
| Phase B2 create / submit / **reject** | `/live-product-b2` · `localebounty.live-product-b2.v1` | Archived YES |
| Timeout recovery | `/live-product-timeout` · `localebounty.live-product-timeout.v1` | Opening timestamp reached. **UNPROVEN** until the user signs `recover_undecided_task` and refund evidence is checked |
| Public-app **approve** (Decision page) | `/tasks/:id/decision` · product-ui writes | Historical wallet-run **YES** for evaluate parent `0xa1dbcd046445f8ccfaf4d8f2917e20628a55a19ef9f6c1262107ba75f681060b`. Independent RPC replay is a separate conclusion |

Public-app approval (evaluator = translator `0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253`), **historical wallet-run** (signing browser):

- Child credit `0xa5817ff984a9591705eabe9e9abe7a5e2a0a628ec67454a8f14f24cf82af49e6` · `500000000000000000` wei
- Receipt `primary_fee_spent` `126529250000823` wei
- Translator net delta `499873470749999177` wei (`reward − actual receipt fee`)
- Funder delta `0`
- Historical verdict **YES**
- Independent Studio-dev RPC replay: **UNPROVEN** while `eth_getTransactionByHash` returns HTTP 403. A hash existing is not payment verified.

Unit tests alone do not prove historical transfer delivery. See the V2 evidence archive and the release audit for the completed proof and remaining disclosures.

Details: [`docs/BACKEND_HANDOFF.md`](docs/BACKEND_HANDOFF.md).

## Static hosting

Build with `npm run build` and publish `dist/`. The repository includes `vercel.json` for Vercel and `public/_redirects` for Netlify so direct loads of `/v2/tasks/:id/decision` serve the SPA. Configure `VITE_WALLETCONNECT_PROJECT_ID` during the host build if WalletConnect is needed. After deployment, check `/`, a direct V2 decision deep link, `/v2/library`, `/v1`, and `/demo` on the hosted domain. No hosted-domain check has been completed yet.

## Static hosting

Build with `npm run build` and publish `dist/`. The repository includes `vercel.json` for Vercel and `public/_redirects` for Netlify so direct loads of `/v2/tasks/:id/decision` serve the SPA. Configure `VITE_WALLETCONNECT_PROJECT_ID` during the host build if WalletConnect is needed. After deployment, check `/`, a direct V2 decision deep link, `/v2/library`, `/v1`, and `/demo` on the hosted domain. No hosted-domain check has been completed yet.

## Static hosting

Build with `npm run build` and publish `dist/`. The repository includes `vercel.json` for Vercel and `public/_redirects` for Netlify so direct loads of `/v2/tasks/:id/decision` serve the SPA. Configure `VITE_WALLETCONNECT_PROJECT_ID` during the host build if WalletConnect is needed. After deployment, check `/`, a direct V2 decision deep link, `/v2/library`, `/v1`, and `/demo` on the hosted domain. No hosted-domain check has been completed yet.

## Build

```powershell
npm run build
npm test
```

Read-only check of archived public Decision evidence. Three conclusions: (1) archived JSON arithmetic, (2) historical wallet-run label, (3) independent RPC replay. HTTP 403 leaves (3) UNPROVEN and does not erase (2). Exit 2 is UNPROVEN replay, not a live pass.

```powershell
python scripts/verify_v2_release_evidence.py
python scripts/verify_v2_release_evidence.py
python scripts/verify_v2_release_evidence.py
python scripts/verify_archived_public_evidence.py
pytest tests/direct tests/integration -q
```

## Contracts

Product IC: `contracts/localebounty.py` (do not treat DEMO UI copy as contract behavior).

Experimental probe: `docs/SETTLEMENT_PROBE.md` and `contracts/experimental/settlement_probe.py`.
