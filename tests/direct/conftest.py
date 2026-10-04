"""Direct-mode helpers for the experimental settlement probe.

This is a **labeled test double**, not live payout proof and not GenVM consensus.

Pinned-runner EOA payouts emit ``EthSend`` (``@gl.evm.contract_interface`` /
``emit_transfer``). IC-to-IC payouts emit ``PostMessage``. Direct mode does
not execute either; without a hook ``gl_call`` returns ``2**32-1`` and emit
is a silent no-op.

The hook records "external transfer message emitted" separately from
"recipient wallet actually credited". Credit is applied only when a test
calls ``deliver_last()``. That credit is a test-double ledger update. It
must never be reported as Studio-dev settlement evidence.

This double does **not** claim to model official EOA failure semantics.
The IC-child rule (failed child does not auto-return value) applies to
internal ``PostMessage`` paths, not to this EOA ``EthSend`` probe.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from gltest.direct import loader as gl_loader
from gltest.direct import sdk_compat
from gltest.direct import vm as gl_vm
from gltest.direct import wasi_mock
from gltest.direct.sdk_loader import setup_sdk_paths
from gltest.direct.wasi_mock import ContractRollback

_CONTRACT = (
    Path(__file__).resolve().parents[2]
    / "contracts"
    / "experimental"
    / "settlement_probe.py"
)

# Cached consensus-v0.6 RC bundle. Avoids GitHub rate-limits during setup_sdk_paths.
os.environ.setdefault("GENVM_VERSION", "v0.6.0-rc7")


def _purge_empty_genlayer() -> None:
    """Drop an empty or stale genlayer import, including the fake genlayer.py shim."""
    mod = sys.modules.get("genlayer")
    keep_real = (
        mod is not None
        and getattr(mod, "__file__", None)
        and hasattr(mod, "Address")
        and (hasattr(mod, "gl") or hasattr(mod, "contract") or hasattr(mod, "types"))
    )
    if not keep_real:
        for key in list(sys.modules):
            if key == "genlayer" or key.startswith("genlayer."):
                del sys.modules[key]
        return
    py = sys.modules.get("genlayer.py")
    if py is not None and getattr(py, "__file__", None) is None:
        for key in list(sys.modules):
            if key == "genlayer.py" or key.startswith("genlayer.py."):
                del sys.modules[key]


def _import_calldata():
    try:
        from genlayer.py import calldata
    except ModuleNotFoundError:
        import genlayer.calldata as calldata

    return calldata


def _import_types():
    try:
        import genlayer.types as sdk_types

        if hasattr(sdk_types, "Address"):
            return sdk_types
    except ModuleNotFoundError:
        pass
    import genlayer.py.types as sdk_types

    return sdk_types


def _import_address():
    return _import_types().Address


def _import_address_u256():
    types = _import_types()
    return types.Address, types.u256


def _import_lazy():
    return _import_types().Lazy


def _allocate_contract(contract_cls, vm, *args, **kwargs):  # noqa: ARG001
    """Allocate storage for either stdlib layout (py.storage or storage)."""
    try:
        from genlayer.py.storage import inmem_allocate
    except ModuleNotFoundError:
        from genlayer.storage import inmem_allocate

    return inmem_allocate(contract_cls, *args, **kwargs)


def _as_address(value: Any):
    if value is None:
        return None
    Address = _import_address()
    if isinstance(value, Address):
        return value
    if isinstance(value, bytes):
        return Address(value)
    if hasattr(value, "as_bytes"):
        return Address(value.as_bytes)
    return value


def _refresh_gl_message(self) -> None:
    """Keep message context in sync for both stdlib layouts."""
    Address, u256 = _import_address_u256()
    sender = _as_address(self.sender)
    origin = _as_address(self.origin)
    contract_addr = _as_address(self._contract_address)
    value = u256(self._value)
    chain_id = u256(self._chain_id)
    if contract_addr is None:
        contract_addr = Address(b"\x00" * 20)

    try:
        import genlayer.message as msg_mod
    except Exception:
        msg_mod = sys.modules.get("genlayer.message")
    if msg_mod is not None:
        if sender is not None:
            msg_mod.sender_address = sender
        if origin is not None:
            msg_mod.origin_address = origin
        msg_mod.contract_address = contract_addr
        msg_mod.value = value
        msg_mod.chain_id = chain_id
        raw = getattr(msg_mod, "raw", None)
        if isinstance(raw, dict):
            if sender is not None:
                raw["sender_address"] = sender.as_bytes
            if origin is not None:
                raw["origin_address"] = origin.as_bytes
            raw["contract_address"] = contract_addr.as_bytes
            raw["value"] = int(value)
            raw["chain_id"] = int(chain_id)

    gl_mod = sys.modules.get("genlayer.gl")
    if gl_mod is None:
        return
    raw = getattr(gl_mod, "message_raw", None)
    if isinstance(raw, dict):
        if sender is not None:
            raw["sender_address"] = sender
        if origin is not None:
            raw["origin_address"] = origin
        if contract_addr is not None:
            raw["contract_address"] = contract_addr
        raw["value"] = value
        raw["chain_id"] = chain_id

    if sender is None or origin is None:
        return
    if hasattr(gl_mod, "MessageType"):
        gl_mod.message = gl_mod.MessageType(
            contract_address=contract_addr,
            sender_address=sender,
            origin_address=origin,
            value=value,
            chain_id=chain_id,
        )


def _encode_address_cls():
    """Address class captured by the active calldata encoder.

    Direct tests can hold Address instances from a previous stdlib import.
    ``calldata.encode`` only accepts *its* Address class.
    """
    calldata = _import_calldata()
    captured = getattr(calldata.encode, "__globals__", {}).get("Address")
    if captured is not None:
        return captured
    return _import_address()


def _to_encode_address(value):
    Address = _encode_address_cls()
    if value is None:
        return Address(b"\x00" * 20)
    if isinstance(value, Address):
        return value
    if isinstance(value, bytes):
        return Address(value)
    if hasattr(value, "as_bytes"):
        return Address(bytes(value.as_bytes))
    return Address(value)


def _inject_message_to_fd0(vm) -> None:
    """Inject message context using the encoder's Address class."""
    import os
    import tempfile

    try:
        calldata = _import_calldata()
    except ImportError:
        return

    message_data = {
        "contract_address": _to_encode_address(vm._contract_address),
        "sender_address": _to_encode_address(vm.sender),
        "origin_address": _to_encode_address(vm.origin),
        "stack": [],
        "value": int(vm._value),
        "datetime": vm._datetime,
        "is_init": False,
        "chain_id": int(vm._chain_id),
        "entry_kind": 0,
        "entry_data": b"",
        "entry_stage_data": None,
    }
    encoded = calldata.encode(message_data)

    fd, path = tempfile.mkstemp()
    try:
        os.write(fd, encoded)
        os.lseek(fd, 0, os.SEEK_SET)
        original_stdin = os.dup(0)
        vm._original_stdin_fd = original_stdin
        os.dup2(fd, 0)
    finally:
        os.close(fd)
        try:
            os.unlink(path)
        except PermissionError:
            pass


