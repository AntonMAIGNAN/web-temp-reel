import { createHash } from "node:crypto";
import { status } from "http-status";
import { IngressBodySchema } from "../contract.ts";
import { isAuthorizedState, STATES } from "../constants.ts";
import { type Action, type KnownState } from "../types.ts";
import { checkOrigin } from "./checkOrigin.utils.ts";
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

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nestedValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const receiveIngress = (
  knowns: KnownState,
  messages: Message[],
  processedRequests: Set<string>,
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

  const { action, metadata, payload } = parsedBody.data;

  const hash = createHash("sha256")
    .update(stableSerialize(parsedBody.data))
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
