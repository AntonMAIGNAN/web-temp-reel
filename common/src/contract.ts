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
