import { type AxiosInstance } from "axios";
import { status } from "http-status";
import { STATES, type State } from "../constants.ts";
import { type Action, type KnownState } from "../types.ts";
import { checkOrigin } from "../utils/checkOrigin.utils.ts";
import { logger } from "../logger.ts";

const stateRank: Record<State, number> = {
  [STATES.SYN]: 0,
  [STATES.SYN_ACK]: 1,
  [STATES.ACK]: 2,
};

const updateKnownState = (knowns: KnownState, origin: string, state: State) => {
  const current = knowns.get(origin);
  if (!current || stateRank[state] > stateRank[current]) {
    knowns.set(origin, state);
  }
};

export const receiveSyn = async (
  knowns: KnownState,
  axiosInstance: AxiosInstance,
  origin?: string,
): Promise<Action<boolean>> => {
  const checkedOrigin = checkOrigin(origin);
  if (checkedOrigin.status !== status.OK) {
    return {
      status: checkedOrigin.status,
      data: false,
      error: checkedOrigin.error,
    };
  }

  updateKnownState(knowns, checkedOrigin.data, STATES.SYN);

  logger.info("Received SYN, sending SYN-ACK", { origin: checkedOrigin.data });
  updateKnownState(knowns, checkedOrigin.data, STATES.SYN_ACK);
  await axiosInstance.post(`${checkedOrigin.data}/${STATES.SYN_ACK}`);

  return { status: status.ACCEPTED, data: true };
};

export const receiveSynAck = async (
  knowns: KnownState,
  axiosInstance: AxiosInstance,
  origin?: string,
): Promise<Action<boolean>> => {
  const checkedOrigin = checkOrigin(origin);
  if (checkedOrigin.status !== status.OK) {
    return {
      status: checkedOrigin.status,
      data: false,
      error: checkedOrigin.error,
    };
  }

  if (!knowns.has(checkedOrigin.data)) {
    logger.warn("Accepting reciprocal SYN-ACK from unknown origin", {
      origin: checkedOrigin.data,
    });
    updateKnownState(knowns, checkedOrigin.data, STATES.SYN_ACK);
  }

  updateKnownState(knowns, checkedOrigin.data, STATES.SYN_ACK);

  logger.info("Received SYN-ACK, sending ACK", { origin: checkedOrigin.data });
  await axiosInstance.post(`${checkedOrigin.data}/${STATES.ACK}`);

  return { status: status.ACCEPTED, data: true };
};

export const receiveAck = (
  knowns: KnownState,
  origin?: string,
): Action<boolean> => {
  const checkedOrigin = checkOrigin(origin);
  if (checkedOrigin.status !== status.OK) {
    return {
      status: checkedOrigin.status,
      data: false,
      error: checkedOrigin.error,
    };
  }
  const current = knowns.get(checkedOrigin.data);
  if (current !== STATES.SYN_ACK && current !== STATES.ACK) {
    logger.warn("Rejected ACK before SYN-ACK", {
      origin: checkedOrigin.data,
    });
    return {
      status: status.FORBIDDEN,
      data: false,
      error: "SYN-ACK required first",
    };
  }

  updateKnownState(knowns, checkedOrigin.data, STATES.ACK);
  logger.info("Received ACK", { origin: checkedOrigin.data });

  return { status: status.NO_CONTENT, data: true };
};

export const receivePong = (
  knowns: KnownState,
  origin?: string,
): Action<boolean> => {
  const checkedOrigin = checkOrigin(origin);
  if (checkedOrigin.status !== status.OK) {
    return {
      status: checkedOrigin.status,
      data: false,
      error: checkedOrigin.error,
    };
  }

  if (!knowns.has(checkedOrigin.data)) {
    logger.warn("Rejected pong from unknown server", {
      origin: checkedOrigin.data,
    });
    return { status: status.FORBIDDEN, data: false, error: "Unknown server" };
  }

  logger.info("Received pong", { origin: checkedOrigin.data });

  return { status: status.NO_CONTENT, data: true };
};
