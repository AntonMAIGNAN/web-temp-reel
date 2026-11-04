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

const KNOWNS: Map<string, State> = new Map();

app.post(`/${STATES.SYN}`, async (req, res) => {
  const from = req.headers.origin;
  if (typeof from !== "string") {
    return res.status(400).send({ error: "Missing Origin header" });
  }
  console.log(`Received ${STATES.SYN} request`);
  KNOWNS.set(from, STATES.SYN);
  const { status } = await axios.post(`${from}/${STATES.SYN_ACK}`, undefined, {
    headers: { Origin: BASE_URL },
  });
  return res.sendStatus(status);
});

app.post(`/${STATES.SYN_ACK}`, async (req, res) => {
  const from = req.headers.origin;
  if (typeof from !== "string") {
    return res.status(400).send({ error: "Missing Origin header" });
  }
  console.log(`Received ${STATES.SYN_ACK} request`);
  KNOWNS.set(from, STATES.SYN_ACK);
  const { status } = await axios.post(`${from}/${STATES.ACK}`, undefined, {
    headers: { Origin: BASE_URL },
  });
  return res.sendStatus(status);
});

app.post(`/${STATES.ACK}`, async (req, res) => {
  const from = req.headers.origin;
  if (typeof from !== "string") {
    return res.status(400).send({ error: "Missing Origin header" });
  }
  console.log(`Received ${STATES.ACK} request`);
  KNOWNS.set(from, STATES.ACK);
  res.status(200).send({ message: "ACK" });
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
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log({ knowns: Object.fromEntries(KNOWNS) });
  }
});
