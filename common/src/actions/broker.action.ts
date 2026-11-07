import { randomUUID } from "node:crypto";
import { type AxiosInstance } from "axios";
import { status } from "http-status";
import {
  ClearPayloadSchema,
  EncryptedPayloadSchema,
  IngressBodySchema,
  LookupBodySchema,
  LookupResponseSchema,
  SendBodySchema,
  type IngressBody,
} from "../contract.ts";
import { decrypt, deriveSecret, sealMessage } from "../crypto.ts";
import { logger } from "../logger.ts";
import { post } from "../transport.ts";
import { type Action, type AppLocals } from "../types.ts";
import { initiateHandshake } from "./handshake.action.ts";

const isSuccess = (code: number) =>
  code < status.MULTIPLE_CHOICES || code === status.ALREADY_REPORTED;

export const storePeerKey = (
  locals: AppLocals,
  origin: string,
  keyid: string | undefined,
) => {
  if (keyid) {
    try {
      locals.secrets.set(origin, deriveSecret(locals.identity, keyid));
      locals.publicKeys.set(origin, keyid);

      logger.info("Link secret derived", { origin });
    } catch (error) {
      logger.warn("Cannot derive link secret", { origin, error });
    }
  }
};

export const forgetPeerKey = (locals: AppLocals, origin: string) => {
  locals.missedPongs.delete(origin);
  locals.secrets.delete(origin);
  locals.publicKeys.delete(origin);
};

const getNeighbors = (locals: AppLocals, except: string[]) => {
  const neighbors: string[] = [];

  for (const url of locals.secrets.keys()) {
    if (url !== locals.selfUrl && !except.includes(url)) {
      neighbors.push(url);
    }
  }

  return neighbors;
};

const askNeighbors = async (
  locals: AppLocals,
  axiosInstance: AxiosInstance,
  id: string,
  reqId: string,
  except: string[],
) => {
  for (const neighbor of getNeighbors(locals, except)) {
    try {
      const response = await post(
        axiosInstance,
        neighbor,
        `/broker/lookup/${id}`,
        { reqId },
      );
      const found = LookupResponseSchema.safeParse(response.data);

      if (response.status === status.OK && found.success) {
        locals.peers.set(id, found.data.url);
        logger.info("Peer found by neighbor", { id, via: neighbor });

        return { url: found.data.url, via: neighbor };
      }
    } catch (error) {
      logger.warn("Lookup to neighbor failed", { neighbor, id, error });
    }
  }

  return null;
};

const findPeer = async (
  locals: AppLocals,
  axiosInstance: AxiosInstance,
  id: string,
  reqId: string,
  except: string[],
) => {
  const url = locals.peers.get(id);

  if (url) {
    return url;
  }

  if (locals.seenLookups.has(reqId)) {
    return null;
  }

  locals.seenLookups.add(reqId);

  const found = await askNeighbors(locals, axiosInstance, id, reqId, except);

  return found ? found.url : null;
};

const sendDirect = async (
  locals: AppLocals,
  axiosInstance: AxiosInstance,
  url: string,
  message: IngressBody,
) => {
  try {
    if (!locals.secrets.has(url)) {
      await initiateHandshake(locals.knowns, axiosInstance, url, (origin) =>
        forgetPeerKey(locals, origin),
      );
    }

    const secret = locals.secrets.get(url);

    if (!secret) {
      return false;
    }

    const response = await post(
      axiosInstance,
      url,
      "/ingress",
      sealMessage(message, secret),
    );

    return isSuccess(response.status);
  } catch (error) {
    logger.warn("Direct delivery failed", { url, error });
    return false;
  }
};

const sendThroughRelay = async (
  locals: AppLocals,
  axiosInstance: AxiosInstance,
  id: string,
  message: IngressBody,
  except: string[],
) => {
  const found = await askNeighbors(
    locals,
    axiosInstance,
    id,
    randomUUID(),
    except,
  );

  if (!found) {
    return false;
  }

  const secret = locals.secrets.get(found.via)!;

  try {
    const response = await post(
      axiosInstance,
      found.via,
      `/broker/relay/${id}`,
      sealMessage(message, secret),
    );

    return isSuccess(response.status);
  } catch (error) {
    logger.warn("Relay failed", { id, via: found.via, error });
    return false;
  }
};

