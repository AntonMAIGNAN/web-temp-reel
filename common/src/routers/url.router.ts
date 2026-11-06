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
import { type KnownState } from "../types.ts";
import { respondAction } from "../utils/action.utils.ts";

export type UrlRouterDependencies = {
  axiosInstance: AxiosInstance;
  knowns: KnownState;
  messages: Message[];
  processedIngressRequests: Set<string>;
};

export const createUrlRouter = ({
  axiosInstance,
  knowns,
  messages,
  processedIngressRequests,
}: UrlRouterDependencies) => {
  const router = Router();

  router.post("/syn", async (req, res) =>
    respondAction(res, await receiveSyn(knowns, axiosInstance, req.headers.origin)),
  );

  router.post("/syn-ack", async (req, res) =>
    respondAction(
      res,
      await receiveSynAck(knowns, axiosInstance, req.headers.origin),
    ),
  );

  router.post("/ack", (req, res) =>
    respondAction(res, receiveAck(knowns, req.headers.origin)),
  );

  router.post("/forget", (req, res) =>
    respondAction(res, forgetHost(knowns, req.headers.origin)),
  );

  router.get("/health", async (req, res) =>
    respondAction(res, await checkHealth(axiosInstance, req.headers.origin)),
  );

  router.post("/pong", (req, res) =>
    respondAction(res, receivePong(knowns, req.headers.origin)),
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
      ),
    ),
  );

  return router;
};
