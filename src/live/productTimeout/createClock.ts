import { decodeStudioUserError, formatError } from "../format";
import { quoteWrite } from "../genlayer";
import { classifyDeadlineUserError, type DeadlineProbe, type DeadlineProbeStatus } from "../product/clock";
import { createTaskArgs } from "../product/task";
import {
  TIMEOUT_APP_CONTEXT,
  TIMEOUT_INTENDED_MEANING,
  TIMEOUT_SEMANTIC_CRITERIA,
  TIMEOUT_SOURCE_LOCALE,
  TIMEOUT_SOURCE_TEXT,
  TIMEOUT_STRING_KEY,
  TIMEOUT_TARGET_LOCALE,
} from "./constants";

export function timeoutDeadlineStatusFromError(error: unknown): DeadlineProbeStatus {
  return classifyDeadlineUserError(decodeStudioUserError(error) ?? formatError(error));
}

export function makeTimeoutCreateDeadlineProbe(input: {
  address: `0x${string}`;
  translator: string;
  value: bigint;
  from: `0x${string}`;
}): DeadlineProbe {
  return async (submitByUnix, recoverAfterUnix) => {
    try {
      await quoteWrite({
        address: input.address,
        functionName: "create_task",
        args: createTaskArgs({
          clientNonce: `timeout-clock-probe-${submitByUnix}`,
          translator: input.translator,
          submitByUnix,
          recoverAfterUnix,
          sourceText: TIMEOUT_SOURCE_TEXT,
          sourceLocale: TIMEOUT_SOURCE_LOCALE,
          targetLocale: TIMEOUT_TARGET_LOCALE,
          stringKey: TIMEOUT_STRING_KEY,
          appContext: TIMEOUT_APP_CONTEXT,
          intendedMeaning: TIMEOUT_INTENDED_MEANING,
          semanticCriteria: TIMEOUT_SEMANTIC_CRITERIA,
        }),
        value: input.value,
        from: input.from,
      });
      return "ok";
    } catch (err) {
      const status = timeoutDeadlineStatusFromError(err);
      if (status === "other") throw err;
      return status;
    }
  };
}
