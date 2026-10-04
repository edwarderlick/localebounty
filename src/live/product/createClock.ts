import { decodeStudioUserError, formatError } from "../format";
import { quoteWrite } from "../genlayer";
import {
  classifyDeadlineUserError,
  type DeadlineProbe,
  type DeadlineProbeStatus,
} from "./clock";
import {
  TEST_APP_CONTEXT,
  TEST_INTENDED_MEANING,
  TEST_SEMANTIC_CRITERIA,
  TEST_SOURCE_LOCALE,
  TEST_SOURCE_TEXT,
  TEST_STRING_KEY,
  TEST_TARGET_LOCALE,
} from "./constants";
import { createTaskArgs } from "./task";

export function deadlineStatusFromError(error: unknown): DeadlineProbeStatus {
  return classifyDeadlineUserError(decodeStudioUserError(error) ?? formatError(error));
}

/** Probe create_task deadlines with a throwaway nonce. Does not consume the session client_nonce. */
export function makeCreateDeadlineProbe(input: {
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
          clientNonce: `clock-probe-${submitByUnix}`,
          translator: input.translator,
          submitByUnix,
          recoverAfterUnix,
          sourceText: TEST_SOURCE_TEXT,
          sourceLocale: TEST_SOURCE_LOCALE,
          targetLocale: TEST_TARGET_LOCALE,
          stringKey: TEST_STRING_KEY,
          appContext: TEST_APP_CONTEXT,
          intendedMeaning: TEST_INTENDED_MEANING,
          semanticCriteria: TEST_SEMANTIC_CRITERIA,
        }),
        value: input.value,
        from: input.from,
      });
      return "ok";
    } catch (err) {
      const status = deadlineStatusFromError(err);
      if (status === "other") throw err;
      return status;
    }
  };
}
