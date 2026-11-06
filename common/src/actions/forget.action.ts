import { logger } from "../logger.ts";
import { type Action, type KnownState } from "../types.ts";
import { isAuthorizedState, STATES } from "../constants.ts";
import { status } from "http-status";
import { checkOrigin } from "./checkOrigin.utils.ts";

export const forgetHost = (
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

  if (!isAuthorizedState(knowns.get(checkedOrigin.data))) {
    logger.warn("Attempt to forget unauthorized host", { origin });

    return {
      status: status.FORBIDDEN,
      data: false,
      error: "Origin is not authorized",
    };
  }

  knowns.delete(checkedOrigin.data);
  logger.info("Forgetting host", { origin: checkedOrigin.data });
  return { status: status.NO_CONTENT, data: true };
};
