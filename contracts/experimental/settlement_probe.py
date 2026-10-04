# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
"""EXPERIMENTAL — LocaleBounty Backend Step 1 settlement probe.

This is not the LocaleBounty product contract. It exists only to prove whether
a funder can lock a fixed GEN amount for one named **EOA wallet** and then
either:

* release that exact amount to the named wallet, or
* refund that exact amount to the funder

on the Consensus v0.6 / Studio-dev stack.

Verified against the pinned runner's stdlib (py-lib-genlayer-std
``11rhn002yfajawsz7fai6mykznbxkxs6l91iskj5cm82c92qhy3v``) and official
Value Transfers / Messages docs:

* IC → IC is an **internal** message:
  ``gl.get_contract_at(addr).emit_transfer(value=..., on='finalized')``
  → ``PostMessage``. Failed IC child does not auto-return value.
* IC → EOA is an **external** message:
  ``@gl.evm.contract_interface`` + ``emit_transfer(value=...)``
  → ``EthSend`` (empty calldata, value). Always finalized. Not the IC-child path.

This probe pays **EOA wallets** (funder and named recipient), so it uses the
external ``EthSend`` path. It does not use ``get_contract_at`` for payout.

``payout_submitted`` means an external transfer message was emitted. It is
not proof the EOA was credited. The claim is never cleared on emit. This
contract does not invent a credit fallback.
"""

import genlayer as gl
from genlayer import *


_ZERO = Address(b"\x00" * 20)


@gl.evm.contract_interface
class _EoaWallet:
    """Empty EVM interface: official syntax for sending GEN to an EOA.

    Pinned stdlib (``genlayer/gl/_internal/eth.py``) implements
    ``emit_transfer`` as ``EthSend`` with empty calldata and ``value``.
    """

    class View:
        pass

    class Write:
        pass


class ExperimentalSettlementProbe(gl.contract.Contract):
    funder: Address
    named_wallet: Address
    locked_amount: u256
    locked: bool
    payout_submitted: bool
    payout_kind: str

    def __init__(self):
        self.funder = _ZERO
        self.named_wallet = _ZERO
        self.locked_amount = u256(0)
        self.locked = False
        self.payout_submitted = False
        self.payout_kind = ""

    def _only_funder(self) -> None:
        if gl.message.sender_address != self.funder:
            raise gl.vm.UserError("unauthorized")

    def _require_open_lock(self) -> None:
        if not self.locked:
            raise gl.vm.UserError("no locked claim")
        if self.payout_submitted:
            raise gl.vm.UserError("payout already submitted")

    def _submit_exact_eoa_transfer(self, recipient: Address) -> None:
        amount = self.locked_amount
        if amount == u256(0):
            raise gl.vm.UserError("zero value rejected")
        if self.balance < amount:
            raise gl.vm.UserError("transfer submission failed")
        # External message to an EOA. Do not treat emit as settlement.
        _EoaWallet(recipient).emit_transfer(value=amount)
        self.payout_submitted = True

    @gl.public.write.payable
    def lock(self, named_wallet: Address) -> None:
        if self.locked or self.payout_submitted:
            raise gl.vm.UserError("claim already used")
        value = gl.message.value
        if value == u256(0):
            raise gl.vm.UserError("zero value rejected")
        if named_wallet == _ZERO:
            raise gl.vm.UserError("named wallet required")
        self.funder = gl.message.sender_address
        self.named_wallet = named_wallet
        self.locked_amount = value
        self.locked = True
        self.payout_submitted = False
        self.payout_kind = ""

    @gl.public.write
    def release_to_named_wallet(self) -> None:
        self._only_funder()
        self._require_open_lock()
        self._submit_exact_eoa_transfer(self.named_wallet)
        self.payout_kind = "release"

    @gl.public.write
    def refund_to_funder(self) -> None:
        self._only_funder()
        self._require_open_lock()
        self._submit_exact_eoa_transfer(self.funder)
        self.payout_kind = "refund"

    @gl.public.view
    def get_snapshot(self) -> dict:
        return {
            "funder": self.funder.as_hex,
            "named_wallet": self.named_wallet.as_hex,
            "locked_amount": int(self.locked_amount),
            "locked": self.locked,
            "payout_submitted": self.payout_submitted,
            "payout_kind": self.payout_kind,
            "payout_channel": "eoa_external_eth_send",
            "payout_api": "gl.evm.contract_interface.emit_transfer",
            "claim_cleared": False,
            "delivery_proven_onchain": False,
            "contract_balance": int(self.balance),
        }

    @gl.public.view
    def get_locked_amount(self) -> u256:
        return self.locked_amount

    @gl.public.view
    def is_claim_cleared(self) -> bool:
        # Never true. An emitted EthSend is not settlement.
        return False

    @gl.public.view
    def is_delivery_proven_onchain(self) -> bool:
        return False
