import { type State } from "./constants.ts";
import { type Identity } from "./crypto.ts";
import { type Message } from "./actions/ingress.action.ts";
import { status } from "http-status";

export type StatusCodes = Extract<(typeof status)[keyof typeof status], number>;
type Status200 = Extract<StatusCodes, 200 | 201 | 202 | 204>;
type OtherStatus = Exclude<StatusCodes, Status200>;

export type KnownState = Map<string, State>;

export type Peers = Map<string, string>;

export type Action<T> =
  | { status: Status200; data: T; error?: null }
  | { status: OtherStatus; data: T; error: string };

export type PublicKeys = Map<string, string>;
export type Secrets = Map<string, Buffer>;

export type AppLocals = {
  knowns: KnownState;
  peers: Peers;
  messages: Message[];
  publicKeys: PublicKeys;
  secrets: Secrets;
  identity: Identity;
  selfUrl: string;
  seenLookups: Set<string>;
  relayedMessages: Set<string>;
  missedPongs: Map<string, number>;
};
