import express, { type Express } from "express";
import { type AxiosInstance } from "axios";

const STATES = {
  NONE: "none",
  SYN: "syn",
  SYN_ACK: "syn-ack",
  ACK: "ack",
} as const;

type State = (typeof STATES)[keyof typeof STATES];
type KnownState = Map<string, State>;

export type AppConfig = {
  baseUrl: string;
};

const stateRank: Record<State, number> = {
  [STATES.NONE]: 0,
  [STATES.SYN]: 1,
  [STATES.SYN_ACK]: 2,
  [STATES.ACK]: 3,
};

const assertOrigin = (origin: string | string[] | undefined): string => {
  if (typeof origin !== "string") {
    throw new Error("Missing Origin header");
  }
  return origin;
};

const updateKnownState = (knowns: KnownState, from: string, state: State) => {
  const current = knowns.get(from);
  if (!current || stateRank[state] > stateRank[current]) {
    knowns.set(from, state);
  }
};

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
    console.error(`Attempt ${attempt + 1} failed`, { error });
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
  const messages: Array<{
    action: string;
    payload?: Record<string, unknown>;
    from: string;
    date: Date;
  }> = [];

  app.use(express.json());

  app.locals.knowns = knowns;
  app.locals.messages = messages;

  app.post("/syn", async (req, res) => {
    const from = assertOrigin(req.headers.origin);
    updateKnownState(knowns, from, STATES.SYN);
    const { status } = await axiosInstance.post(`${from}/syn-ack`);
    return res.sendStatus(status);
  });

  app.post("/syn-ack", async (req, res) => {
    const from = assertOrigin(req.headers.origin);
    updateKnownState(knowns, from, STATES.SYN_ACK);
    const { status } = await axiosInstance.post(`${from}/ack`);
    return res.sendStatus(status);
  });

  app.post("/ack", async (req, res) => {
    const from = assertOrigin(req.headers.origin);
    updateKnownState(knowns, from, STATES.ACK);
    return res.status(200).send({ message: "ACK" });
  });

  app.post("/forget", (req, res) => {
    const from = assertOrigin(req.headers.origin);
    knowns.delete(from);
    console.log("Known host has been forgotten", { host: from });
    return res.sendStatus(200);
  });

  app.get("/health", (_req, res) => res.sendStatus(200));

  app.post("/ingress", (req, res) => {
    const { action, payload } = req.body;
    const origin = assertOrigin(req.headers.origin);

    if (
      !app.locals.knowns.has(origin) &&
      app.locals.knows.get(origin) !== STATES.ACK
    ) {
      return res.status(403).send({ error: "Origin not allowed" });
    }

    if (!action || typeof action !== "string") {
      return res.status(400).send({ error: "Missing or invalid action" });
    }

    messages.push({
      action,
      payload,
      from: assertOrigin(req.headers.origin),
      date: new Date(),
    });

    console.log("Received message", { action, payload });
    return res.sendStatus(200);
  });

  return app;
};

export const startHandshake = async (
  app: Express,
  axiosInstance: AxiosInstance,
) => {
  const knowns = app.locals.knowns as KnownState;

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 10000));

    const healthChecks = Array.from(knowns.entries()).map(([host, state]) => {
      if (state === STATES.ACK) {
        expBackoff({
          attempt: 1,
          maxDelay: 30000,
          callback: async () => {
            try {
              await axiosInstance.get(`${host}/health`);
              return true;
            } catch {
              return false;
            }
          },
        });
      }
    });

    await Promise.all(healthChecks);

    console.log({ knowns: Object.fromEntries(knowns) });
  }
};
