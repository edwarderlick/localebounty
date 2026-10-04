/** Reuse Phase B1 write guards. Same contract, same role/recover/never-resubmit rules. */
export {
  b1ActionEstimateAllowed,
  b1ActionSignAllowed,
  b1ClearRisk,
  b1SessionRewardWei,
  bindB1CreateEstimateIdentity,
  connectedB1Role,
  deadlinesStale,
  hasTxId,
  isFinalizedSuccessful,
  isTerminalFailure,
  needsB1TxResume,
  neverResubmit,
  retryFailedB1Action,
  type B1WriteContext,
} from "../productB1/guards";
