/** Clear transient get_task UI errors after a later successful read. Preserve historical Copy JSON. */

export function isGetTaskPrefixedError(error?: string): boolean {
  return typeof error === "string" && error.startsWith("get_task");
}

export function clearGetTaskPrefixedError<T extends { error?: string }>(action: T): T {
  if (!isGetTaskPrefixedError(action.error)) return action;
  return { ...action, error: undefined };
}

/** Receipt RPC failure stays; a successful get_task drops a stale get_task error. */
export function errorAfterSuccessfulRefresh(input: {
  receiptError?: string;
  getTaskOk: boolean;
  getTaskError?: string;
}): string | undefined {
  if (input.receiptError) return input.receiptError;
  if (input.getTaskOk) return undefined;
  return input.getTaskError;
}

export function clearStaleGetTaskErrors<T extends {
  create: { error?: string };
  submit?: { error?: string };
  evaluate?: { error?: string };
  recover?: { error?: string };
  cancel?: { error?: string };
}>(session: T): T {
  const next = {
    ...session,
    create: { ...session.create, error: undefined },
  };
  if (session.submit) next.submit = clearGetTaskPrefixedError(session.submit);
  if (session.evaluate) next.evaluate = clearGetTaskPrefixedError(session.evaluate);
  if (session.recover) next.recover = clearGetTaskPrefixedError(session.recover);
  if (session.cancel) next.cancel = clearGetTaskPrefixedError(session.cancel);
  return next;
}
