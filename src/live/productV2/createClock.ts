import { decodeStudioUserError, formatError } from "../format";
import { quoteWrite } from "../genlayer";
import { classifyDeadlineUserError, type DeadlineProbe, type DeadlineProbeStatus } from "../product/clock";
import {
  LANE_A_APP_CONTEXT,
  LANE_A_INTENDED_MEANING,
  LANE_A_SEMANTIC_CRITERIA,
  LANE_A_SOURCE_TEXT,
  LANE_A_STRING_KEY,
  TEST_SOURCE_LOCALE,
  TEST_TARGET_LOCALE,
} from "./constants";
import { createV2TaskArgs } from "./task";

export function deadlineStatusFromError(error: unknown): DeadlineProbeStatus {
  return classifyDeadlineUserError(decodeStudioUserError(error) ?? formatError(error));
}

export function makeV2CreateDeadlineProbe(input: {
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
        args: createV2TaskArgs({
          clientNonce: `clock-probe-${submitByUnix}`,
          translator: input.translator,
          submitByUnix,
          recoverAfterUnix,
          sourceText: LANE_A_SOURCE_TEXT,
          sourceLocale: TEST_SOURCE_LOCALE,
          targetLocale: TEST_TARGET_LOCALE,
          stringKey: LANE_A_STRING_KEY,
          appContext: LANE_A_APP_CONTEXT,
          intendedMeaning: LANE_A_INTENDED_MEANING,
          semanticCriteria: LANE_A_SEMANTIC_CRITERIA,
        }),
        value: input.value,
        from: input.from,
      });
      return "ok";
    } catch (error) {
      return deadlineStatusFromError(error);
    }
  };
}
