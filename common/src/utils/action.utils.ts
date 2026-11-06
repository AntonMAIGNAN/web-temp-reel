import { type Response } from "express";
import { type Action } from "../types.ts";

export const respondAction = (res: Response, result: Action<boolean>) =>
  result.data
    ? res.sendStatus(result.status)
    : res.status(result.status).send({ error: result.error });