def _handle_llm_request_keep_text(vm, data):
    """Return LLM mocks as strings.

    Current Studio-dev ``exec_prompt`` decodes ``ok`` as text (or JSON *text*).
    gltest-direct auto-parses JSON mocks into dicts, which the new decoder
    rejects. Keep the mock body as a string so both formats work.
    """
    prompt = data.get("prompt", "")
    response = vm._match_llm_mock(prompt)
    if response is not None:
        if not isinstance(response, str):
            response = json.dumps(response)
        return {"ok": response}

    strict = getattr(vm, "_strict_mock_mode", False)
    if strict:
        registered = [p.pattern for p, _ in vm._llm_mocks]
        raise wasi_mock.MockNotFoundError(
            f"[strict] No LLM mock for prompt: {prompt[:100]}...\n"
            f"  Registered: {registered or '(none)'}"
        )

    live_handler = getattr(vm, "_live_llm_handler", None)
    if live_handler is not None:
        return live_handler(data)

    registered = [p.pattern for p, _ in vm._llm_mocks]
    raise wasi_mock.MockNotFoundError(
        f"No LLM mock for prompt: {prompt[:100]}...\n"
        f"  Registered: {registered or '(none)'}"
    )


_ORIG_HANDLE_GL_CALL = wasi_mock._handle_gl_call


