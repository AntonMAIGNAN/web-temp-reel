import { createHash } from "node:crypto";
import { status } from "http-status";
import {
  ClearPayloadSchema,
  EncryptedPayloadSchema,
  IngressBodySchema,
} from "../contract.ts";
import { decrypt } from "../crypto.ts";
import { isAuthorizedState } from "../constants.ts";
import { type Action, type KnownState, type Secrets } from "../types.ts";
import { checkOrigin } from "../utils/checkOrigin.utils.ts";
import { logger } from "../logger.ts";

export type Message = {
  action: string;
  metadata: {
    source: string;
    target: string;
    timestamp: Date;
  };
  payload?: Record<string, unknown>;
};

export const receiveIngress = (
  knowns: KnownState,
  messages: Message[],
  processedRequests: Set<string>,
  origin: string | undefined,
  body: unknown,
  secrets: Secrets,
): Action<boolean> => {
  const checkedOrigin = checkOrigin(origin);
  if (checkedOrigin.status !== status.OK) {
    return {
      status: checkedOrigin.status,
      data: false,
      error: checkedOrigin.error,
    };
  }

  if (!isAuthorizedState(knowns.get(checkedOrigin.data))) {
    logger.warn("Rejected ingress from unestablished origin", {
      origin: checkedOrigin.data,
    });

    return {
      status: status.FORBIDDEN,
      data: false,
      error: "Origin not allowed",
    };
  }

  const parsedBody = IngressBodySchema.safeParse(body);
  if (!parsedBody.success) {
    logger.warn("Rejected malformed ingress body", {
      origin: checkedOrigin.data,
      issues: parsedBody.error.issues,
    });

    return {
      status: status.BAD_REQUEST,
      data: false,
      error: "Malformed ingress body",
    };
  }

  const { action, metadata } = parsedBody.data;

  const secret = secrets.get(checkedOrigin.data);
  const encrypted = EncryptedPayloadSchema.safeParse(parsedBody.data.payload);

  if (!secret || !encrypted.success) {
    logger.warn("Rejected unencrypted ingress", { origin: checkedOrigin.data });

    return {
      status: status.FORBIDDEN,
      data: false,
      error: secret ? "Encrypted payload required" : "No shared secret",
    };
  }

  let payload: Record<string, unknown> | undefined;
  try {
    const clear = ClearPayloadSchema.parse(
      decrypt(secret, encrypted.data.enc, JSON.stringify(metadata)),
    );

    payload = clear ?? undefined;
  } catch {
    logger.warn("Rejected undecryptable ingress message", {
      origin: checkedOrigin.data,
    });

    return {
      status: status.BAD_REQUEST,
      data: false,
      error: "Cannot decrypt payload",
    };
  }

  const hash = createHash("sha256")
    .update(JSON.stringify({ action, metadata, payload }))
    .digest("hex");

  if (processedRequests.has(hash)) {
    logger.info("Rejected duplicate ingress message", {
      origin: checkedOrigin.data,
      action,
      hash,
    });

    return {
      status: status.ALREADY_REPORTED,
      data: false,
      error: "Request already reported",
    };
  }

  processedRequests.add(hash);

  messages.push({
    action,
    metadata: {
      ...metadata,
      timestamp: new Date(metadata.timestamp),
    },
    payload,
  });

  logger.info("Accepted ingress message", { action, metadata, payload });

  return { status: status.CREATED, data: true };
};
