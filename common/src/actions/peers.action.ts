import { type AxiosInstance } from "axios";
import { status } from "http-status";
import { PeersResponseSchema } from "../contract.ts";
import { type Action, type Peers } from "../types.ts";
import { checkOrigin } from "../utils/checkOrigin.utils.ts";
import { logger } from "../logger.ts";

export const receivePeers = (
  peers: Peers,
  brokerUrl: string,
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

  if (new URL(checkedOrigin.data).origin !== new URL(brokerUrl).origin) {
    logger.warn("Rejected peer list from non-broker origin", {
      origin: checkedOrigin.data,
    });

    return {
      status: status.FORBIDDEN,
      data: false,
      error: "Only the broker can push peers",
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

  peers.clear();
  for (const { id, url } of parsed.data) {
    peers.set(id, new URL(url).origin);
  }

  logger.info("Peers updated by broker", { peers: Object.fromEntries(peers) });

  return { status: status.NO_CONTENT, data: true };
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
