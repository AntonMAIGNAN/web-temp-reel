export const STATES = {
  SYN: "syn",
  SYN_ACK: "syn-ack",
  ACK: "ack",
} as const;

export type State = (typeof STATES)[keyof typeof STATES];

export function isAuthorizedState(state?: State) {
  return state === STATES.SYN_ACK || state === STATES.ACK;
}
