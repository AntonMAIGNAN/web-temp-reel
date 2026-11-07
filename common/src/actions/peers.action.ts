import { type AxiosInstance } from "axios";
import { status } from "http-status";
import { PeersResponseSchema } from "../contract.ts";
import { type Action, type KnownState, type Peers } from "../types.ts";
import { checkOrigin } from "../utils/checkOrigin.utils.ts";
import { logger } from "../logger.ts";
import { initiateHandshake } from "./handshake.action.ts";

export const receivePeers = (
  peers: Peers,
  origin: string | undefined,
  body: unknown,
): Action<boolean> => {
  const checkedOrigin = checkOrigin(origin);

  if (checkedOrigin.status !== status.OK) {
    return {
      status: checkedOrigin.status,
      data: false,
      error: checkedOrigin.error,
    };
  }

  if (Array.from(peers.keys()).includes(checkedOrigin.data)) {
    logger.warn("Rejected peer list from unknown origin", {
      origin: checkedOrigin.data,
    });

    return {
      status: status.FORBIDDEN,
      data: false,
      error: "Only the broker and registered peers can push peers",
    };
  }

  const parsed = PeersResponseSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn("Rejected malformed peer list", {
      issues: parsed.error.issues,
    });

    return {
      status: status.BAD_REQUEST,
      data: false,
      error: "Expected [{ id, url }]",
    };
  }

  const brokerUrl = peers.get("broker");

  peers.clear();

  if (brokerUrl) {
    peers.set("broker", brokerUrl);
  }

  for (const { id, url } of parsed.data) {
    peers.set(id, url.replace(/\/+$/, ""));
  }

  logger.info("Peers updated by broker", { peers: Object.fromEntries(peers) });

  return { status: status.NO_CONTENT, data: true };
};

export const brokerSyn = async (
  peers: Peers,
  knowns: KnownState,
  axiosInstance: AxiosInstance,
  id: string,
  onFail?: (origin: string) => void,
): Promise<Action<boolean>> => {
  const url = peers.get(id);

  if (!url) {
    logger.warn("Unknown peer id", { id });
    return { status: status.NOT_FOUND, data: false, error: "Unknown peer id" };
  }

  return initiateHandshake(knowns, axiosInstance, url, onFail);
};

export const registerToBroker = async (
  axiosInstance: AxiosInstance,
  brokerUrl: string,
  peer: { id: string; url: string },
) => {
  await axiosInstance.post(`${brokerUrl}/register`, peer);
  logger.info("Registered to broker", { brokerUrl, ...peer });
};

export const unregisterFromBroker = async (
  axiosInstance: AxiosInstance,
  brokerUrl: string,
  id: string,
) => {
  await axiosInstance.delete(
    `${brokerUrl}/unregister/${encodeURIComponent(id)}`,
  );
  logger.info("Unregistered from broker", { brokerUrl, id });
};

export const checkTracker = async (
  axiosInstance: AxiosInstance,
  brokerUrl: string,
  peer: { id: string; url: string },
  wasUp: boolean,
): Promise<boolean> => {
  try {
    await axiosInstance.get(brokerUrl, { validateStatus: () => true });
  } catch {
    if (wasUp) {
      logger.warn("Tracker unreachable, falling back to neighbors", {
        brokerUrl,
      });
    }
    return false;
  }

  if (!wasUp) {
    try {
      await registerToBroker(axiosInstance, brokerUrl, peer);
    } catch (error) {
      logger.warn("Tracker registration failed", { brokerUrl, error });
      return false;
    }
  }

  return true;
};
