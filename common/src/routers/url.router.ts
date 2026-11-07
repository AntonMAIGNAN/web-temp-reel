import { Router } from "express";
import { type AxiosInstance } from "axios";
import { forgetHost } from "../actions/forget.action.ts";
import {
  receiveAck,
  receivePong,
  receiveSyn,
  receiveSynAck,
} from "../actions/handshake.action.ts";
import { receiveIngress, type Message } from "../actions/ingress.action.ts";
import { checkHealth } from "../actions/health.action.ts";
import { type KnownState, type Secrets } from "../types.ts";
import { respondAction } from "../utils/action.utils.ts";

export type UrlRouterDependencies = {
  axiosInstance: AxiosInstance;
  knowns: KnownState;
  messages: Message[];
  processedIngressRequests: Set<string>;
  secrets: Secrets;
  onPeerKey: (origin: string, keyid: string | undefined) => void;
  onForget: (origin: string) => void;
  onPong: (origin: string) => void;
};

export const createUrlRouter = ({
  axiosInstance,
  knowns,
  messages,
  processedIngressRequests,
  secrets,
  onPeerKey,
  onForget,
  onPong,
}: UrlRouterDependencies) => {
  const router = Router();

  router.post("/syn", async (req, res) =>
    respondAction(
      res,
      await receiveSyn(
        knowns,
        axiosInstance,
        req.headers.origin,
        (origin) => onPeerKey(origin, res.locals.keyid),
        onForget,
      ),
    ),
  );

  router.post("/syn-ack", async (req, res) =>
    respondAction(
      res,
      await receiveSynAck(
        knowns,
        axiosInstance,
        req.headers.origin,
        (origin) => onPeerKey(origin, res.locals.keyid),
        onForget,
      ),
    ),
  );

  router.post("/ack", (req, res) =>
    respondAction(
      res,
      receiveAck(knowns, req.headers.origin, (origin) =>
        onPeerKey(origin, res.locals.keyid),
      ),
    ),
  );

  router.post("/forget", (req, res) =>
    respondAction(res, forgetHost(knowns, req.headers.origin, onForget)),
  );

  router.get("/health", async (req, res) =>
    respondAction(res, await checkHealth(axiosInstance, req.headers.origin)),
  );

  router.post("/pong", (req, res) =>
    respondAction(res, receivePong(knowns, req.headers.origin, onPong)),
  );

  router.post("/ingress", (req, res) =>
    respondAction(
      res,
      receiveIngress(
        knowns,
        messages,
        processedIngressRequests,
        req.headers.origin,
        req.body,
        secrets,
      ),
    ),
  );

  return router;
};
