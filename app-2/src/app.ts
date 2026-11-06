import axios from "axios";
import {
  bootstrap,
  logger,
  healthCheckLoop,
  registerToBroker,
  unregisterFromBroker,
} from "@web/common";
import { PORT, BASE_URL, BROKER_URL, PEER_ID } from "./config.ts";

const axiosInstance = axios.create({
  headers: { Origin: BASE_URL },
  timeout: 5000,
});

const app = bootstrap(axiosInstance, { brokerUrl: BROKER_URL });

const server = app.listen(PORT, () => {
  logger.info("Server is running", { url: `http://localhost:${PORT}` });

  registerToBroker(axiosInstance, BROKER_URL, {
    id: PEER_ID,
    url: BASE_URL,
  }).catch((error) => {
    logger.error("Broker registration failed", { error });
  });

  healthCheckLoop(app, axiosInstance).catch((error) => {
    logger.error("Handshake failed", { error });
  });
});

const shutdown = async () => {
  await unregisterFromBroker(axiosInstance, BROKER_URL, PEER_ID).catch(
    (error) => logger.error("Broker unregistration failed", { error }),
  );
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
