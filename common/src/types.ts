import { type State } from "./constants.ts";
import { status } from "http-status";

export type StatusCodes = Extract<(typeof status)[keyof typeof status], number>;
type Status200 = Extract<StatusCodes, 200 | 201 | 202 | 204>;
type OtherStatus = Exclude<StatusCodes, Status200>;

export type KnownState = Map<string, State>;

export type Action<T> =
  | { status: Status200; data: T; error?: null }
  | { status: OtherStatus; data: T; error: string };
