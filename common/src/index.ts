import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createHash } from "node:crypto";
import { type AxiosInstance } from "axios";
import { IngressBodySchema, OriginHeadersSchema } from "./contract.ts";

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

const updateKnownState = (knowns: KnownState, from: string, state: State) => {
  const current = knowns.get(from);
  if (!current || stateRank[state] > stateRank[current]) {
    console.log(`Updating known state for ${from} from ${current} to ${state}`);
    knowns.set(from, state);
  }
};

const parseOrigin = (origin: unknown): string | undefined => {
  const result = OriginHeadersSchema.safeParse({ origin });
  return result.success ? result.data.origin : undefined;
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

const stableSerialize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nestedValue]) =>
          `${JSON.stringify(key)}:${stableSerialize(nestedValue)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
};

const requestHash = (body: {
  action: string;
  metadata: {
    source: string;
    target: string;
    timestamp: string;
  };
  payload?: Record<string, unknown>;
}): string => createHash("sha256").update(stableSerialize(body)).digest("hex");

export const bootstrap = (axiosInstance: AxiosInstance): Express => {
  const app = express();

  const knowns: KnownState = new Map();
  const messages: Array<{
    action: string;
    metadata: {
      source: string;
      target: string;
      timestamp: Date;
    };
    payload?: Record<string, unknown>;
  }> = [];
  const processedIngressRequests = new Set<string>();

  app.use(express.json());

  app.locals.knowns = knowns;
  app.locals.messages = messages;

  app.post("/syn", async (req, res) => {
    const from = parseOrigin(req.headers.origin);
    if (!from) {
      return res.status(400).send({ error: "Missing Origin header" });
    }
    updateKnownState(knowns, from, STATES.SYN);
    await axiosInstance.post(`${from}/syn-ack`);
    return res.sendStatus(202);
  });

  app.post("/syn-ack", async (req, res) => {
    const from = parseOrigin(req.headers.origin);
    if (!from) {
      return res.status(400).send({ error: "Missing Origin header" });
    }
    if (!knowns.has(from)) {
      return res.status(403).send({ error: "SYN required first" });
    }

    updateKnownState(knowns, from, STATES.SYN_ACK);
    await axiosInstance.post(`${from}/ack`);
    return res.sendStatus(202);
  });

  app.post("/ack", async (req, res) => {
    const from = parseOrigin(req.headers.origin);
    if (!from) {
      return res.status(400).send({ error: "Missing Origin header" });
    }
    const current = knowns.get(from);
    if (current !== STATES.SYN_ACK && current !== STATES.ACK) {
      return res.status(403).send({ error: "SYN-ACK required first" });
    }

    updateKnownState(knowns, from, STATES.ACK);
    return res.sendStatus(204);
  });

  app.post("/forget", (req, res) => {
    const from = parseOrigin(req.headers.origin);
    if (!from) {
      return res.status(400).send({ error: "Missing Origin header" });
    }
    if (!knowns.has(from)) {
      return res.status(403).send({ error: "Origin is not known" });
    }
    knowns.delete(from);
    console.log("Known host has been forgotten", { host: from });
    return res.sendStatus(204);
  });

  app.get("/health", async (req, res) => {
    const origin = req.headers.origin;

    if (!origin) {
      return res.sendStatus(204);
    }

    const parsedHeaders = OriginHeadersSchema.partial().safeParse({ origin });
    if (!parsedHeaders.success) {
      return res.status(400).send({ error: "Invalid Origin header" });
    }

    try {
      await axiosInstance.post(`${parsedHeaders.data.origin}/pong`);
      return res.sendStatus(202);
    } catch (error) {
      console.error("Health ping callback failed", { origin, error });
      return res.sendStatus(500);
    }
  });

  app.post("/pong", (req, res) => {
    const from = parseOrigin(req.headers.origin);
    if (!from) {
      return res.status(400).send({ error: "Missing Origin header" });
    }
    if (!knowns.has(from)) {
      return res.status(403).send({ error: "Unknown server" });
    }
    return res.sendStatus(204);
  });

  app.post("/ingress", (req, res) => {
    const origin = parseOrigin(req.headers.origin);
    if (!origin) {
      return res.status(400).send({ error: "Missing Origin header" });
    }

    if (
      !app.locals.knowns.has(origin) ||
      (app.locals.knowns.get(origin) !== STATES.ACK &&
        app.locals.knowns.get(origin) !== STATES.SYN_ACK)
    ) {
      return res.status(403).send({ error: "Origin not allowed" });
    }

    const parsedBody = IngressBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).send({ error: "Malformed ingress body" });
    }
    const { action, metadata, payload } = parsedBody.data;
    const { source, target, timestamp } = metadata;

    const hash = requestHash({
      action,
      metadata: { source, target, timestamp },
      payload,
    });
    if (processedIngressRequests.has(hash)) {
      return res.status(208).send({ error: "Request already reported" });
    }
    processedIngressRequests.add(hash);

    messages.push({
      action,
      metadata: {
        source,
        target,
        timestamp: new Date(timestamp),
      },
      payload,
    });

    console.log("Received message from ", origin, {
      action,
      metadata,
      payload,
    });

    return res.sendStatus(201);
  });

  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      console.error("Unhandled server error", { error });
      return res.sendStatus(500);
    },
  );

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
