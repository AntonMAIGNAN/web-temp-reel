import { type InternalAxiosRequestConfig } from "axios";
import { type Request } from "express";
import { toPublicKey, type Identity } from "./crypto.ts";

const INPUT_RE = /^sig1=\(\);keyid="([A-Za-z0-9_-]+)"$/;

export const signHeaders = ({ identity }: { identity: Identity }) => ({
  "Signature-Input": `sig1=();keyid="${identity.keyid}"`,
});

export const createSigner =
  (identity: Identity) => (config: InternalAxiosRequestConfig) => {
    for (const [name, value] of Object.entries(signHeaders({ identity }))) {
      config.headers.set(name, value);
    }

    return config;
  };

export const verifyRequest = (
  req: Request,
): { ok: true; keyid: string } | { ok: false; error: string } => {
  const input = req.get("signature-input");

  if (!input || !req.get("origin")) {
    return { ok: false, error: "Signature-Input header required" };
  }

  const match = INPUT_RE.exec(input);
  if (!match) {
    return { ok: false, error: "Unsupported Signature-Input format" };
  }

  try {
    toPublicKey(match[1]);
  } catch {
    return { ok: false, error: "Invalid keyid" };
  }

  return { ok: true, keyid: match[1] };
};
