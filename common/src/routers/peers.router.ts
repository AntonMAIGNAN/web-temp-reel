import { Router } from "express";
import { receivePeers } from "../actions/peers.action.ts";
import { type Peers } from "../types.ts";
import { respondAction } from "../utils/action.utils.ts";

export type PeersRouterDependencies = {
  peers: Peers;
  brokerUrl: string;
};

export const createPeersRouter = ({ peers, brokerUrl }: PeersRouterDependencies) => {
  const router = Router();

  router.post("/register", (req, res) =>
    respondAction(
      res,
      receivePeers(peers, brokerUrl, req.headers.origin, req.body),
    ),
  );

  return router;
};