const deliver = async (
  locals: AppLocals,
  axiosInstance: AxiosInstance,
  id: string,
  message: IngressBody,
  except: string[],
): Promise<Action<boolean>> => {
  const url = locals.peers.get(id);

  if (!url) {
    return { status: status.NOT_FOUND, data: false, error: "Unknown peer id" };
  }

  if (await sendDirect(locals, axiosInstance, url, message)) {
    logger.info("Message delivered directly", { id });
    return { status: status.ACCEPTED, data: true };
  }

  if (
    await sendThroughRelay(locals, axiosInstance, id, message, [url, ...except])
  ) {
    logger.info("Message delivered through relay", { id });
    return { status: status.ACCEPTED, data: true };
  }

  return { status: status.BAD_GATEWAY, data: false, error: "Peer unreachable" };
};

export const receiveLookup = async (
  locals: AppLocals,
  axiosInstance: AxiosInstance,
  origin: string | undefined,
  id: string,
  body: unknown,
): Promise<Action<{ id: string; url: string } | null>> => {
  if (!origin || !locals.secrets.has(origin)) {
    return {
      status: status.FORBIDDEN,
      data: null,
      error: "Origin not allowed",
    };
  }

  const parsed = LookupBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: status.BAD_REQUEST,
      data: null,
      error: "Expected { reqId }",
    };
  }

  const url = await findPeer(locals, axiosInstance, id, parsed.data.reqId, [
    origin,
  ]);

  if (!url) {
    return { status: status.NOT_FOUND, data: null, error: "Unknown peer id" };
  }

  return { status: status.OK, data: { id, url } };
};

export const receiveRelay = async (
  locals: AppLocals,
  axiosInstance: AxiosInstance,
  origin: string | undefined,
  id: string,
  body: unknown,
): Promise<Action<boolean>> => {
  if (!origin || !locals.secrets.has(origin)) {
    return {
      status: status.FORBIDDEN,
      data: false,
      error: "Origin not allowed",
    };
  }

  const parsed = IngressBodySchema.safeParse(body);
  const encrypted = EncryptedPayloadSchema.safeParse(parsed.data?.payload);
  if (!parsed.success || !encrypted.success) {
    return {
      status: status.BAD_REQUEST,
      data: false,
      error: "Expected encrypted ingress body",
    };
  }

  let message: IngressBody;
  try {
    const secret = locals.secrets.get(origin)!;
    const aad = JSON.stringify(parsed.data.metadata);
    const payload = ClearPayloadSchema.parse(
      decrypt(secret, encrypted.data.enc, aad),
    );

    message = { ...parsed.data, payload: payload ?? undefined };
  } catch {
    return {
      status: status.BAD_REQUEST,
      data: false,
      error: "Cannot decrypt payload",
    };
  }

  const key = JSON.stringify(message);

  if (locals.relayedMessages.has(key)) {
    return {
      status: status.LOOP_DETECTED,
      data: false,
      error: "Message already relayed",
    };
  }
  locals.relayedMessages.add(key);

  if (!locals.peers.has(id)) {
    await findPeer(locals, axiosInstance, id, randomUUID(), [origin]);
  }

  logger.info("Relaying message", { from: origin, to: id });
  return deliver(locals, axiosInstance, id, message, [origin]);
};

export const sendToPeer = async (
  locals: AppLocals,
  axiosInstance: AxiosInstance,
  id: string,
  body: unknown,
): Promise<Action<boolean>> => {
  const parsed = SendBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: status.BAD_REQUEST,
      data: false,
      error: "Expected { action, payload? }",
    };
  }

  const url = await findPeer(locals, axiosInstance, id, randomUUID(), []);
  if (!url) {
    return { status: status.NOT_FOUND, data: false, error: "Unknown peer id" };
  }

  const message: IngressBody = {
    action: parsed.data.action,
    metadata: {
      source: locals.selfUrl,
      target: url,
      timestamp: new Date().toISOString(),
    },
    payload: parsed.data.payload,
  };

  return deliver(locals, axiosInstance, id, message, []);
};
