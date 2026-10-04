import { addressesEqual, isEoaAddress, isZeroAddress } from "../format";
import { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit } from "../guards";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import { createDeadlinesFromGenvm } from "../product/clock";
import { DEADLINE_STALE_SECONDS } from "../product/constants";
import { expectedTaskId, freshClientNonce } from "../product/taskId";
import { PRODUCT_UI_CONTRACT } from "./constants";
import { createFormErrors, formFingerprint, type CreateForm } from "./form";
import type { ProductUiSession } from "./persist";

export type GuardResult = { ok: true } | { ok: false; reason: string };

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

export { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit };

export type ProductUiWriteContext = {
  funder?: string;
  chainId?: number;
  connected: boolean;
};

export function productUiWalletReady(ctx: ProductUiWriteContext): GuardResult {
  if (!ctx.funder) {
    return fail(ctx.connected ? "Unlock the connected wallet. Tracking was not cleared." : "Connect a wallet first.");
  }
  if (!ctx.connected) return fail("Connect a wallet first.");
  if (ctx.chainId !== STUDIO_DEV_CHAIN_ID) {
    return fail(`Wrong chain (${ctx.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`);
  }
  return { ok: true };
}

export function productUiSessionCompatible(session: ProductUiSession, funder: string | undefined): GuardResult {
  if (!session.boundFunder) return { ok: true };
  if (!funder) {
    return fail(`Persisted create tracking is bound to funder ${session.boundFunder}. Connect that wallet.`);
  }
  if (!addressesEqual(session.boundFunder, funder)) {
    return fail(
      `Persisted create tracking is bound to funder ${session.boundFunder}. Connected ${funder} is a different account. Start a new create attempt after the previous hash is finished, or reconnect the original funder.`,
    );
  }
  return { ok: true };
}

export function createEstimateAllowed(session: ProductUiSession, ctx: ProductUiWriteContext, form: CreateForm): GuardResult {
  const ready = productUiWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.create)) {
    return fail(`Create already has transaction ID ${session.create.txId}. Resume tracking; do not resubmit.`);
  }
  if (!PRODUCT_UI_CONTRACT) return fail("Product contract address is missing.");
  const translator = form.translator.trim();
  if (!isEoaAddress(translator) || isZeroAddress(translator)) {
    return fail("Enter a valid named translator EOA.");
  }
  if (ctx.funder && addressesEqual(translator, ctx.funder)) {
    return fail("Named translator must be a different EOA than the connected funder.");
  }
  const errors = createFormErrors(form, ctx.funder);
  if (errors.length) return fail(errors[0] ?? "Form is incomplete.");
  return { ok: true };
}

export function createSignAllowed(session: ProductUiSession, ctx: ProductUiWriteContext, form: CreateForm): GuardResult {
  const estimate = createEstimateAllowed(session, ctx, form);
  if (!estimate.ok) return estimate;
  if (!session.clientNonce) {
    return fail("Estimate first so a client_nonce is bound to this unsubmitted create attempt.");
  }
  if (!session.expectedTaskId || session.submitByUnix == null || session.recoverAfterUnix == null) {
    return fail("Estimate first so deadlines and the nonce-derived task ID are bound before signing.");
  }
  if (session.formFingerprint && session.formFingerprint !== formFingerprint(form)) {
    return fail("Form values changed since the fee quote. Estimate again before signing.");
  }
  return { ok: true };
}

export function unsubmittedCreateNonce(session: ProductUiSession): string | undefined {
  if (session.create.txId) return undefined;
  return session.clientNonce;
}

export function buildCreateDeadlines(nowUnix: number): { submitByUnix: number; recoverAfterUnix: number } {
  return createDeadlinesFromGenvm(nowUnix);
}

export async function bindCreateEstimateIdentity(
  session: ProductUiSession,
  input: { funder: string; nonceFactory?: () => string; nowUnix: number; contract?: string },
): Promise<ProductUiSession> {
  if (session.create.txId) return session;
  const clientNonce = unsubmittedCreateNonce(session) ?? (input.nonceFactory ?? freshClientNonce)();
  const deadlines = buildCreateDeadlines(input.nowUnix);
  const contract = input.contract ?? PRODUCT_UI_CONTRACT;
  const expectedTaskIdValue = await expectedTaskId(input.funder, contract, clientNonce);
  return {
    ...session,
    clientNonce,
    submitByUnix: deadlines.submitByUnix,
    recoverAfterUnix: deadlines.recoverAfterUnix,
    expectedTaskId: expectedTaskIdValue,
  };
}

export function deadlinesStale(submitByUnix: number | undefined, nowUnix: number): boolean {
  if (submitByUnix == null) return true;
  return nowUnix + DEADLINE_STALE_SECONDS >= submitByUnix;
}

export function needsCreateTxResume(session: ProductUiSession): boolean {
  return Boolean(session.create.txId) && !isFinalizedSuccessful(session.create) && !isTerminalFailure(session.create);
}
