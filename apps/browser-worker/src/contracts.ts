import { z } from 'zod';

const url = z.url().max(2048);
const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}]+$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const fields = z.array(z.strictObject({ name, value: z.string().max(8192) })).max(40);
export const siteSessionSchema = z.strictObject({
  origin: url,
  cookies: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[!#$%&'*+.^_\x60|~\w-]+$/),
        value: z
          .string()
          .min(8)
          .max(4096)
          .regex(/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/),
        path: z
          .string()
          .min(1)
          .max(512)
          .startsWith('/')
          .regex(/^[^\p{Cc} ;]+$/u),
      }),
    )
    .max(32),
});

const attachmentShape = {
  field: name,
  filename: z
    .string()
    .min(1)
    .max(180)
    .regex(/^[^\p{Cc}/\\"]+$/u),
  contentType: z
    .string()
    .max(90)
    .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
  size: z
    .number()
    .int()
    .positive()
    .max(4 << 20),
  sha256: digest,
};
const attachments = z.array(z.strictObject(attachmentShape)).max(4);
const attachmentInputs = z.array(z.strictObject({ ...attachmentShape, source: url })).max(4);
const formIndex = z.number().int().min(0).max(19);
export const proposalSchema = z.strictObject({
  pageUrl: url,
  target: url,
  method: z.literal('POST'),
  formIndex,
  fields,
  attachments,
  revision: digest,
});

export const commandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('search'), query: z.string().trim().min(1).max(512) }),
  z.strictObject({
    operation: z.literal('browse'),
    url,
    session: siteSessionSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal('submit'),
    actionId: z.uuid(),
    proposal: proposalSchema,
    attachments: attachmentInputs.default([]),
    session: siteSessionSchema.optional(),
  }),
]);

export type BrowserCommand = z.infer<typeof commandSchema>;
export type SiteSession = z.infer<typeof siteSessionSchema>;
export type FormProposal = z.infer<typeof proposalSchema>;
export type Attachment = FormProposal['attachments'][number];

export class BrowserFault extends Error {
  readonly code: string;
  readonly dispatched: boolean;

  constructor(code: string, dispatched = false) {
    super(code);
    this.code = code;
    this.dispatched = dispatched;
  }
}
