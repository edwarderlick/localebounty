"""Direct tests for LocaleBounty V2 acceptance lifecycle.

These tests are **not** live Studio-dev payout proof. EthSend credits come
only from the labeled ``DirectExternalTransfers`` test double after
``deliver_last()``. Direct mode runs the leader LLM path; validator votes
are exercised via ``direct_vm.run_validator()``.

V2 is not deployed. Public screens stay on ``contracts/localebounty.py``.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

from tests.direct.conftest import balance_of, credit_payable, set_balance

CONTRACT = "contracts/localebounty_v2.py"
ONE_GEN = 10**18
MIN_REVIEW = 60 * 60
APPROVE = json.dumps(
    {"meaning_preserved": True, "criteria_satisfied": True, "approved": True}
)
REJECT = json.dumps(
    {"meaning_preserved": False, "criteria_satisfied": False, "approved": False}
)
EVAL_RE = r".*independent translation evaluator.*"


def _now() -> int:
    return int(time.time())


def _deploy(direct_deploy):
    return direct_deploy(CONTRACT)


def _fields(translator, **overrides):
    base = {
        "client_nonce": "nonce-1",
        "source_text": "Save changes",
        "source_locale": "en",
        "target_locale": "es",
        "string_key": "btn.save",
        "app_context": "Desktop editor toolbar",
        "intended_meaning": "Persist the current document",
        "semantic_criteria": "Must be a short imperative, not a noun.",
        "translator": translator,
        "submit_by_unix": _now() + 3600,
        "recover_after_unix": _now() + 3600 + MIN_REVIEW,
    }
    base.update(overrides)
    return base


def _create(direct_vm, contract, funder, translator, amount=ONE_GEN, **overrides):
    direct_vm.sender = funder
    credit_payable(direct_vm, amount)
    return contract.create_task(**_fields(translator, **overrides))


def _accept(direct_vm, contract, translator, task_id):
    direct_vm.sender = translator
    contract.accept_task(task_id)


def _submit(direct_vm, contract, translator, task_id, text="Guardar cambios"):
    direct_vm.sender = translator
    contract.submit_translation(task_id, text)


def _accept_and_submit(direct_vm, contract, translator, task_id, text="Guardar cambios"):
    _accept(direct_vm, contract, translator, task_id)
    _submit(direct_vm, contract, translator, task_id, text)


def _mock_eval(direct_vm, payload=APPROVE):
    # Later mocks must replace earlier ones; gltest matches the first pattern.
    direct_vm._llm_mocks.clear()
    direct_vm.mock_llm(EVAL_RE, payload)


def _warp_unix(direct_vm, unix: int) -> None:
    stamp = datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    direct_vm.warp(stamp)


def _as_bytes(addr) -> bytes:
    if isinstance(addr, bytes):
        return addr
    if hasattr(addr, "as_bytes"):
        return addr.as_bytes
    return bytes(addr)


def _assert_eth_send(value_messages, recipient, amount):
    msg = value_messages.last()
    assert msg["channel"] == "EthSend"
    assert msg["emitted"] is True
    assert msg["value"] == amount
    assert msg["recipient"] == _as_bytes(recipient)
    assert msg["credit_is_test_double"] is True
    assert msg["delivered"] is False
    return msg


def _assert_escrow_cleared(direct_vm, contract):
    assert balance_of(direct_vm, contract.address) == 0


def test_create_task_is_open_unaccepted(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    before_alice = balance_of(direct_vm, direct_alice)
    task_id = _create(direct_vm, contract, direct_alice, direct_bob)
    task = contract.get_task(task_id)
    assert task["state"] == "open"
    assert task["accepted_at_unix"] == 0
    assert task["translation"] == ""
    assert task["decision"] == "none"
    assert task["payout_submitted"] is False
    assert task["reward"] == ONE_GEN
    assert task["funder"] == direct_alice.as_hex
    assert task["translator"] == direct_bob.as_hex
    assert balance_of(direct_vm, contract.address) == ONE_GEN
    assert balance_of(direct_vm, direct_alice) == before_alice - ONE_GEN
    compact = contract.list_tasks(0, 1)[0]
    assert compact["state"] == "open"
    assert compact["accepted_at_unix"] == 0
    assert "source_text" not in compact


def test_accept_task_by_named_translator_sets_accepted(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    task_id = _create(direct_vm, contract, direct_alice, direct_bob)
    escrow = balance_of(direct_vm, contract.address)
    before_bob = balance_of(direct_vm, direct_bob)
    _accept(direct_vm, contract, direct_bob, task_id)
    task = contract.get_task(task_id)
    assert task["state"] == "accepted"
    assert int(task["accepted_at_unix"]) > 0
    assert task["translation"] == ""
    assert task["payout_submitted"] is False
    assert task["payment_status"] == "none"
    assert balance_of(direct_vm, contract.address) == escrow
    assert balance_of(direct_vm, direct_bob) == before_bob
    assert value_messages.in_flight == []


def test_unauthorized_and_duplicate_acceptance(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    task_id = _create(direct_vm, contract, direct_alice, direct_bob)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("unauthorized translator"):
        contract.accept_task(task_id)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("unauthorized translator"):
        contract.accept_task(task_id)
    assert contract.get_task(task_id)["state"] == "open"
    _accept(direct_vm, contract, direct_bob, task_id)
    with direct_vm.expect_revert("accept not open"):
        contract.accept_task(task_id)
    assert contract.get_task(task_id)["state"] == "accepted"
    assert balance_of(direct_vm, contract.address) == ONE_GEN


def test_accept_deadline_is_strictly_before_submit_by(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    submit_by = _now() + 120
    task_id = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        submit_by_unix=submit_by,
        recover_after_unix=submit_by + MIN_REVIEW,
    )
    _warp_unix(direct_vm, submit_by - 1)
    _accept(direct_vm, contract, direct_bob, task_id)
    assert contract.get_task(task_id)["state"] == "accepted"

    late = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        client_nonce="accept-at-deadline",
        submit_by_unix=submit_by,
        recover_after_unix=submit_by + MIN_REVIEW,
    )
    _warp_unix(direct_vm, submit_by)
    with direct_vm.expect_revert("accept deadline passed"):
        _accept(direct_vm, contract, direct_bob, late)
    assert contract.get_task(late)["state"] == "open"
    _warp_unix(direct_vm, submit_by + 1)
    with direct_vm.expect_revert("accept deadline passed"):
        _accept(direct_vm, contract, direct_bob, late)


def test_funder_cancel_only_while_open_unaccepted(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    task_id = _create(direct_vm, contract, direct_alice, direct_bob)
    before_alice = balance_of(direct_vm, direct_alice)
    direct_vm.sender = direct_alice
    contract.cancel_task(task_id)
    task = contract.get_task(task_id)
    assert task["state"] == "cancelled"
    assert task["decision"] == "cancelled"
    assert task["payment_kind"] == "refund"
    _assert_eth_send(value_messages, direct_alice, ONE_GEN)
    _assert_escrow_cleared(direct_vm, contract)
    assert balance_of(direct_vm, direct_alice) == before_alice
    value_messages.deliver_last()
    assert balance_of(direct_vm, direct_alice) == before_alice + ONE_GEN


def test_cancel_versus_acceptance_ordering(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 20 * ONE_GEN)
    accepted_id = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="acc-first")
    _accept(direct_vm, contract, direct_bob, accepted_id)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("cancel not allowed"):
        contract.cancel_task(accepted_id)
    assert contract.get_task(accepted_id)["state"] == "accepted"
    assert balance_of(direct_vm, contract.address) == ONE_GEN

    cancelled_id = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="cancel-first")
    direct_vm.sender = direct_alice
    contract.cancel_task(cancelled_id)
    with direct_vm.expect_revert("accept not open"):
        _accept(direct_vm, contract, direct_bob, cancelled_id)
    assert contract.get_task(cancelled_id)["state"] == "cancelled"


def test_funder_cannot_cancel_accepted_during_submission_window(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    submit_by = _now() + 600
    task_id = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        submit_by_unix=submit_by,
        recover_after_unix=submit_by + MIN_REVIEW,
    )
    _accept(direct_vm, contract, direct_bob, task_id)
    _warp_unix(direct_vm, submit_by - 1)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("cancel not allowed"):
        contract.cancel_task(task_id)
    _warp_unix(direct_vm, submit_by)
    with direct_vm.expect_revert("cancel not allowed"):
        contract.cancel_task(task_id)
    assert contract.get_task(task_id)["state"] == "accepted"
    assert balance_of(direct_vm, contract.address) == ONE_GEN


def test_submit_requires_accepted_named_translator_and_inclusive_deadline(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    submit_by = _now() + 180
    task_id = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        submit_by_unix=submit_by,
        recover_after_unix=submit_by + MIN_REVIEW,
    )
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("submission not accepted"):
        contract.submit_translation(task_id, "Guardar cambios")
    _accept(direct_vm, contract, direct_bob, task_id)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("unauthorized translator"):
        contract.submit_translation(task_id, "Nope")
    _warp_unix(direct_vm, submit_by)
    _submit(direct_vm, contract, direct_bob, task_id)
    stored = contract.get_task(task_id)
    assert stored["state"] == "submitted"
    assert stored["submitted_at_unix"] == submit_by
    assert stored["translation"] == "Guardar cambios"
    with direct_vm.expect_revert("already submitted"):
        contract.submit_translation(task_id, "Otra")


def test_submit_versus_expiry_ordering_at_deadline_boundary(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 20 * ONE_GEN)
    submit_by = _now() + 90
    on_time = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        client_nonce="submit-at-deadline",
        submit_by_unix=submit_by,
        recover_after_unix=submit_by + MIN_REVIEW,
    )
    _warp_unix(direct_vm, submit_by - 1)
    _accept(direct_vm, contract, direct_bob, on_time)
    _warp_unix(direct_vm, submit_by)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("submission deadline not passed"):
        contract.expire_unsubmitted_task(on_time)
    _submit(direct_vm, contract, direct_bob, on_time)
    with direct_vm.expect_revert("already submitted"):
        contract.expire_unsubmitted_task(on_time)
    assert contract.get_task(on_time)["state"] == "submitted"
    assert balance_of(direct_vm, contract.address) == ONE_GEN

    late_submit_by = submit_by + 180
    late = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        client_nonce="expire-then-submit",
        submit_by_unix=late_submit_by,
        recover_after_unix=late_submit_by + MIN_REVIEW,
    )
    _warp_unix(direct_vm, late_submit_by - 1)
    _accept(direct_vm, contract, direct_bob, late)
    _warp_unix(direct_vm, late_submit_by + 1)
    with direct_vm.expect_revert("submission deadline passed"):
        _submit(direct_vm, contract, direct_bob, late)
    direct_vm.sender = direct_alice
    contract.expire_unsubmitted_task(late)
    with direct_vm.expect_revert("submission not accepted"):
        _submit(direct_vm, contract, direct_bob, late)
    assert contract.get_task(late)["state"] == "expired"
    _assert_eth_send(value_messages, direct_alice, ONE_GEN)


def test_expire_unsubmitted_open_or_accepted_after_deadline(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 20 * ONE_GEN)
    submit_by = _now() + 60
    open_id = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        client_nonce="expire-open",
        submit_by_unix=submit_by,
        recover_after_unix=submit_by + MIN_REVIEW,
    )
    accepted_id = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        client_nonce="expire-accepted",
        submit_by_unix=submit_by,
        recover_after_unix=submit_by + MIN_REVIEW,
    )
    _accept(direct_vm, contract, direct_bob, accepted_id)
    _warp_unix(direct_vm, submit_by)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("submission deadline not passed"):
        contract.expire_unsubmitted_task(open_id)
    with direct_vm.expect_revert("submission deadline not passed"):
        contract.expire_unsubmitted_task(accepted_id)
    _warp_unix(direct_vm, submit_by + 1)
    contract.expire_unsubmitted_task(open_id)
    assert contract.get_task(open_id)["state"] == "expired"
    _assert_eth_send(value_messages, direct_alice, ONE_GEN)
    contract.expire_unsubmitted_task(accepted_id)
    assert contract.get_task(accepted_id)["state"] == "expired"
    assert contract.get_task(accepted_id)["decision"] == "expired"
    assert contract.get_task(accepted_id)["payment_kind"] == "refund"
    _assert_eth_send(value_messages, direct_alice, ONE_GEN)
    _assert_escrow_cleared(direct_vm, contract)


def test_third_party_expire_refunds_stored_funder(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    set_balance(direct_vm, direct_charlie, 0)
    submit_by = _now() + 45
    task_id = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        submit_by_unix=submit_by,
        recover_after_unix=submit_by + MIN_REVIEW,
    )
    _accept(direct_vm, contract, direct_bob, task_id)
    _warp_unix(direct_vm, submit_by + 1)
    before_alice = balance_of(direct_vm, direct_alice)
    before_charlie = balance_of(direct_vm, direct_charlie)
    direct_vm.sender = direct_charlie
    contract.expire_unsubmitted_task(task_id)
    task = contract.get_task(task_id)
    assert task["state"] == "expired"
    _assert_eth_send(value_messages, direct_alice, ONE_GEN)
    assert balance_of(direct_vm, direct_charlie) == before_charlie
    value_messages.deliver_last()
    assert balance_of(direct_vm, direct_alice) == before_alice + ONE_GEN
    assert balance_of(direct_vm, direct_charlie) == before_charlie
    _assert_escrow_cleared(direct_vm, contract)


def test_approval_payout_after_accept_exact_translator_amount(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    set_balance(direct_vm, direct_bob, 0)
    task_id = _create(direct_vm, contract, direct_alice, direct_bob)
    _accept_and_submit(direct_vm, contract, direct_bob, task_id)
    stored = contract.get_task(task_id)
    assert stored["state"] == "submitted"
    assert stored["accepted_at_unix"] > 0
    _mock_eval(direct_vm)
    before_bob = balance_of(direct_vm, direct_bob)
    direct_vm.sender = direct_alice
    contract.evaluate_task(task_id)
    task = contract.get_task(task_id)
    assert task["state"] == "approved"
    assert task["decision"] == "approved"
    assert task["payment_status"] == "submitted"
    assert task["payment_kind"] == "payout"
    assert task["payout_submitted"] is True
    assert task["delivery_proven_onchain"] is False
    lib = contract.get_library_entry("btn.save", "es", 1)
    assert lib["task_id"] == task_id
    _assert_eth_send(value_messages, direct_bob, ONE_GEN)
    assert balance_of(direct_vm, direct_bob) == before_bob
    _assert_escrow_cleared(direct_vm, contract)
    value_messages.deliver_last()
    assert balance_of(direct_vm, direct_bob) == before_bob + ONE_GEN


def test_rejection_refunds_funder_exact_amount(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    task_id = _create(direct_vm, contract, direct_alice, direct_bob)
    _accept_and_submit(direct_vm, contract, direct_bob, task_id, "El botón")
    _mock_eval(direct_vm, REJECT)
    before_alice = balance_of(direct_vm, direct_alice)
    before_bob = balance_of(direct_vm, direct_bob)
    direct_vm.sender = direct_alice
    contract.evaluate_task(task_id)
    task = contract.get_task(task_id)
    assert task["state"] == "rejected"
    assert task["payment_kind"] == "refund"
    assert contract.library_version_count("btn.save", "es") == 0
    _assert_eth_send(value_messages, direct_alice, ONE_GEN)
    value_messages.deliver_last()
    assert balance_of(direct_vm, direct_alice) == before_alice + ONE_GEN
    assert balance_of(direct_vm, direct_bob) == before_bob
    _assert_escrow_cleared(direct_vm, contract)


def test_timeout_recovery_after_submit_refunds_funder(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    task_id = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        submit_by_unix=_now() + 60,
        recover_after_unix=_now() + 60 + MIN_REVIEW,
    )
    _accept_and_submit(direct_vm, contract, direct_bob, task_id)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("recovery too early"):
        contract.recover_undecided_task(task_id)
    with direct_vm.expect_revert("already submitted"):
        contract.expire_unsubmitted_task(task_id)
    direct_vm.warp("2027-01-15T00:00:00Z")
    contract.recover_undecided_task(task_id)
    task = contract.get_task(task_id)
    assert task["state"] == "timed_out"
    _assert_eth_send(value_messages, direct_alice, ONE_GEN)
    _assert_escrow_cleared(direct_vm, contract)


def test_failed_transfer_submission_reverts_every_settlement(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 30 * ONE_GEN)
    eval_id = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="fail-eval")
    _accept_and_submit(direct_vm, contract, direct_bob, eval_id)
    _mock_eval(direct_vm)
    value_messages.fail_submit = True
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("transfer submission failed"):
        contract.evaluate_task(eval_id)
    stuck = contract.get_task(eval_id)
    assert stuck["state"] == "submitted"
    assert stuck["decision"] == "none"
    assert stuck["payout_submitted"] is False
    assert balance_of(direct_vm, contract.address) >= ONE_GEN
    assert value_messages.in_flight == []

    cancel_id = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="fail-cancel")
    with direct_vm.expect_revert("transfer submission failed"):
        contract.cancel_task(cancel_id)
    assert contract.get_task(cancel_id)["state"] == "open"

    submit_by = _now() + 30
    expire_id = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        client_nonce="fail-expire",
        submit_by_unix=submit_by,
        recover_after_unix=submit_by + MIN_REVIEW,
    )
    _accept(direct_vm, contract, direct_bob, expire_id)
    _warp_unix(direct_vm, submit_by + 1)
    with direct_vm.expect_revert("transfer submission failed"):
        contract.expire_unsubmitted_task(expire_id)
    assert contract.get_task(expire_id)["state"] == "accepted"
    assert contract.get_task(expire_id)["payout_submitted"] is False


def test_duplicate_settlement_reverts(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    task_id = _create(direct_vm, contract, direct_alice, direct_bob)
    _accept_and_submit(direct_vm, contract, direct_bob, task_id)
    _mock_eval(direct_vm)
    direct_vm.sender = direct_alice
    contract.evaluate_task(task_id)
    with direct_vm.expect_revert("not submitted"):
        contract.evaluate_task(task_id)
    with direct_vm.expect_revert("already decided"):
        contract.recover_undecided_task(task_id)
    with direct_vm.expect_revert("cancel not allowed"):
        contract.cancel_task(task_id)
    with direct_vm.expect_revert("already submitted"):
        contract.expire_unsubmitted_task(task_id)
    assert len(value_messages.in_flight) == 1
    _assert_escrow_cleared(direct_vm, contract)


def test_validator_disagreement_on_decision_fields(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    task_id = _create(direct_vm, contract, direct_alice, direct_bob)
    _accept_and_submit(direct_vm, contract, direct_bob, task_id)
    _mock_eval(direct_vm, APPROVE)
    direct_vm.sender = direct_alice
    contract.evaluate_task(task_id)
    disagree = {
        "meaning_preserved": False,
        "criteria_satisfied": False,
        "approved": False,
    }
    assert direct_vm.run_validator(leader_result=disagree) is False
    shape_only = {"approved": True, "note": "looks fine"}
    assert direct_vm.run_validator(leader_result=shape_only) is False


def test_malformed_llm_keeps_escrow_after_accept(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    task_id = _create(direct_vm, contract, direct_alice, direct_bob)
    _accept_and_submit(direct_vm, contract, direct_bob, task_id)
    _mock_eval(direct_vm, "not-json")
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("malformed evaluator output"):
        contract.evaluate_task(task_id)
    task = contract.get_task(task_id)
    assert task["state"] == "submitted"
    assert task["payout_submitted"] is False
    assert balance_of(direct_vm, contract.address) == ONE_GEN
    assert value_messages.in_flight == []


def test_no_escrow_path_remains_stranded(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, value_messages
):
    """Every lock has a settlement that emits the stored reward to the state-derived recipient."""
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 100 * ONE_GEN)
    terminals = []

    def lock(**overrides):
        return _create(direct_vm, contract, direct_alice, direct_bob, **overrides)

    cancel_id = lock(client_nonce="path-cancel")
    direct_vm.sender = direct_alice
    contract.cancel_task(cancel_id)
    terminals.append(("cancelled", direct_alice, cancel_id))

    expire_open = lock(client_nonce="path-expire-open", submit_by_unix=_now() + 20, recover_after_unix=_now() + 20 + MIN_REVIEW)
    submit_by = int(contract.get_task(expire_open)["submit_by_unix"])
    _warp_unix(direct_vm, submit_by + 1)
    direct_vm.sender = direct_charlie
    contract.expire_unsubmitted_task(expire_open)
    terminals.append(("expired", direct_alice, expire_open))

    later = submit_by + 120
    expire_acc = lock(
        client_nonce="path-expire-acc",
        submit_by_unix=later,
        recover_after_unix=later + MIN_REVIEW,
    )
    _warp_unix(direct_vm, later - 10)
    _accept(direct_vm, contract, direct_bob, expire_acc)
    _warp_unix(direct_vm, later + 1)
    direct_vm.sender = direct_charlie
    contract.expire_unsubmitted_task(expire_acc)
    terminals.append(("expired", direct_alice, expire_acc))

    approve_at = later + 180
    approve_id = lock(
        client_nonce="path-approve",
        submit_by_unix=approve_at,
        recover_after_unix=approve_at + MIN_REVIEW,
    )
    _warp_unix(direct_vm, approve_at - 10)
    _accept_and_submit(direct_vm, contract, direct_bob, approve_id)
    _mock_eval(direct_vm)
    direct_vm.sender = direct_alice
    contract.evaluate_task(approve_id)
    terminals.append(("approved", direct_bob, approve_id))

    reject_at = approve_at + 180
    reject_id = lock(
        client_nonce="path-reject",
        submit_by_unix=reject_at,
        recover_after_unix=reject_at + MIN_REVIEW,
    )
    _warp_unix(direct_vm, reject_at - 10)
    _accept_and_submit(direct_vm, contract, direct_bob, reject_id, "bad")
    _mock_eval(direct_vm, REJECT)
    direct_vm.sender = direct_alice
    contract.evaluate_task(reject_id)
    terminals.append(("rejected", direct_alice, reject_id))

    timeout_at = reject_at + 180
    timeout_id = lock(
        client_nonce="path-timeout",
        submit_by_unix=timeout_at,
        recover_after_unix=timeout_at + MIN_REVIEW,
    )
    _warp_unix(direct_vm, timeout_at - 10)
    _accept_and_submit(direct_vm, contract, direct_bob, timeout_id)
    _warp_unix(direct_vm, timeout_at + MIN_REVIEW)
    direct_vm.sender = direct_charlie
    contract.recover_undecided_task(timeout_id)
    terminals.append(("timed_out", direct_alice, timeout_id))

    for state, recipient, task_id in terminals:
        task = contract.get_task(task_id)
        assert task["state"] == state
        assert task["payout_submitted"] is True
        assert task["delivery_proven_onchain"] is False
        assert task["reward"] == ONE_GEN
    _assert_escrow_cleared(direct_vm, contract)
    assert len(value_messages.in_flight) == len(terminals)
    for i, (_state, recipient, _task_id) in enumerate(terminals):
        msg = value_messages.in_flight[i]
        assert msg["recipient"] == _as_bytes(recipient)
        assert msg["value"] == ONE_GEN
        assert msg["emitted"] is True
        assert msg["delivered"] is False


def test_library_versions_increment_only_on_approval(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 20 * ONE_GEN)
    first = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="v1")
    _accept_and_submit(direct_vm, contract, direct_bob, first, "Guardar")
    _mock_eval(direct_vm)
    direct_vm.sender = direct_alice
    contract.evaluate_task(first)
    second = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="v2")
    _accept_and_submit(direct_vm, contract, direct_bob, second, "Guardar cambios")
    _mock_eval(direct_vm)
    direct_vm.sender = direct_alice
    contract.evaluate_task(second)
    rejected = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="v3")
    _accept_and_submit(direct_vm, contract, direct_bob, rejected, "bad")
    _mock_eval(direct_vm, REJECT)
    direct_vm.sender = direct_alice
    contract.evaluate_task(rejected)
    cancelled = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="v4")
    direct_vm.sender = direct_alice
    contract.cancel_task(cancelled)
    assert contract.library_version_count("btn.save", "es") == 2


def test_client_nonce_reuse_and_deterministic_ids(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    set_balance(direct_vm, direct_charlie, 10 * ONE_GEN)
    a = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="n-a")
    b = _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="n-b")
    assert a != b
    assert len(a) == 64
    with direct_vm.expect_revert("client_nonce reused"):
        _create(direct_vm, contract, direct_alice, direct_bob, client_nonce="n-a")
    other = _create(direct_vm, contract, direct_charlie, direct_bob, client_nonce="n-a")
    assert other != a


def test_zero_reward_and_zero_translator_rejected(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    zero = type(direct_alice)(b"\x00" * 20)
    direct_vm.sender = direct_alice
    credit_payable(direct_vm, 0)
    with direct_vm.expect_revert("zero value rejected"):
        contract.create_task(**_fields(direct_bob))
    credit_payable(direct_vm, ONE_GEN)
    with direct_vm.expect_revert("named translator required"):
        contract.create_task(**_fields(zero))


def test_submission_at_deadline_early_recovery_and_eval_order(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 20 * ONE_GEN)
    now = _now()
    submit_by = now + 120
    recover_after = submit_by + MIN_REVIEW
    last_minute = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        client_nonce="at-deadline",
        submit_by_unix=submit_by,
        recover_after_unix=recover_after,
    )
    _warp_unix(direct_vm, submit_by - 1)
    _accept(direct_vm, contract, direct_bob, last_minute)
    _warp_unix(direct_vm, submit_by)
    _submit(direct_vm, contract, direct_bob, last_minute)
    stored = contract.get_task(last_minute)
    assert stored["state"] == "submitted"
    assert stored["submitted_at_unix"] == submit_by
    assert stored["recovery_opens_at_unix"] == submit_by + MIN_REVIEW
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("recovery too early"):
        contract.recover_undecided_task(last_minute)
    _mock_eval(direct_vm)
    contract.evaluate_task(last_minute)
    assert contract.get_task(last_minute)["state"] == "approved"
    _warp_unix(direct_vm, submit_by + MIN_REVIEW)
    with direct_vm.expect_revert("already decided"):
        contract.recover_undecided_task(last_minute)

    later = submit_by + MIN_REVIEW + 10
    timeout_id = _create(
        direct_vm,
        contract,
        direct_alice,
        direct_bob,
        client_nonce="timeout-review",
        submit_by_unix=later + 60,
        recover_after_unix=later + 60 + MIN_REVIEW,
    )
    _warp_unix(direct_vm, later + 50)
    _accept(direct_vm, contract, direct_bob, timeout_id)
    _warp_unix(direct_vm, later + 60)
    _submit(direct_vm, contract, direct_bob, timeout_id)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("recovery too early"):
        contract.recover_undecided_task(timeout_id)
    _warp_unix(direct_vm, later + 60 + MIN_REVIEW - 1)
    with direct_vm.expect_revert("recovery too early"):
        contract.recover_undecided_task(timeout_id)
    _warp_unix(direct_vm, later + 60 + MIN_REVIEW)
    contract.recover_undecided_task(timeout_id)
    assert contract.get_task(timeout_id)["state"] == "timed_out"
    _assert_eth_send(value_messages, direct_alice, ONE_GEN)
