import { createHash } from 'node:crypto';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { normalizeRemoteUrl, Remote } from './vendor/remote.ts';
import { assertScreened } from './vendor/screen.ts';

const actionFields = {
  resourceId: z.string().min(1).max(2048),
  action: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  accessToken: z.string().regex(/^[\x21-\x7e]{1,8192}$/),
};
const reviewedFields = {
  ...actionFields,
  args: z.record(z.string(), z.unknown()),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
};
const request = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('inspect'), ...actionFields }),
  z.strictObject({ operation: z.literal('prepare'), ...reviewedFields }),
  z.strictObject({ operation: z.literal('execute'), ...reviewedFields, executionId: z.uuid() }),
]);

const annotations = {
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  $schema: z
    .enum([
      'https://json-schema.org/draft/2020-12/schema',
      'http://json-schema.org/draft-07/schema#',
    ])
    .optional(),
};
const bound = z.int().min(0).optional();
const numberBounds = {
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.number().optional(),
  exclusiveMaximum: z.number().optional(),
};
const field = z
  .string()
  .min(1)
  .max(128)
  .refine((name) => !Object.hasOwn(Object.prototype, name));
const values = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
type JsonSchema = Exclude<Parameters<typeof z.fromJSONSchema>[0], boolean>;

function supportedSchema(depth: number): z.ZodType<JsonSchema> {
  if (depth > 8) return z.never();
  const child = z.lazy(() => supportedSchema(depth + 1));
  return z
    .union([
      z
        .strictObject({
          ...annotations,
          type: z.literal('object'),
          additionalProperties: z.literal(false).optional(),
          properties: z.record(field, child).optional(),
          required: z.array(field).max(64).optional(),
          minProperties: bound,
          maxProperties: bound,
        })
        .refine(({ properties, required }) =>
          (required ?? []).every((key) => Object.hasOwn(properties ?? {}, key)),
        )
        .transform((schema) => ({ ...schema, additionalProperties: false as const })),
      z.strictObject({
        ...annotations,
        type: z.literal('array'),
        items: child,
        minItems: bound,
        maxItems: bound,
      }),
      z.strictObject({
        ...annotations,
        type: z.literal('string'),
        minLength: bound,
        maxLength: bound,
        format: z.enum(['uuid', 'date-time', 'date', 'uri', 'email']).optional(),
      }),
      z.strictObject({ ...annotations, type: z.enum(['number', 'integer']), ...numberBounds }),
      z.strictObject({ ...annotations, type: z.enum(['boolean', 'null']) }),
      z.strictObject({
        ...annotations,
        type: z.literal('string'),
        enum: z.array(z.string().max(4096)).min(1).max(64),
      }),
      z.strictObject({ ...annotations, enum: z.array(values).min(1).max(64) }),
      z.strictObject({ ...annotations, const: values }),
      z.strictObject({ ...annotations, anyOf: z.array(child).min(1).max(8) }),
    ])
    .transform((schema) =>
      Object.fromEntries(Object.entries(schema).filter(([, value]) => value !== undefined)),
    );
}

const supportedInput = supportedSchema(0);

function orderedJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child !== 'object' || child === null || Array.isArray(child)) return child;
    return Object.fromEntries(
      Object.entries(child).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

function reviewedTool(url: string, definition: Tool, accessToken: string) {
  const schema = definition.inputSchema;
  const outputSchema = definition.outputSchema;
  const taskSupport = definition.execution?.taskSupport;
  if (taskSupport === 'required') throw new Error('Registered MCP tool requires task execution.');
  const fingerprint = [url, definition.name, schema, outputSchema ?? null, taskSupport ?? null];
  screen(fingerprint, accessToken);
  const validate = z.fromJSONSchema(supportedInput.parse(schema));
  const validateOutput = outputSchema && z.fromJSONSchema(supportedInput.parse(outputSchema));
  const schemaHash = createHash('sha256').update(orderedJson(fingerprint)).digest('hex');
  return { url, tool: definition.name, schema, schemaHash, validate, validateOutput };
}

function screen(value: unknown, accessToken: string) {
  assertScreened(value, [accessToken]);
  const json = JSON.stringify(value);
  const decoded = json.replace(/\\+u([0-9a-f]{4})/gi, (_match, code: string) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  );
  if (decoded !== json) assertScreened(decoded, [accessToken]);
}

function project(result: CallToolResult, accessToken: string) {
  if (result.isError) throw new Error('Registered MCP tool reported an error.');
  const text = result.content.flatMap((entry) => (entry.type === 'text' ? [entry.text] : []));
  const output = {
    ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }),
    ...(text.length > 0 && { text }),
  };
  screen(output, accessToken);
  return output;
}

export async function runRegisteredMcp(value: unknown): Promise<unknown> {
  const parsed = request.safeParse(value);
  if (!parsed.success) return undefined;
  const input = parsed.data;
  let url: string;
  try {
    url = normalizeRemoteUrl(input.resourceId);
    screen([url, input.action], input.accessToken);
  } catch {
    return { failure: 'invalid_destination' };
  }
  if (input.operation !== 'inspect') {
    try {
      screen(input.args, input.accessToken);
    } catch {
      return { failure: 'invalid_args' };
    }
  }

  const remote = new Remote({
    url,
    auth: { kind: 'bearer', token: input.accessToken },
    deferOutputValidation: true,
    callbackUrl: '',
    saveOAuth() {
      throw new Error('Registered MCP uses a saved bearer credential.');
    },
  });
  let failure = 'provider_unavailable';
  const dispatch = { sent: false };
  try {
    if (input.operation === 'execute') {
      let outputValidator: z.ZodType | undefined;
      const result = await remote.call(
        input.action,
        (definition) => {
          failure = 'unsupported_schema';
          const tool = reviewedTool(url, definition, input.accessToken);
          failure = 'schema_changed';
          if (input.schemaHash !== tool.schemaHash)
            throw new Error('Registered tool schema changed.');
          failure = 'invalid_args';
          tool.validate.parse(input.args);
          failure = 'provider_unavailable';
          outputValidator = tool.validateOutput;
          return input.args;
        },
        () => {
          dispatch.sent = true;
        },
      );
      outputValidator?.parse(result.structuredContent);
      return { result: project(result, input.accessToken) };
    }

    const definition = (await remote.discover()).find(({ name }) => name === input.action);
    if (definition === undefined) return { failure: 'unknown_tool' };
    failure = 'unsupported_schema';
    const { validate, schema, schemaHash, tool } = reviewedTool(url, definition, input.accessToken);
    if (input.operation === 'inspect') return { result: { url, tool, schema, schemaHash } };
    if (input.schemaHash !== schemaHash) return { failure: 'schema_changed' };
    if (!validate.safeParse(input.args).success) return { failure: 'invalid_args' };
    return { arguments: input.args, schemaHash };
  } catch {
    return { failure: dispatch.sent ? 'unknown_outcome' : failure };
  }
}
