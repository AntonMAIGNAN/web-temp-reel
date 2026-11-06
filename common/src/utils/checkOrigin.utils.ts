import { status } from "http-status";
import { OriginHeadersSchema } from "../contract.ts";
import { logger } from "../logger.ts";

export type OriginCheck =
  | { status: 200; data: string; error?: null }
  | { status: 400; data: false; error: string };

export function checkOrigin(origin: unknown): OriginCheck {
  const parsed = OriginHeadersSchema.safeParse({ origin });
  if (!parsed.success) {
    logger.warn("Invalid or missing Origin header", {
      statusCode: status.BAD_REQUEST,
    });

    return {
      status: status.BAD_REQUEST,
      error: "Origin must be a valid URL",
      data: false,
    };
  }

  return {
    status: status.OK,
    data: parsed.data.origin,
  };
}
