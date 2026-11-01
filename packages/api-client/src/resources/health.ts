import { z } from 'zod';
import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import type { components } from '../generated/api.js';

const livenessSchema = z.object({
  status: z.literal('healthy'),
}) satisfies z.ZodType<components['schemas']['LivenessResponse']>;

const serviceStatusSchema = z.object({
  service: z.literal('nix-api'),
  version: z.string().min(1),
  utcNow: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<components['schemas']['ServiceStatusResponse']>;

export type Liveness = z.infer<typeof livenessSchema>;
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

/** Public HTTP liveness only; Core does not check its dependencies through this route. */
export function liveness(): QueryEndpoint<Liveness> {
  return defineQuery({
    operation: 'health.liveness',
    path: '/healthz',
    schema: livenessSchema,
    cacheKey: ['health', 'liveness'],
  });
}

/** Public service identity, build version and server clock. */
export function serviceStatus(): QueryEndpoint<ServiceStatus> {
  return defineQuery({
    operation: 'health.serviceStatus',
    path: '/api/v1/health/status',
    schema: serviceStatusSchema,
    cacheKey: ['health', 'status'],
  });
}

const serviceVersionSchema = z.object({
  service: z.string().min(1),
  version: z.string(),
  commit: z.string(),
  reportedAt: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<components['schemas']['ServiceVersionResponse']>;

const systemVersionsSchema = z.object({
  services: z.array(serviceVersionSchema),
}) satisfies z.ZodType<components['schemas']['SystemVersionsResponse']>;

export type ServiceVersion = z.infer<typeof serviceVersionSchema>;
export type SystemVersions = z.infer<typeof systemVersionsSchema>;

/** The release Core and each service that has called it runs, for Settings > About. Signed in. */
export function systemVersions(): QueryEndpoint<SystemVersions> {
  return defineQuery({
    operation: 'health.systemVersions',
    path: '/api/v1/system/versions',
    schema: systemVersionsSchema,
    cacheKey: ['health', 'versions'],
  });
}
