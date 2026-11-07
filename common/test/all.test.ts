import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import axios, { type AxiosInstance } from "axios";
import express from "express";
import { bootstrap, checkPeersHealth } from "../src/index.ts";
import { checkTracker } from "../src/actions/peers.action.ts";
import { type Message } from "../src/actions/ingress.action.ts";
import { type AppLocals } from "../src/types.ts";
import { createIdentity, sealMessage } from "../src/crypto.ts";
import { signHeaders } from "../src/signature.ts";

type TestNode = {
  url: string;
  axiosInstance: AxiosInstance;
  locals: AppLocals;
  app: ReturnType<typeof bootstrap>;
  messages: Message[];
  sent: Array<{ url: string; data: unknown }>;
  close: () => Promise<void>;
};

const nodes: TestNode[] = [];
const http = axios.create({ validateStatus: () => true });

const createNode = async (): Promise<TestNode> => {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${(server.address() as { port: number }).port}`;

  const axiosInstance = axios.create({
    headers: { Origin: url },
    timeout: 2000,
  });

  const app = bootstrap(axiosInstance, {
    brokerUrl: "http://localhost:1",
    selfUrl: url,
  });
  server.on("request", app);

  const sent: TestNode["sent"] = [];
  axiosInstance.interceptors.request.use((config) => {
    sent.push({ url: config.url ?? "", data: config.data });
    return config;
  });

  const node: TestNode = {
    url,
    axiosInstance,
    locals: app.locals as AppLocals,
    app,
    messages: app.locals.messages,
    sent,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  nodes.push(node);
  return node;
};

const connect = async (serverA: TestNode, serverB: TestNode, id: string) => {
  serverA.locals.peers.set(id, serverB.url);

  const { status } = await http.post(`${serverA.url}/broker/syn/${id}`);

  assert.equal(status, 202);
};

const deleteConnection = (node: TestNode, target: TestNode) => {
  node.axiosInstance.interceptors.request.use((config) => {
    if (config.url?.startsWith(target.url)) {
      throw new Error("unreachable");
    }

    return config;
  });
};

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((node) => node.close()));
});

test("A finds C through B, handshakes directly and C reads the message", async () => {
  const [serverA, serverB, serverC] = await Promise.all([
    createNode(),
    createNode(),
    createNode(),
  ]);

  await Promise.all([
    connect(serverA, serverB, "B"),
    connect(serverB, serverC, "C"),
  ]);

  const { status } = await http.post(`${serverA.url}/broker/send/C`, {
    action: "hello",
    payload: { text: "hi C" },
  });

  assert.equal(status, 202);
  assert.equal(serverA.locals.peers.get("C"), serverC.url);

  assert.ok(
    serverA.locals.secrets.has(serverC.url),
    "direct handshake A-C done",
  );

  assert.equal(serverC.messages.length, 1);
  assert.deepEqual(serverC.messages[0].payload, { text: "hi C" });
  assert.equal(serverC.messages[0].metadata.source, serverA.url);
});

test("if C is unreachable from A, B relays the message", async () => {
  const [serverA, serverB, serverC] = await Promise.all([
    createNode(),
    createNode(),
    createNode(),
  ]);

  await Promise.all([
    connect(serverA, serverB, "B"),
    connect(serverB, serverC, "C"),
  ]);

  deleteConnection(serverA, serverC);

  const { status } = await http.post(`${serverA.url}/broker/send/C`, {
    action: "hello",
    payload: { text: "via B" },
  });

  assert.equal(status, 202);
  assert.equal(serverC.messages.length, 1);
  assert.deepEqual(serverC.messages[0].payload, { text: "via B" });
  assert.equal(serverC.messages[0].metadata.source, serverA.url);
});

test("an unknown peer id answers 404 and the lookup stops", async () => {
  const [serverA, serverB] = await Promise.all([createNode(), createNode()]);

  await Promise.all([
    connect(serverA, serverB, "B"),
    connect(serverB, serverA, "A"),
  ]);

  const { status } = await http.post(`${serverA.url}/broker/send/D`, {
    action: "hello",
  });

  assert.equal(status, 404);
});

test("requests without security headers are rejected with 401", async () => {
  const serverB = await createNode();

  for (const [method, path] of [
    ["post", "/syn"],
    ["post", "/ingress"],
    ["get", "/health"],
  ] as const) {
    const { status } = await http.request({
      method,
      url: `${serverB.url}${path}`,
      headers: { Origin: "http://localhost:9" },
    });
    assert.equal(status, 401, `${method} ${path}`);
  }
});

test("an invalid keyid gives 401, another key for serverA pinned origin gives 403", async () => {
  const [serverA, serverB] = await Promise.all([
    await createNode(),
    await createNode(),
  ]);

  await connect(serverA, serverB, "B");

  const url = `${serverB.url}/forget`;

  let res = await http.post(url, undefined, {
    headers: { Origin: serverA.url, "Signature-Input": 'sig1=();keyid="abc"' },
  });
  assert.equal(res.status, 401);

  res = await http.post(url, undefined, {
    headers: {
      Origin: serverA.url,
      ...signHeaders({ identity: createIdentity() }),
    },
  });
  assert.equal(res.status, 403);

  res = await http.post(url, undefined, {
    headers: {
      Origin: serverA.url,
      ...signHeaders({ identity: serverA.locals.identity }),
    },
  });
  assert.equal(res.status, 204);
});

test("the tracker push on /register is accepted without security headers", async () => {
  const serverB = await createNode();

  const { status } = await http.post(
    `${serverB.url}/register`,
    [{ id: "x", url: "http://localhost:7" }],
    { headers: { Origin: "http://tracker.test" } },
  );

  assert.equal(status, 204);
  assert.equal(serverB.locals.peers.get("x"), "http://localhost:7");
});

const ingressBody = (serverA: TestNode, serverB: TestNode) => ({
  action: "hello",
  metadata: {
    source: serverA.url,
    target: serverB.url,
    timestamp: new Date().toISOString(),
  },
  payload: { text: "secret" },
});

test("ingress payloads are encrypted on the wire, also through serverA relay", async () => {
  const [serverA, serverB, serverC] = await Promise.all([
    createNode(),
    createNode(),
    createNode(),
  ]);

  await Promise.all([
    connect(serverA, serverB, "B"),
    connect(serverB, serverC, "C"),
  ]);

  deleteConnection(serverA, serverC);

  await http.post(`${serverA.url}/broker/send/C`, {
    action: "hello",
    payload: { text: "secret" },
  });

  const wire = [...serverA.sent, ...serverB.sent].filter(
    (r) => r.url.endsWith("/ingress") || r.url.includes("/broker/relay/"),
  );
  assert.ok(wire.length >= 2, "A->B relay and B->C ingress");

  for (const request of wire) {
    assert.doesNotMatch(JSON.stringify(request.data), /secret/);
    assert.ok((request.data as { payload: { enc: unknown } }).payload.enc);
  }

  assert.deepEqual(serverC.messages[0].payload, { text: "secret" });
});

test("serverA clear payload is rejected with 403", async () => {
  const [serverA, serverB] = await Promise.all([createNode(), createNode()]);
  await connect(serverA, serverB, "B");

  const res = await serverA.axiosInstance.post(
    `${serverB.url}/ingress`,
    ingressBody(serverA, serverB),
    { validateStatus: () => true },
  );
  assert.equal(res.status, 403);
});

test("altered metadata cannot be decrypted (400)", async () => {
  const [serverA, serverB] = await Promise.all([createNode(), createNode()]);
  await connect(serverA, serverB, "B");

  const sealed = sealMessage(
    ingressBody(serverA, serverB),
    serverA.locals.secrets.get(serverB.url)!,
  );

  sealed.metadata.timestamp = new Date(0).toISOString();

  const res = await serverA.axiosInstance.post(
    `${serverB.url}/ingress`,
    sealed,
    {
      validateStatus: () => true,
    },
  );
  assert.equal(res.status, 400);
});

test("the same message sent twice is reported as duplicate (208)", async () => {
  const [serverA, serverB] = await Promise.all([createNode(), createNode()]);
  await connect(serverA, serverB, "B");

  const body = ingressBody(serverA, serverB);
  const secret = serverA.locals.secrets.get(serverB.url)!;

  const send = () =>
    serverA.axiosInstance.post(
      `${serverB.url}/ingress`,
      sealMessage(body, secret),
      {
        validateStatus: () => true,
      },
    );

  assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 208);
});

const waitFor = async (condition: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("a tracker push does not start any handshake", async () => {
  const [serverA, serverB] = await Promise.all([createNode(), createNode()]);

  const { status } = await http.post(
    `${serverA.url}/register`,
    [
      { id: "A", url: serverA.url },
      { id: "B", url: serverB.url },
    ],
    { headers: { Origin: "http://tracker.test" } },
  );

  assert.equal(status, 204);
  assert.equal(serverA.locals.peers.get("B"), serverB.url);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(serverA.locals.secrets.has(serverB.url), false);
});

test("/broker/syn/:id runs the handshake with the peer, both sides share a secret", async () => {
  const [serverA, serverB] = await Promise.all([createNode(), createNode()]);
  serverA.locals.peers.set("B", serverB.url);

  const { status } = await http.post(`${serverA.url}/broker/syn/B`);

  assert.equal(status, 202);
  await waitFor(
    () =>
      serverA.locals.secrets.has(serverB.url) &&
      serverB.locals.secrets.has(serverA.url),
  );
  assert.ok(
    serverA.locals.secrets
      .get(serverB.url)!
      .equals(serverB.locals.secrets.get(serverA.url)!),
  );
});

test("/broker/syn/:id with an unknown id answers 404", async () => {
  const serverA = await createNode();

  const { status } = await http.post(`${serverA.url}/broker/syn/ghost`);

  assert.equal(status, 404);
});

test("the health check forgets serverA peer that does not answer", async () => {
  const [serverA, serverB] = await Promise.all([createNode(), createNode()]);
  await connect(serverA, serverB, "B");

  assert.ok(serverA.locals.knowns.has(serverB.url));
  await serverB.close();

  await checkPeersHealth(serverA.app, serverA.axiosInstance, {
    maxAttempts: 0,
  });

  assert.equal(serverA.locals.knowns.has(serverB.url), false);
  assert.equal(serverA.locals.secrets.has(serverB.url), false);
});

const signedPost = (url: string, origin: string) =>
  http.post(url, undefined, {
    headers: { Origin: origin, ...signHeaders({ identity: createIdentity() }) },
  });

test("/syn-ack from a server never contacted is rejected with 403", async () => {
  const serverA = await createNode();

  const { status } = await signedPost(
    `${serverA.url}/syn-ack`,
    "http://localhost:9",
  );

  assert.equal(status, 403);
  assert.equal(serverA.locals.knowns.has("http://localhost:9"), false);
});

test("/syn whose /syn-ack never arrives is retried, then forgotten (500)", async () => {
  const serverA = await createNode();

  const { status } = await signedPost(
    `${serverA.url}/syn`,
    "http://localhost:1",
  );

  assert.equal(status, 500);
  assert.equal(serverA.locals.knowns.has("http://localhost:1"), false);
  assert.equal(serverA.locals.secrets.has("http://localhost:1"), false);
});

test("/broker/syn/:id to an unreachable peer forgets the attempt", async () => {
  const serverA = await createNode();
  serverA.locals.peers.set("down", "http://localhost:1");

  const { status } = await http.post(`${serverA.url}/broker/syn/down`);

  assert.equal(status, 500);
  assert.equal(serverA.locals.knowns.has("http://localhost:1"), false);
});

test("a peer is forgotten after 5 /health without /pong", async () => {
  const [serverA, serverB] = await Promise.all([createNode(), createNode()]);
  await connect(serverA, serverB, "B");

  serverA.locals.missedPongs.set(serverB.url, 5);
  await checkPeersHealth(serverA.app, serverA.axiosInstance, {
    maxAttempts: 0,
  });

  assert.equal(serverA.locals.knowns.has(serverB.url), false);
  assert.equal(serverA.locals.secrets.has(serverB.url), false);
});

test("a /pong resets the missed-pong counter", async () => {
  const [serverA, serverB] = await Promise.all([createNode(), createNode()]);
  await connect(serverA, serverB, "B");

  serverA.locals.missedPongs.set(serverB.url, 3);
  await checkPeersHealth(serverA.app, serverA.axiosInstance, {
    maxAttempts: 0,
  });

  assert.equal(serverA.locals.missedPongs.has(serverB.url), false);
  assert.ok(serverA.locals.knowns.has(serverB.url));
});
