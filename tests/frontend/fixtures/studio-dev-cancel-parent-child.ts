/** Public Studio-dev cancel parent/child shape (reads only). Nested copies are extra for the parser regression. */

export const STUDIO_DEV_CANCEL_PARENT_TX =
  "0xdafc81730a100d256b66fd1e4b38b023122c9c0063146f6d84eba6b922cc909a";
export const STUDIO_DEV_CANCEL_CHILD_TX =
  "0xeb7d6e1e22d9981db5c2525738cd5e0096096a9420f918e54737b6ba5320922b";
export const STUDIO_DEV_PRODUCT_CONTRACT = "0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96";
export const STUDIO_DEV_FUNDER = "0x31e14df3b4f47F2428F3B78E7279691A78f70a05";
export const STUDIO_DEV_REWARD_WEI = "500000000000000000";

const parentEthSend = {
  messageType: "0",
  recipient: STUDIO_DEV_FUNDER,
  value: STUDIO_DEV_REWARD_WEI,
};

/** 12 nested copies that a recursive walker would count; the parser must ignore them. */
const nestedEthSends = Array.from({ length: 12 }, () => ({ ...parentEthSend }));

export const studioDevCancelParentReceipt = {
  hash: STUDIO_DEV_CANCEL_PARENT_TX,
  from_address: STUDIO_DEV_FUNDER,
  from: STUDIO_DEV_FUNDER,
  to_address: STUDIO_DEV_PRODUCT_CONTRACT,
  to: STUDIO_DEV_PRODUCT_CONTRACT,
  value: 0,
  status: "FINALIZED",
  txExecutionResultName: "FINISHED_WITH_RETURN",
  value_credited: false,
  triggered_by: null,
  triggered_transactions: [] as string[],
  messages: [parentEthSend],
  created_timestamp: 1790840237,
  consensus_data: {
    leader_receipt: {
      messages: nestedEthSends,
    },
    validators: [{ messages: nestedEthSends }],
  },
};

export const studioDevCancelChildReceipt = {
  hash: STUDIO_DEV_CANCEL_CHILD_TX,
  from_address: STUDIO_DEV_PRODUCT_CONTRACT,
  from: STUDIO_DEV_PRODUCT_CONTRACT,
  to_address: STUDIO_DEV_FUNDER,
  to: STUDIO_DEV_FUNDER,
  value: 500000000000000000,
  status: "FINALIZED",
  txExecutionResultName: "NOT_VOTED",
  value_credited: true,
  triggered_by: STUDIO_DEV_CANCEL_PARENT_TX,
  triggered_on: "finalized",
  triggered_transactions: [] as string[],
  messages: [] as unknown[],
};

export const studioDevCancelListedChildRow = {
  hash: STUDIO_DEV_CANCEL_CHILD_TX,
  from_address: STUDIO_DEV_PRODUCT_CONTRACT,
  from: STUDIO_DEV_PRODUCT_CONTRACT,
  to_address: STUDIO_DEV_FUNDER,
  to: STUDIO_DEV_FUNDER,
  value: 500000000000000000,
  status: "FINALIZED",
  value_credited: true,
  triggered_by: STUDIO_DEV_CANCEL_PARENT_TX,
  triggered_on: "finalized",
};

export const studioDevCancelListedParentRow = {
  hash: STUDIO_DEV_CANCEL_PARENT_TX,
  from_address: STUDIO_DEV_FUNDER,
  from: STUDIO_DEV_FUNDER,
  to_address: STUDIO_DEV_PRODUCT_CONTRACT,
  to: STUDIO_DEV_PRODUCT_CONTRACT,
  value: 0,
  status: "FINALIZED",
  value_credited: false,
  triggered_by: null,
};

export const studioDevCancelAddressTxs = [studioDevCancelListedChildRow, studioDevCancelListedParentRow];
