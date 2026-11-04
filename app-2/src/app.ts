import axios from "axios";
import { bootstrap, startHandshake } from "@web/common";
import { PORT, BASE_URL } from "./config.ts";

const axiosInstance = axios.create({
  headers: { Origin: BASE_URL },
  timeout: 5000,
});

const config = {
  baseUrl: BASE_URL,
};

const app = bootstrap(axiosInstance);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);

  startHandshake(app, axiosInstance).catch((error) => {
    console.error("Handshake failed:", error);
  });
});
