import express from "express";
import axios from "axios";
import { PORT, TARGET_URL, BASE_URL } from "./config.ts";

const app = express();

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

const KNOWNS: Map<string, State> = new Map();

async function isPeerAlive() {
  try {
    await axios.get(`${TARGET_URL}/health`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

app.post(`/${STATES.SYN}`, async (req, res) => {
  const from = assertOrigin(req.headers.origin);

  console.log(`Received ${STATES.SYN} request`);
  KNOWNS.set(from, STATES.SYN);
  const { status } = await axios.post(`${from}/${STATES.SYN_ACK}`, undefined, {
    headers: { Origin: BASE_URL },
  });
  return res.sendStatus(status);
});

app.post(`/${STATES.SYN_ACK}`, async (req, res) => {
  const from = assertOrigin(req.headers.origin);

  console.log(`Received ${STATES.SYN_ACK} request`);
  KNOWNS.set(from, STATES.SYN_ACK);
  const { status } = await axios.post(`${from}/${STATES.ACK}`, undefined, {
    headers: { Origin: BASE_URL },
  });
  return res.sendStatus(status);
});

app.post(`/${STATES.ACK}`, async (req, res) => {
  const from = assertOrigin(req.headers.origin);

  console.log(`Received ${STATES.ACK} request`);
  KNOWNS.set(from, STATES.ACK);
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

  try {
    await axios.post(`${TARGET_URL}/syn`, undefined, {
      headers: { Origin: BASE_URL },
    });
  } catch (error) {
    console.error("Error occurred while fetching from app-2:", error);
  }

  while (true) {
    const peerAlive = await isPeerAlive();
    console.log({ knowns: Object.fromEntries(KNOWNS), peerAlive });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
});
