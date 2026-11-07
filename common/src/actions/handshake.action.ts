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

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const postWithRetry = async (axiosInstance: AxiosInstance, url: string) => {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      await axiosInstance.post(url);
      return true;
    } catch (error) {
      logger.warn("Handshake request failed", { url, attempt, error });
      if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  return false;
};

const handshakeFailed = (
  knowns: KnownState,
  origin: string,
  onFail?: (origin: string) => void,
): Action<boolean> => {
  knowns.delete(origin);
  onFail?.(origin);
  logger.warn("Handshake forgotten", { origin });

  return {
    status: status.INTERNAL_SERVER_ERROR,
    data: false,
    error: "Handshake failed",
  };
};

export const initiateHandshake = async (
  knowns: KnownState,
  axiosInstance: AxiosInstance,
  url: string,
  onFail?: (origin: string) => void,
): Promise<Action<boolean>> => {
  updateKnownState(knowns, url, STATES.SYN);
  logger.info("Sending SYN", { url });

  try {
    await axiosInstance.post(`${url}/${STATES.SYN}`);
  } catch (error) {
    logger.warn("SYN failed", { url, error });
    return handshakeFailed(knowns, url, onFail);
  }

  return { status: status.ACCEPTED, data: true };
};

export const receiveSyn = async (
  knowns: KnownState,
  axiosInstance: AxiosInstance,
  origin?: string,
  onPeerKey?: (origin: string) => void,
  onFail?: (origin: string) => void,
): Promise<Action<boolean>> => {
  const checkedOrigin = checkOrigin(origin);
  if (checkedOrigin.status !== status.OK) {
    return {
      status: checkedOrigin.status,
      data: false,
      error: checkedOrigin.error,
    };
  }

  onPeerKey?.(checkedOrigin.data);
  updateKnownState(knowns, checkedOrigin.data, STATES.SYN);

  logger.info("Received SYN, sending SYN-ACK", { origin: checkedOrigin.data });
  updateKnownState(knowns, checkedOrigin.data, STATES.SYN_ACK);

  const sent = await postWithRetry(
    axiosInstance,
    `${checkedOrigin.data}/${STATES.SYN_ACK}`,
  );
  if (!sent) {
    return handshakeFailed(knowns, checkedOrigin.data, onFail);
  }

  return { status: status.ACCEPTED, data: true };
};

export const receiveSynAck = async (
  knowns: KnownState,
  axiosInstance: AxiosInstance,
  origin?: string,
  onPeerKey?: (origin: string) => void,
  onFail?: (origin: string) => void,
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
    logger.warn("Rejected SYN-ACK from a server never contacted", {
      origin: checkedOrigin.data,
    });
    return {
      status: status.FORBIDDEN,
      data: false,
      error: "SYN required first",
    };
  }

  onPeerKey?.(checkedOrigin.data);
  updateKnownState(knowns, checkedOrigin.data, STATES.SYN_ACK);

  logger.info("Received SYN-ACK, sending ACK", { origin: checkedOrigin.data });
  const sent = await postWithRetry(
    axiosInstance,
    `${checkedOrigin.data}/${STATES.ACK}`,
  );

  if (!sent) {
    return handshakeFailed(knowns, checkedOrigin.data, onFail);
  }

  return { status: status.ACCEPTED, data: true };
};

export const receiveAck = (
  knowns: KnownState,
  origin?: string,
  onPeerKey?: (origin: string) => void,
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

  onPeerKey?.(checkedOrigin.data);
  updateKnownState(knowns, checkedOrigin.data, STATES.ACK);
  logger.info("Received ACK", { origin: checkedOrigin.data });

  return { status: status.NO_CONTENT, data: true };
};

export const receivePong = (
  knowns: KnownState,
  origin?: string,
  onPong?: (origin: string) => void,
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
  onPong?.(checkedOrigin.data);

  return { status: status.NO_CONTENT, data: true };
};
