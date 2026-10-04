"""Focused direct tests for ExperimentalSettlementProbe (EOA external path).

These tests are **not** live Studio-dev payout proof. Direct mode does not
run consensus or ghost ``handleOp``. Wallet credits here come only from the
labeled ``DirectExternalTransfers`` test double after an explicit
``deliver_last()``.

Assertions distinguish:

* **emitted** — ``EthSend`` was recorded (external transfer message)
* **credited** — test-double ledger credited the recipient (not live GEN)
"""

from __future__ import annotations

from tests.direct.conftest import balance_of, credit_payable, set_balance

CONTRACT = "contracts/experimental/settlement_probe.py"
ONE_GEN = 10**18
HALF_GEN = 5 * 10**17


def _deploy(direct_deploy):
    return direct_deploy(CONTRACT)


def _lock(direct_vm, contract, funder, named, amount):
    direct_vm.sender = funder
    credit_payable(direct_vm, amount)
    contract.lock(named)


def _as_bytes(addr) -> bytes:
    if isinstance(addr, bytes):
        return addr
    if hasattr(addr, "as_bytes"):
        return addr.as_bytes
    return bytes(addr)


def _assert_eoa_eth_send_emitted(value_messages, recipient, amount):
    msg = value_messages.last()
    assert msg["channel"] == "EthSend"
    assert msg["emitted"] is True
    assert msg["value"] == amount
    assert msg["recipient"] == _as_bytes(recipient)
    assert msg["credit_is_test_double"] is True
    return msg


