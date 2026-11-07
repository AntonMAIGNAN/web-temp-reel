import crypto, { type KeyObject } from "node:crypto";
import { type IngressBody } from "./contract.ts";

export type Identity = { keyid: string; privateKey: KeyObject };
export type Encrypted = { iv: string; ct: string; tag: string };

export const createIdentity = (): Identity => {
  const keys = crypto.generateKeyPairSync("x25519");
  const publicKeyAsJson = keys.publicKey.export({ format: "jwk" });

  return { keyid: publicKeyAsJson.x!, privateKey: keys.privateKey };
};

export const toPublicKey = (keyid: string): KeyObject => {
  const bytes = Buffer.from(keyid, "base64url");
  if (bytes.length !== 32) {
    throw new Error("Invalid public key");
  }

  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: keyid },
    format: "jwk",
  });
};

export const deriveSecret = (identity: Identity, peerKeyid: string): Buffer => {
  const peerPublicKey = toPublicKey(peerKeyid);

  const sharedSecret = crypto.diffieHellman({
    privateKey: identity.privateKey,
    publicKey: peerPublicKey,
  });

  return crypto.createHash("sha256").update(sharedSecret).digest();
};

export const encrypt = (
  secret: Buffer,
  data: unknown,
  aad: string,
): Encrypted => {
  const text = JSON.stringify(data ?? null);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from(aad));

  let encrypted = cipher.update(text, "utf8", "base64");
  encrypted += cipher.final("base64");

  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    ct: encrypted,
    tag: tag.toString("base64"),
  };
};

export const decrypt = (
  secret: Buffer,
  enc: Encrypted,
  aad: string,
): unknown => {
  const iv = Buffer.from(enc.iv, "base64");
  const tag = Buffer.from(enc.tag, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", secret, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);

  let text = decipher.update(enc.ct, "base64", "utf8");
  text += decipher.final("utf8");

  return JSON.parse(text);
};

export const sealMessage = (
  message: IngressBody,
  secret: Buffer,
): IngressBody => {
  const aad = JSON.stringify(message.metadata);
  const enc = encrypt(secret, message.payload, aad);

  return {
    action: message.action,
    metadata: message.metadata,
    payload: { enc },
  };
};
