import express from "express";
import axios from "axios";
import { PORT, TARGET_URL, BASE_URL } from "./config.ts";

const app = express();

const axiosInstance = axios.create({
  headers: { Origin: BASE_URL },
  timeout: 5000,
});

const STATES = {
  NONE: "none",
  SYN: "syn",
  SYN_ACK: "syn-ack",
  ACK: "ack",
} as const;
type State = (typeof STATES)[keyof typeof STATES];

const assertOrigin = (origin: string | unknown): string => {
  if (typeof origin !== "string") {
    throw new Error("Missing Origin header");
  }

  return origin;
};

const stateRank: Record<State, number> = {
  [STATES.NONE]: 0,
  [STATES.SYN]: 1,
  [STATES.SYN_ACK]: 2,
  [STATES.ACK]: 3,
};

const KNOWNS: Map<string, State> = new Map();

async function isPeerAlive() {
  try {
    await axios.get(`${TARGET_URL}/health`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
const updateKnownState = (from: string, state: State) => {
  const current = KNOWNS.get(from);
  if (!current || stateRank[state] > stateRank[current]) {
    KNOWNS.set(from, state);
  }
};

const exp_backoff = async <ICallbackReturn>({
  attempt,
  maxAttempts = 5,
  maxDelay,
  callback,
}: {
  attempt: number;
  maxDelay: number;
  maxAttempts?: number;
  callback: () => ICallbackReturn | Promise<ICallbackReturn>;
}): Promise<ICallbackReturn> => {
  const delay = Math.min(1000 * 2 ** attempt, maxDelay);
  await new Promise((resolve) => setTimeout(resolve, delay));

  try {
    console.log(`Attempt ${attempt}`);
    return await callback();
  } catch (error) {
    console.error(`Attempt ${attempt + 1} failed`, { error });

    if (attempt >= (maxAttempts || 5)) {
      throw new Error(`Failed after ${attempt + 1} attempts`);
    }

    return exp_backoff({
      attempt: attempt + 1,
      maxDelay,
      callback,
    });
  }
};

app.post(`/${STATES.SYN}`, async (req, res) => {
  const from = assertOrigin(req.headers.origin);

  console.log(`Received ${STATES.SYN} request`);
  updateKnownState(from, STATES.SYN);
  const { status } = await axiosInstance.post(`${from}/${STATES.SYN_ACK}`);
  return res.sendStatus(status);
});

app.post(`/${STATES.SYN_ACK}`, async (req, res) => {
  const from = assertOrigin(req.headers.origin);

  console.log(`Received ${STATES.SYN_ACK} request`);
  updateKnownState(from, STATES.SYN_ACK);
  const { status } = await axiosInstance.post(`${from}/${STATES.ACK}`);
  return res.sendStatus(status);
});

app.post(`/${STATES.ACK}`, async (req, res) => {
  const from = assertOrigin(req.headers.origin);

  console.log(`Received ${STATES.ACK} request`);
  updateKnownState(from, STATES.ACK);
  res.status(200).send({ message: "ACK" });
});

app.post(`/forget`, async (req, res) => {
  const from = assertOrigin(req.headers.origin);
  KNOWNS.delete(from);
  console.log("Known host has been forgotten", { host: from });
  res.sendStatus(200);
});

app.get("/health", (_req, res) => {
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  KNOWNS.set(TARGET_URL, STATES.NONE);

  await exp_backoff({
    attempt: 0,
    maxDelay: 30000,
    callback: async () => {
      await axiosInstance.post(`${TARGET_URL}/syn`);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log({
    knowns: Object.fromEntries(KNOWNS),
  });

  await new Promise((resolve) => setTimeout(resolve, 5000));
  await exp_backoff({
    attempt: 0,
    maxDelay: 30000,
    callback: async () => {
      await axiosInstance.post(`${TARGET_URL}/forget`);
      console.log("Sent forget request to app-2");
    },
  });
});
