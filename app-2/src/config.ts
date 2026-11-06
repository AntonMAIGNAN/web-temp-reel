export const PORT = process.env.PORT ?? (3001 as const);
export const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
export const PEER_ID = process.env.PEER_ID ?? "app-2";
export const BROKER_URL = process.env.BROKER_URL ?? "http://localhost:4000";
