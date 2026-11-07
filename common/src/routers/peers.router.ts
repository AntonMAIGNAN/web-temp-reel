import { Router } from "express";
import { type AxiosInstance } from "axios";
import { brokerSyn, receivePeers } from "../actions/peers.action.ts";
import {
  forgetPeerKey,
  receiveLookup,
  receiveRelay,
  sendToPeer,
} from "../actions/broker.action.ts";
import { type AppLocals, type Peers } from "../types.ts";
import { respondAction, respondData } from "../utils/action.utils.ts";

export type PeersRouterDependencies = {
  axiosInstance: AxiosInstance;
  peers: Peers;
};

export const createPeersRouter = ({
  axiosInstance,
  peers,
}: PeersRouterDependencies) => {
  const router = Router();

  router.post("/register", (req, res) =>
    respondAction(res, receivePeers(peers, req.headers.origin, req.body)),
  );

  router.post("/broker/syn/:id", async (req, res) => {
    const locals = req.app.locals as AppLocals;

    return respondAction(
      res,
      await brokerSyn(
        locals.peers,
        locals.knowns,
        axiosInstance,
        req.params.id,
        (origin) => forgetPeerKey(locals, origin),
      ),
    );
  });


  router.post("/broker/lookup/:id", async (req, res) =>
    respondData(
      res,
      await receiveLookup(
        req.app.locals as AppLocals,
        axiosInstance,
        req.headers.origin,
        req.params.id,
        req.body,
      ),
    ),
  );

  router.post("/broker/relay/:id", async (req, res) =>
    respondAction(
      res,
      await receiveRelay(
        req.app.locals as AppLocals,
        axiosInstance,
        req.headers.origin,
        req.params.id,
        req.body,
      ),
    ),
  );

  router.post("/broker/send/:id", async (req, res) =>
    respondAction(
      res,
      await sendToPeer(
        req.app.locals as AppLocals,
        axiosInstance,
        req.params.id,
        req.body,
      ),
    ),
  );

  return router;
};
