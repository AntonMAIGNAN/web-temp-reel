import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { type AxiosInstance } from "axios";
import { OriginHeadersSchema } from "./contract.ts";
import { type Action, type KnownState } from "./types.ts";
import { forgetHost } from "./actions/forget.action.ts";
import {
  receiveAck,
  receivePong,
  receiveSyn,
  receiveSynAck,
} from "./actions/handshake.action.ts";
import { receiveIngress, type Message } from "./actions/ingress.action.ts";
import { isAuthorizedState } from "./constants.ts";
import { checkHealth } from "./actions/health.action.ts";
import { logger } from "./logger.ts";

export { logger };

const parseOrigin = (origin: unknown): string | undefined => {
  const result = OriginHeadersSchema.safeParse({ origin });
  return result.success ? result.data.origin : undefined;
};

const respond = (res: Response, result: Action<boolean>) =>
  result.data
    ? res.sendStatus(result.status)
    : res.status(result.status).send({ error: result.error });

const expBackoff = async <T>({
  attempt,
  maxAttempts = 5,
  maxDelay,
  callback,
}: {
  attempt: number;
  maxAttempts?: number;
  maxDelay: number;
  callback: () => T | Promise<T>;
}): Promise<T> => {
  const delay = Math.min(1000 * 2 ** attempt, maxDelay);
  await new Promise((resolve) => setTimeout(resolve, delay));

  try {
    return await callback();
  } catch (error) {
    logger.warn("Backoff attempt failed", {
      attempt: attempt + 1,
      error,
    });
    if (attempt >= maxAttempts) {
      throw new Error(`Failed after ${attempt + 1} attempts`);
    }
    return expBackoff({
      attempt: attempt + 1,
      maxAttempts,
      maxDelay,
      callback,
    });
  }
};

export const bootstrap = (axiosInstance: AxiosInstance): Express => {
  const app = express();
  const knowns: KnownState = new Map();
  const messages: Message[] = [];
  const processedIngressRequests = new Set<string>();

  app.use(express.json());
  app.locals.knowns = knowns;
  app.locals.messages = messages;

  app.post("/syn", async (req, res) =>
    respond(
      res,
      await receiveSyn(knowns, axiosInstance, parseOrigin(req.headers.origin)),
    ),
  );

  app.post("/syn-ack", async (req, res) =>
    respond(
      res,
      await receiveSynAck(
        knowns,
        axiosInstance,
        parseOrigin(req.headers.origin),
      ),
    ),
  );

  app.post("/ack", (req, res) =>
    respond(res, receiveAck(knowns, parseOrigin(req.headers.origin))),
  );

  app.post("/forget", (req, res) =>
    respond(res, forgetHost(knowns, parseOrigin(req.headers.origin))),
  );

  app.get("/health", async (req, res) => {
    return respond(res, await checkHealth(axiosInstance, req.headers.origin));
  });

  app.post("/pong", (req, res) =>
    respond(res, receivePong(knowns, parseOrigin(req.headers.origin))),
  );

  app.post("/ingress", (req, res) =>
    respond(
      res,
      receiveIngress(
        knowns,
        messages,
        processedIngressRequests,
        parseOrigin(req.headers.origin),
        req.body,
      ),
    ),
  );

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      logger.error("Unhandled server error", { error });
      return res.sendStatus(500);
    },
  );

  return app;
};

export const healthCheckLoop = async (
  app: Express,
  axiosInstance: AxiosInstance,
) => {
  const knowns = app.locals.knowns as KnownState;

  do {
    await new Promise((resolve) => setTimeout(resolve, 15000));

    const healthChecks = Array.from(knowns.entries()).map(([host, state]) => {
      if (isAuthorizedState(state)) {
        return expBackoff({
          attempt: 1,
          maxDelay: 30000,
          callback: async () => {
            await axiosInstance.get(`${host}/health`);
            return true;
          },
        });
      }
      return Promise.resolve(false);
    });

    await Promise.all(healthChecks);

    logger.info("Peer health check completed", {
      knowns: Object.fromEntries(knowns),
    });
  } while (true);
};
