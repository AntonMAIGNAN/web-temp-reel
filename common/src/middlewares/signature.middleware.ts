import { type NextFunction, type Request, type Response } from "express";
import { status } from "http-status";
import { logger } from "../logger.ts";
import { verifyRequest } from "../signature.ts";
import { type PublicKeys } from "../types.ts";

const isExempt = (req: Request) =>
  req.method === "POST" &&
  (req.path === "/register" ||
    req.path.startsWith("/broker/syn/") ||
    req.path.startsWith("/broker/send/"));

const canRepin = (req: Request) =>
  req.path === "/syn" || req.path === "/syn-ack";

export const createSignatureMiddleware = (publicKeys: PublicKeys) => {
  const reject = (
    res: Response,
    code: typeof status.UNAUTHORIZED | typeof status.FORBIDDEN,
    error: string,
    origin?: string,
  ) => {
    logger.warn("Rejected request with invalid security headers", {
      origin,
      status: code,
      error,
    });

    return res.status(code).send({ error });
  };

  return (req: Request, res: Response, next: NextFunction) => {
    if (isExempt(req)) {
      return next();
    }
    const origin = req.get("origin");

    const result = verifyRequest(req);
    if (!result.ok) {
      return reject(res, status.UNAUTHORIZED, result.error, origin);
    }

    const pinned = origin ? publicKeys.get(origin) : undefined;

    if (pinned && pinned !== result.keyid && !canRepin(req)) {
      return reject(res, status.FORBIDDEN, "Public key mismatch", origin);
    }

    res.locals.keyid = result.keyid;
    return next();
  };
};
