import { decodeStudioUserError, formatError } from "../format";
import { quoteWrite } from "../genlayer";
import { classifyDeadlineUserError, type DeadlineProbe, type DeadlineProbeStatus } from "../product/clock";
import { createTaskArgs } from "../product/task";
import {
  B1_APP_CONTEXT,
  B1_INTENDED_MEANING,
  B1_SEMANTIC_CRITERIA,
  B1_SOURCE_LOCALE,
  B1_SOURCE_TEXT,
  B1_STRING_KEY,
  B1_TARGET_LOCALE,
} from "./constants";

export function b1DeadlineStatusFromError(error: unknown): DeadlineProbeStatus {
  return classifyDeadlineUserError(decodeStudioUserError(error) ?? formatError(error));
}

export function makeB1CreateDeadlineProbe(input: {
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
          clientNonce: `b1-clock-probe-${submitByUnix}`,
          translator: input.translator,
          submitByUnix,
          recoverAfterUnix,
          sourceText: B1_SOURCE_TEXT,
          sourceLocale: B1_SOURCE_LOCALE,
          targetLocale: B1_TARGET_LOCALE,
          stringKey: B1_STRING_KEY,
          appContext: B1_APP_CONTEXT,
          intendedMeaning: B1_INTENDED_MEANING,
          semanticCriteria: B1_SEMANTIC_CRITERIA,
        }),
        value: input.value,
        from: input.from,
      });
      return "ok";
    } catch (err) {
      const status = b1DeadlineStatusFromError(err);
      if (status === "other") throw err;
      return status;
    }
  };
}
