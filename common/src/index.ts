import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { type AxiosInstance } from "axios";
import { type AppLocals } from "./types.ts";
import { isAuthorizedState } from "./constants.ts";
import { logger } from "./logger.ts";
import { createUrlRouter } from "./routers/url.router.ts";
import { createPeersRouter } from "./routers/peers.router.ts";
import {
  checkTracker,
  registerToBroker,
  unregisterFromBroker,
} from "./actions/peers.action.ts";
import { forgetPeerKey, storePeerKey } from "./actions/broker.action.ts";
import { createIdentity } from "./crypto.ts";
import { createSigner } from "./signature.ts";
import { createSignatureMiddleware } from "./middlewares/signature.middleware.ts";

export { logger, registerToBroker, unregisterFromBroker };

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

export const bootstrap = (
  axiosInstance: AxiosInstance,
  { brokerUrl, selfUrl }: { brokerUrl: string; selfUrl: string },
): Express => {
  const app = express();

  const defaultLocals: AppLocals = {
    knowns: new Map(),
    peers: new Map([["broker", brokerUrl]]),
    messages: [],
    publicKeys: new Map(),
    secrets: new Map(),
    identity: createIdentity(),
    selfUrl,
    seenLookups: new Set<string>(),
    relayedMessages: new Set<string>(),
    missedPongs: new Map<string, number>(),
  };

  axiosInstance.interceptors.request.use(createSigner(defaultLocals.identity));

  app.use(express.json());

  app.use(createSignatureMiddleware(defaultLocals.publicKeys));

  const locals: AppLocals = Object.assign(app.locals, {
    ...defaultLocals,
    selfUrl,
    seenLookups: new Set<string>(),
    relayedMessages: new Set<string>(),
  });

  app.use(
    createPeersRouter({
      axiosInstance,
      peers: locals.peers,
    }),
  );

  app.use(
    createUrlRouter({
      axiosInstance,
      knowns: locals.knowns,
      messages: locals.messages,
      processedIngressRequests: locals.seenLookups,
      secrets: locals.secrets,
      onPeerKey: (origin, keyid) => storePeerKey(locals, origin, keyid),
      onForget: (origin) => forgetPeerKey(locals, origin),
      onPong: (origin) => locals.missedPongs.delete(origin),
    }),
  );

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      logger.error("Unhandled server error", { error });
      return res.sendStatus(500);
    },
  );

  return app;
};

const HEALTH_INTERVAL_MS = 10000;
const MAX_MISSED_PONGS = 5;

export const checkPeersHealth = async (
  app: Express,
  axiosInstance: AxiosInstance,
  { maxAttempts = 5 }: { maxAttempts?: number } = {},
) => {
  const locals = app.locals as AppLocals;

  const forget = (host: string, reason: string) => {
    logger.warn("Forgetting unhealthy peer", { host, reason });
    locals.knowns.delete(host);
    forgetPeerKey(locals, host);
  };

  const healthChecks = Array.from(locals.knowns.entries()).map(
    async ([host, state]) => {
      if (!isAuthorizedState(state)) return;

      const missed = locals.missedPongs.get(host) ?? 0;

      if (missed >= MAX_MISSED_PONGS) {
        forget(host, `${missed} /health without /pong`);
        return;
      }

      locals.missedPongs.set(host, missed + 1);

      try {
        await expBackoff({
          attempt: 1,
          maxAttempts,
          maxDelay: 30000,
          callback: () => axiosInstance.get(`${host}/health`),
        });
      } catch {
        forget(host, "no answer after retries");
      }
    },
  );

  await Promise.all(healthChecks);

  logger.info("Peer health check completed", {
    knowns: Object.fromEntries(locals.knowns),
  });
};

export const healthCheckLoop = async (
  app: Express,
  axiosInstance: AxiosInstance,
) => {
  do {
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
    await checkPeersHealth(app, axiosInstance);
  } while (true);
};

export const trackerLoop = async (
  axiosInstance: AxiosInstance,
  brokerUrl: string,
  peer: { id: string; url: string },
) => {
  let isUp = false;

  do {
    isUp = await checkTracker(axiosInstance, brokerUrl, peer, isUp);
    await new Promise((resolve) => setTimeout(resolve, 15000));
  } while (true);
};
