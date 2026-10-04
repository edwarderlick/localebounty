# V2 Release Audit

Updated 2026-10-05. V2 is the public default: `/` redirects to `/v2`. Historical V1 is at `/v1`; the demo is at `/demo`. Deployed V2 is `0x3B06e08182Db177a61B1707f7b5A84834A45F431` on Studio Devnet 61997. Local source SHA-256 is `3cbb7ff08dca3909b9765ce0467e7ddc8c6ec0d7c104e142c892cfafd169a43d`.

## Release position

The approved V2 payment is **YES in the signing-browser archive**, with parent receipt, outgoing EthSend, child credit, receipt fee, balance snapshots, and library entry. The exact archive is [here](evidence/2026-10-03-v2-approved-decision-copy-evidence.json), SHA-256 `EA2D071FB84DC3363CE93FA3F31CAA926EE822B74ACEFACA42B76DE3B39D2FBC`. `scripts/verify_v2_release_evidence.py` validates its internal arithmetic and the local source pin. Independent live RPC replay is **UNPROVEN** because historical Studio-dev code and transaction requests returned HTTP 403 in this environment. Steward acceptance cannot be guaranteed.

The older [pending summary](evidence/2026-10-03-v2-approved-decision-evidence.PENDING.json) is retained for provenance and superseded by the exact export.

## Approved V2 task

| Field | Evidence |
| --- | --- |
| Task | `7e1974679cc5f3423573e8cf52b2446ed2a3de6bf4ad5415054f8532bf2c6352` |
| Create | `0x50c726e6de2cefec8e51a1a959d3ab89e200f454245a20fff2309a08a2315531` |
| Accept | `0x16f6e6aaa67e146d77c37b5c5bc8a7865bbab037361ce52ad5f9d32776cedabe` |
| Submit | `0x40dbd4d9ae0fab38eee711739520b678a9dee694e6387bcdbab6390e9b6face0` |
| Evaluate parent | `0xb8347951b9428e16edc3178d3915f89206c24ca28178b9f520f8eaa399365923`; FINALIZED, FINISHED_WITH_RETURN |
| Payout child | `0x045207e2ac7c0fc29de8bfd452ae3bcd51b7fe80ac13370a8fa24a3cea1e8682`; `value_credited=true`, triggered by parent |
| Transfer | Exact outgoing EthSend and credited child both show `500000000000000000` wei to the named translator |
| Fee | Actual `primary_fee_spent=126528500000823` wei; upfront quote `760927200010352` wei |
| Balances | Translator `+500000000000000000` wei; evaluator/funder `-126528500000823` wei |
| Library | Version 1, `v2.checkout.delivery.on_the_way` / `ES-ES`, linked to the same task and approved translation |

`payout_submitted` alone is not delivery or balance proof. The archive keeps these fields separate. Later wallet reads do not replace the saved before/after snapshots.

## Validation

| Check | Result |
| --- | --- |
| `npm.cmd test -- --reporter=dot` | PASS: 23 files, 302 tests |
| `npm.cmd run build` | PASS; existing Rollup annotation and large-chunk warnings |
| `python scripts/verify_v2_release_evidence.py` | PASS offline consistency; independent RPC replay UNPROVEN |
| `python scripts/verify_archived_public_evidence.py` | V1 archived arithmetic PASS, historical wallet-run YES; independent replay UNPROVEN with HTTP 403 (exit 2) |
| GenVM linter | PASS: V1 12 methods, V2 14 methods |
| Direct/integration Python suite | PASS: 67 passed, 1 skipped (live RPC) |
| Read-only local browser | V2 board and library loaded live records; no wallet action repeated |

Static hosting fallback files are `vercel.json` and `public/_redirects`. The final hosted domain still needs a direct deep-link load check. WalletConnect's public project ID must be set in the host **build** environment to show that option.

## Disclosures

- [C2 Lane A](evidence/2026-10-03-v2-phase-c2-lane-a-evidence.json) is a completed unaccepted cancel/refund wallet run.
- [C2 Lane B](evidence/2026-10-03-v2-phase-c2-lane-b-evidence.json) proves acceptance. Its separate expiry/refund remains **UNPROVEN**.
- WalletConnect QR display was checked; mobile pairing, network switch, and disconnect remain **untested**.
- Independent historical Studio-dev RPC replay remains **UNPROVEN** because of HTTP 403; the signing-browser export is preserved as historical evidence.
- Library pagination past 50 and malformed RPC pages are unit-tested but not live-scale tested.
- Hosted-domain behavior remains to be checked after deployment.

The [steward review matrix](STEWARDS_REVIEW_MATRIX.md) maps prior project feedback to V2 code, tests, and evidence. It is a preparation aid, not a promise of a review outcome.

## Steward walkthrough

1. Open `/`, `/v1`, and `/demo` to see the V2 default and separate historical lanes.
2. Open `/v2/tasks/7e1974679cc5f3423573e8cf52b2446ed2a3de6bf4ad5415054f8532bf2c6352/decision` and compare the stored decision to the exact archive.
3. Inspect the parent, outgoing transfer, credited child, actual receipt fee, and EOA deltas as separate fields.
4. Open `/v2/library` for the linked Spanish version; review the explicit unproven cases above.
