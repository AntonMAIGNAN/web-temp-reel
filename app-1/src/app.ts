import axios from "axios";
import { bootstrap, logger, healthCheckLoop } from "@web/common";
import { PORT, BASE_URL } from "./config.ts";

const axiosInstance = axios.create({
  headers: { Origin: BASE_URL },
  timeout: 5000,
});

const app = bootstrap(axiosInstance);

app.listen(PORT, () => {
  logger.info("Server is running", { url: `http://localhost:${PORT}` });

  healthCheckLoop(app, axiosInstance).catch((error) => {
    logger.error("Handshake failed", { error });
  });
});
