import { z } from "zod";

export const OriginHeadersSchema = z.object({
  origin: z.url("Origin header must be a valid URL"),
});

export const IngressMetadataSchema = z.object({
  source: z.url(),
  target: z.url(),
  timestamp: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "Invalid timestamp"),
});
export type IngressMetadata = z.infer<typeof IngressMetadataSchema>;

export const IngressBodySchema = z.object({
  action: z.string().min(1),
  metadata: IngressMetadataSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type IngressBody = z.infer<typeof IngressBodySchema>;

export const PeersResponseSchema = z.array(
  z.object({ id: z.string().min(1), url: z.url() }),
);
export type PeersResponse = z.infer<typeof PeersResponseSchema>;

export const EncryptedPayloadSchema = z.object({
  enc: z.object({ iv: z.string(), ct: z.string(), tag: z.string() }),
});
export type EncryptedPayload = z.infer<typeof EncryptedPayloadSchema>;

export const ClearPayloadSchema = z.record(z.string(), z.unknown()).nullable();

export const LookupBodySchema = z.object({
  reqId: z.string().min(1),
});
export type LookupBody = z.infer<typeof LookupBodySchema>;

export const LookupResponseSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
});

export const SendBodySchema = z.object({
  action: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});