def test_positive_release_emits_eth_send_then_test_double_credits_named_wallet(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    set_balance(direct_vm, direct_bob, 0)
    _lock(direct_vm, contract, direct_alice, direct_bob, ONE_GEN)

    before_bob = balance_of(direct_vm, direct_bob)
    before_alice = balance_of(direct_vm, direct_alice)
    before_contract = balance_of(direct_vm, contract.address)

    contract.release_to_named_wallet()

    snap = contract.get_snapshot()
    assert snap["payout_channel"] == "eoa_external_eth_send"
    assert snap["payout_api"] == "gl.evm.contract_interface.emit_transfer"
    assert snap["locked"] is True
    assert snap["payout_submitted"] is True
    assert snap["payout_kind"] == "release"
    assert snap["locked_amount"] == ONE_GEN
    assert snap["claim_cleared"] is False
    assert snap["delivery_proven_onchain"] is False
    assert contract.is_claim_cleared() is False

    msg = _assert_eoa_eth_send_emitted(value_messages, direct_bob, ONE_GEN)
    assert msg["delivered"] is False
    # Emit is not credit.
    assert balance_of(direct_vm, direct_bob) == before_bob
    assert balance_of(direct_vm, direct_alice) == before_alice
    assert balance_of(direct_vm, contract.address) == before_contract - ONE_GEN

    # Test-double credit only. Not live Studio-dev evidence.
    value_messages.deliver_last()
    assert msg["delivered"] is True
    assert balance_of(direct_vm, direct_bob) == before_bob + ONE_GEN
    assert balance_of(direct_vm, direct_alice) == before_alice


def test_positive_refund_emits_eth_send_then_test_double_credits_funder(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    set_balance(direct_vm, direct_bob, 7)
    _lock(direct_vm, contract, direct_alice, direct_bob, HALF_GEN)

    before_alice = balance_of(direct_vm, direct_alice)
    before_bob = balance_of(direct_vm, direct_bob)

    contract.refund_to_funder()

    snap = contract.get_snapshot()
    assert snap["payout_kind"] == "refund"
    assert snap["payout_submitted"] is True
    assert snap["claim_cleared"] is False
    assert snap["locked_amount"] == HALF_GEN
    assert snap["payout_channel"] == "eoa_external_eth_send"

    msg = _assert_eoa_eth_send_emitted(value_messages, direct_alice, HALF_GEN)
    assert msg["delivered"] is False
    assert balance_of(direct_vm, direct_alice) == before_alice
    assert balance_of(direct_vm, direct_bob) == before_bob
    assert balance_of(direct_vm, contract.address) == 0

    value_messages.deliver_last()
    assert balance_of(direct_vm, direct_alice) == before_alice + HALF_GEN
    assert balance_of(direct_vm, direct_bob) == before_bob


def test_unauthorized_release_and_refund_revert(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    _lock(direct_vm, contract, direct_alice, direct_bob, ONE_GEN)

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("unauthorized"):
        contract.release_to_named_wallet()
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("unauthorized"):
        contract.refund_to_funder()

    snap = contract.get_snapshot()
    assert snap["payout_submitted"] is False
    assert snap["claim_cleared"] is False
    assert snap["locked_amount"] == ONE_GEN
    assert balance_of(direct_vm, contract.address) == ONE_GEN
    assert value_messages.in_flight == []


def test_zero_value_lock_rejected(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    direct_vm.sender = direct_alice
    credit_payable(direct_vm, 0)
    with direct_vm.expect_revert("zero value rejected"):
        contract.lock(direct_bob)
    snap = contract.get_snapshot()
    assert snap["locked"] is False
    assert snap["locked_amount"] == 0


def test_zero_named_wallet_rejected(
    direct_vm, direct_deploy, direct_alice, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    zero = type(direct_alice)(b"\x00" * 20)
    direct_vm.sender = direct_alice
    before = balance_of(direct_vm, direct_alice)
    credit_payable(direct_vm, ONE_GEN)
    with direct_vm.expect_revert("named wallet required"):
        contract.lock(zero)
    # Payable credit is not rolled back by the contract (the protocol would
    # revert the whole tx). Restore the test ledger to match a reverted call.
    set_balance(direct_vm, direct_alice, before)
    set_balance(direct_vm, contract.address, 0)
    assert contract.get_snapshot()["locked"] is False


def test_cannot_lock_twice(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    _lock(direct_vm, contract, direct_alice, direct_bob, ONE_GEN)
    credit_payable(direct_vm, ONE_GEN)
    with direct_vm.expect_revert("claim already used"):
        contract.lock(direct_bob)


def test_no_double_release(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    _lock(direct_vm, contract, direct_alice, direct_bob, ONE_GEN)
    contract.release_to_named_wallet()
    _assert_eoa_eth_send_emitted(value_messages, direct_bob, ONE_GEN)
    with direct_vm.expect_revert("payout already submitted"):
        contract.release_to_named_wallet()
    with direct_vm.expect_revert("payout already submitted"):
        contract.refund_to_funder()
    assert contract.get_snapshot()["claim_cleared"] is False
    assert len(value_messages.in_flight) == 1
    # Still not credited until the test double delivers.
    assert balance_of(direct_vm, direct_bob) == 0


def test_no_double_refund(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    _lock(direct_vm, contract, direct_alice, direct_bob, ONE_GEN)
    contract.refund_to_funder()
    with direct_vm.expect_revert("payout already submitted"):
        contract.refund_to_funder()
    with direct_vm.expect_revert("payout already submitted"):
        contract.release_to_named_wallet()
    assert len(value_messages.in_flight) == 1
    assert value_messages.last()["delivered"] is False


def test_transfer_submission_failure_does_not_clear_claim(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    _lock(direct_vm, contract, direct_alice, direct_bob, ONE_GEN)

    value_messages.fail_submit = True
    with direct_vm.expect_revert("transfer submission failed"):
        contract.release_to_named_wallet()

    snap = contract.get_snapshot()
    assert snap["payout_submitted"] is False
    assert snap["payout_kind"] == ""
    assert snap["locked"] is True
    assert snap["claim_cleared"] is False
    assert snap["locked_amount"] == ONE_GEN
    assert balance_of(direct_vm, contract.address) == ONE_GEN
    assert balance_of(direct_vm, direct_bob) == 0
    assert value_messages.in_flight == []


def test_insufficient_contract_balance_is_submission_failure(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    _lock(direct_vm, contract, direct_alice, direct_bob, ONE_GEN)
    set_balance(direct_vm, contract.address, 0)

    with direct_vm.expect_revert("transfer submission failed"):
        contract.release_to_named_wallet()

    snap = contract.get_snapshot()
    assert snap["payout_submitted"] is False
    assert snap["claim_cleared"] is False
    assert snap["locked_amount"] == ONE_GEN
    assert value_messages.in_flight == []


def test_emitted_external_message_is_not_wallet_credit_and_does_not_clear_claim(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    """Emit ≠ credit. Scope: direct-mode test double only.

    This does **not** prove official EOA failure behavior, and it is not the
    IC-child ``PostMessage`` rule (failed child does not auto-return).
    """
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    _lock(direct_vm, contract, direct_alice, direct_bob, ONE_GEN)

    contract.release_to_named_wallet()

    snap = contract.get_snapshot()
    assert snap["payout_submitted"] is True
    assert snap["payout_kind"] == "release"
    assert snap["claim_cleared"] is False
    assert snap["delivery_proven_onchain"] is False
    assert contract.is_delivery_proven_onchain() is False
    assert balance_of(direct_vm, contract.address) == 0
    assert balance_of(direct_vm, direct_bob) == 0
    msg = value_messages.last()
    assert msg["channel"] == "EthSend"
    assert msg["emitted"] is True
    assert msg["delivered"] is False
    assert msg["value"] == ONE_GEN

    with direct_vm.expect_revert("payout already submitted"):
        contract.release_to_named_wallet()
    assert balance_of(direct_vm, direct_bob) == 0
    assert balance_of(direct_vm, contract.address) == 0
    assert len(value_messages.in_flight) == 1


def test_exact_lock_amount_is_message_value_not_a_parameter(
    direct_vm, direct_deploy, direct_alice, direct_bob, value_messages
):
    contract = _deploy(direct_deploy)
    set_balance(direct_vm, direct_alice, 10 * ONE_GEN)
    _lock(direct_vm, contract, direct_alice, direct_bob, 123456789)
    assert contract.get_locked_amount() == 123456789
    assert contract.get_snapshot()["named_wallet"].lower() == direct_bob.as_hex.lower()
    assert contract.get_snapshot()["funder"].lower() == direct_alice.as_hex.lower()
    assert contract.get_snapshot()["payout_channel"] == "eoa_external_eth_send"
