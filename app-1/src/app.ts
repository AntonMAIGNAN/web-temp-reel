import axios from "axios";
import { bootstrap, startHandshake } from "@web/common";
import { PORT, TARGET_URL, BASE_URL } from "./config.ts";

const axiosInstance = axios.create({
  headers: { Origin: BASE_URL },
  timeout: 5000,
});

const config = {
  baseUrl: BASE_URL,
  targetUrl: TARGET_URL,
};

const app = bootstrap(config, axiosInstance);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);

  startHandshake(app, config, axiosInstance).catch((error) => {
    console.error("Handshake failed:", error);
  });
});
