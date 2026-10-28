import { z } from 'zod';
import type { components } from '../generated/api.js';

const positiveIntegerSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^[1-9]\d*$/),
]);
const digestSchema = z.string().regex(/^[0-9A-F]{64}$/);

const pluginCapabilitySchema = z.literal('items.read-metadata');

export const pluginInstallationSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  publisherId: z.string().min(3).max(128),
  componentId: z.string().min(1).max(257),
  version: z.string().min(1).max(64),
  sha256: digestSchema,
  byteLength: positiveIntegerSchema,
  enabled: z.boolean(),
  capabilities: z.array(pluginCapabilitySchema).max(32),
  installedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const pluginComponentUploadSchema = z.object({
  objectKey: z.string().min(1).max(1024),
  uploadUrl: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  ifNoneMatch: z.literal('*'),
  xAmzChecksumSha256: z.string().min(44).max(44),
});

export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;
export type PluginInstallation = z.infer<typeof pluginInstallationSchema>;
export type PluginComponentUpload = z.infer<typeof pluginComponentUploadSchema>;

const _installationContract = pluginInstallationSchema satisfies z.ZodType<
  components['schemas']['PluginInstallationResponse']
>;
const _uploadContract = pluginComponentUploadSchema satisfies z.ZodType<
  components['schemas']['PluginComponentUploadResponse']
>;
void [_installationContract, _uploadContract];