def _handle_gl_call_with_timestamp(vm, request):
    if isinstance(request, dict) and "GetTimestamp" in request:
        raw = getattr(vm, "_datetime", None) or ""
        try:
            dt = _dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            dt = _dt.datetime.now(_dt.timezone.utc)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        return int(dt.timestamp())
    return _ORIG_HANDLE_GL_CALL(vm, request)


def _patch_sdk_compat() -> None:
    """gltest-direct 0.30 expects genlayer.calldata / genlayer.types.

    The pinned runner stdlib (11rhn002) exposes those as genlayer.py.calldata
    and genlayer.py.types. Without this shim, message injection is skipped
    and ``gl.Contract`` reads an empty stdin. Allocation also uses
    ``genlayer.storage`` which this runner does not ship.
    """
    for module in (sdk_compat, gl_loader, wasi_mock, gl_vm):
        if hasattr(module, "import_calldata"):
            module.import_calldata = _import_calldata
        if hasattr(module, "import_address"):
            module.import_address = _import_address
        if hasattr(module, "import_types"):
            module.import_types = _import_types
        if hasattr(module, "import_address_u256"):
            module.import_address_u256 = _import_address_u256
        if hasattr(module, "import_lazy"):
            module.import_lazy = _import_lazy
    gl_loader._allocate_contract = _allocate_contract
    gl_loader._inject_message_to_fd0 = _inject_message_to_fd0
    gl_vm.VMContext._refresh_gl_message = _refresh_gl_message
    wasi_mock._handle_llm_request = _handle_llm_request_keep_text
    wasi_mock._handle_gl_call = _handle_gl_call_with_timestamp
    try:
        import types as _types

        import genlayer.calldata as _calldata
        import genlayer.types as _types_mod

        fake_py = sys.modules.get("genlayer.py")
        if fake_py is None or getattr(fake_py, "__file__", None) is None:
            fake_py = _types.ModuleType("genlayer.py")
            fake_py.calldata = _calldata
            fake_py.types = _types_mod
            sys.modules["genlayer.py"] = fake_py
            sys.modules["genlayer.py.calldata"] = _calldata
            sys.modules["genlayer.py.types"] = _types_mod
        _install_encode_address_coercion(_calldata)
    except Exception:
        pass
    try:
        import genlayer._internal.on_chain.gl_call as on_chain_gl_call

        on_chain_gl_call._imp_raw = wasi_mock.gl_call
    except Exception:
        pass
    try:
        import genlayer.contract as contract_mod

        # Studio-dev stdlib imports wasi only when IS_IN_VM. Direct tests are
        # not in the VM, so Contract.balance would NameError without this.
        contract_mod.wasi = wasi_mock
    except Exception:
        pass


def _install_encode_address_coercion(calldata) -> None:
    orig = calldata.encode
    if getattr(orig, "_lb_coerced", False):
        return
    Address = orig.__globals__.get("Address")
    if Address is None:
        return
    default_param = calldata.encode_default_parameter

    def _coerce(value):
        value = default_param(value)
        if type(value).__name__ == "Address" and not isinstance(value, Address):
            raw = getattr(value, "as_bytes", None)
            if raw is not None:
                return Address(bytes(raw))
        return value

    def encode(x, /, *, default=_coerce):
        if default is _coerce:
            return orig(x, default=_coerce)

        def wrapped(value):
            value = default(value)
            if type(value).__name__ == "Address" and not isinstance(value, Address):
                raw = getattr(value, "as_bytes", None)
                if raw is not None:
                    return Address(bytes(raw))
            return value

        return orig(x, default=wrapped)

    encode._lb_coerced = True
    calldata.encode = encode


