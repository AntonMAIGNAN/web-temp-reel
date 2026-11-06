import { type AxiosInstance } from "axios";
import { status } from "http-status";
import { OriginHeadersSchema } from "../contract.ts";
import { type Action } from "../types.ts";
import { logger } from "../logger.ts";

export const checkHealth = async (
  axiosInstance: AxiosInstance,
  origin: unknown,
): Promise<Action<boolean>> => {
  if (!origin) {
    return { status: status.NO_CONTENT, data: true };
  }

  const parsedOrigin = OriginHeadersSchema.safeParse({ origin });
  if (!parsedOrigin.success) {
    return {
      status: status.BAD_REQUEST,
      data: false,
      error: "Invalid Origin header",
    };
  }

  try {
    await axiosInstance.post(`${parsedOrigin.data.origin}/pong`);
    return { status: status.ACCEPTED, data: true };
  } catch (error) {
    logger.error("Health ping callback failed", { origin, error });
    return {
      status: status.INTERNAL_SERVER_ERROR,
      data: false,
      error: "Health ping failed",
    };
  }
};
