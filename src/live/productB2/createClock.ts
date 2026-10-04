import { decodeStudioUserError, formatError } from "../format";
import { quoteWrite } from "../genlayer";
import { classifyDeadlineUserError, type DeadlineProbe, type DeadlineProbeStatus } from "../product/clock";
import { createTaskArgs } from "../product/task";
import {
  B2_APP_CONTEXT,
  B2_INTENDED_MEANING,
  B2_SEMANTIC_CRITERIA,
  B2_SOURCE_LOCALE,
  B2_SOURCE_TEXT,
  B2_STRING_KEY,
  B2_TARGET_LOCALE,
} from "./constants";

export function b2DeadlineStatusFromError(error: unknown): DeadlineProbeStatus {
  return classifyDeadlineUserError(decodeStudioUserError(error) ?? formatError(error));
}

export function makeB2CreateDeadlineProbe(input: {
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
          clientNonce: `b2-clock-probe-${submitByUnix}`,
          translator: input.translator,
          submitByUnix,
          recoverAfterUnix,
          sourceText: B2_SOURCE_TEXT,
          sourceLocale: B2_SOURCE_LOCALE,
          targetLocale: B2_TARGET_LOCALE,
          stringKey: B2_STRING_KEY,
          appContext: B2_APP_CONTEXT,
          intendedMeaning: B2_INTENDED_MEANING,
          semanticCriteria: B2_SEMANTIC_CRITERIA,
        }),
        value: input.value,
        from: input.from,
      });
      return "ok";
    } catch (err) {
      const status = b2DeadlineStatusFromError(err);
      if (status === "other") throw err;
      return status;
    }
  };
}