def _pin_runner_stdlib() -> None:
    """Make the pinned ``py-lib-genlayer-std`` win over site-packages."""
    _purge_empty_genlayer()
    setup_sdk_paths(_CONTRACT)
    _purge_empty_genlayer()
    _patch_sdk_compat()
    # Force genlayer.gl to re-read fd 0 after the loader injects the message.
    for key in (
        "genlayer.gl",
        "genlayer._internal.msg",
        "genlayer.gl.genvm_contracts",
    ):
        sys.modules.pop(key, None)


_pin_runner_stdlib()


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):  # noqa: ARG001
    # VM teardown removes gltest-direct paths; restore them before fixtures.
    _pin_runner_stdlib()


def _addr_bytes(vm, addr: Any) -> bytes:
    return vm._to_bytes(addr)


def balance_of(vm, addr: Any) -> int:
    return vm._balances.get(_addr_bytes(vm, addr), 0)


def set_balance(vm, addr: Any, amount: int) -> None:
    vm.deal(addr, amount)


@dataclass
class DirectExternalTransfers:
    """Test double for EOA ``EthSend``. Not live proof.

    ``auto_deliver`` defaults to False so emit and credit stay distinct.
    """

    vm: Any
    fail_submit: bool = False
    auto_deliver: bool = False
    in_flight: list[dict] = field(default_factory=list)

    def install(self) -> "DirectExternalTransfers":
        self.vm._gl_call_hook = self
        return self

    def __call__(self, vm, request):
        channel = None
        data = None
        if "EthSend" in request:
            channel = "EthSend"
            data = request["EthSend"]
        elif "EmitExternalMessage" in request:
            # Studio-dev runner kzr02ndm encodes EOA emit_transfer as this.
            # Live Studio-dev receipts still mark the child as is_eth_send.
            channel = "EthSend"
            data = request["EmitExternalMessage"]
        elif "PostMessage" in request:
            channel = "PostMessage"
            data = request["PostMessage"]
        elif "EmitInternalMessage" in request:
            channel = "EmitInternalMessage"
            data = request["EmitInternalMessage"]
        else:
            return None
        value = int(data.get("value") or 0)
        if self.fail_submit:
            raise ContractRollback("transfer submission failed")
        if value <= 0:
            raise ContractRollback("zero value rejected")

        contract_key = _addr_bytes(vm, vm._contract_address)
        available = vm._balances.get(contract_key, 0)
        if value > available:
            raise ContractRollback("transfer submission failed")

        # Test-double ledger: hold value out of the contract on emit.
        # Recipient credit is a separate, explicit step.
        vm._balances[contract_key] = available - value
        recipient = _addr_bytes(vm, data["address"])
        message = {
            "channel": channel,
            "recipient": recipient,
            "value": value,
            "emitted": True,
            "delivered": False,
            "credit_is_test_double": True,
        }
        self.in_flight.append(message)
        if self.auto_deliver:
            self.deliver_last()
        return {"ok": None}

    def deliver_last(self) -> None:
        """Apply the test-double credit. Not a Studio-dev payout."""
        if not self.in_flight:
            raise AssertionError("no in-flight transfer to deliver")
        message = self.in_flight[-1]
        if message["delivered"]:
            return
        recipient = message["recipient"]
        self.vm._balances[recipient] = (
            self.vm._balances.get(recipient, 0) + message["value"]
        )
        message["delivered"] = True

    def last(self) -> dict:
        if not self.in_flight:
            raise AssertionError("no external transfer message emitted")
        return self.in_flight[-1]


def credit_payable(vm, amount: int) -> None:
    """Move ``amount`` from the current sender into the contract, as a payable call does."""
    sender = _addr_bytes(vm, vm.sender)
    contract = _addr_bytes(vm, vm._contract_address)
    sender_bal = vm._balances.get(sender, 0)
    if amount > sender_bal:
        raise AssertionError(
            f"test funder has {sender_bal}, needs {amount} to lock"
        )
    if amount:
        vm._balances[sender] = sender_bal - amount
        vm._balances[contract] = vm._balances.get(contract, 0) + amount
    vm.value = amount


@pytest.fixture
def value_messages(direct_vm) -> DirectExternalTransfers:
    return DirectExternalTransfers(direct_vm).install()
