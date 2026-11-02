import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { MirrorItem } from '@nix/sync-core/mirror';

import type { ViewAnswer, ViewRequest, ViewSource } from './types';

/**
 * A golden fixture, shared with the C# replay
 * (backend/tests/Nix.Integration.Tests/ViewCompute/ViewComputeFixtures.cs).
 * Items are named by `key`; anywhere an id appears (request path, body, expected answer) it is
 * written `{key}`, and the workspace is `{workspace}`.
 */
export interface Fixture {
  readonly name: string;
  /** Core's clock for this read, ISO 8601. */
  readonly now: string;
  readonly items: readonly FixtureItem[];
  readonly request: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly body?: unknown;
  };
  readonly expected: ViewAnswer;
}

/** One item, in sibling order under its parent. Omitted fields take Core's defaults. */
export interface FixtureItem {
  readonly key: string;
  readonly parent: string | null;
  readonly type: string;
  readonly title: string;
  readonly properties?: Record<string, unknown>;
  readonly schema?: Record<string, unknown> | null;
  readonly views?: Record<string, unknown> | null;
  readonly recurrence?: Record<string, unknown> | null;
  readonly createdAt?: string;
}

const WORKSPACE = 'workspace';

/** A stable UUID for a fixture key, so failures name the same ids every run. */
export function fixtureId(key: string): string {
  const hex = createHash('sha256').update(`nix-fixture:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function keysToIds(text: string, keys: readonly string[]): string {
  return text.replace(/\{([A-Za-z0-9_.-]+)\}/g, (whole, key: string) =>
    key === WORKSPACE || keys.includes(key) ? fixtureId(key) : whole,
  );
}

/** Writes ids back as `{key}`, so answers compare against the fixture's expected JSON. */
export function idsToKeys(value: unknown, keys: readonly string[]): unknown {
  const names = new Map([WORKSPACE, ...keys].map((key) => [fixtureId(key), `{${key}}`]));
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      let out = node;
      for (const [id, name] of names) out = out.split(id).join(name);
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object')
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [walk(k) as string, walk(v)]));
    return node;
  };
  return walk(value);
}

export function fixtureItems(fixture: Fixture): MirrorItem[] {
  const workspaceId = fixtureId(WORKSPACE);
  return fixture.items.map((item, index) => ({
    id: fixtureId(item.key),
    workspaceId,
    parentId: item.parent === null ? null : fixtureId(item.parent),
    type: item.type,
    title: item.title,
    seq: index + 1,
    revision: String(index + 1),
    lifecycleState: 'active',
    properties: item.properties ?? {},
    computedProperties: null,
    schema: item.schema ?? null,
    views: item.views ?? null,
    recurrence: item.recurrence ?? null,
    noDelete: false,
    noChildren: false,
    managedBy: null,
    createdAt: item.createdAt ?? fixture.now,
    updatedAt: null,
    canWrite: true,
    locked: false,
    canPersistBody: true,
    metadataExpiresAt: null,
    bodyDocId: null,
    bodyHeadSeq: null,
    file: null,
  }));
}

export function fixtureSource(fixture: Fixture): ViewSource {
  const items = fixtureItems(fixture);
  return {
    item: (id) => Promise.resolve(items.find((item) => item.id === id)),
    workspaceItems: (workspaceId) =>
      Promise.resolve(items.filter((item) => item.workspaceId === workspaceId)),
    now: () => new Date(fixture.now),
  };
}

export function fixtureRequest(fixture: Fixture): ViewRequest {
  const keys = fixture.items.map((item) => item.key);
  const body =
    fixture.request.body === undefined
      ? null
      : (JSON.parse(keysToIds(JSON.stringify(fixture.request.body), keys)) as unknown);
  return {
    method: fixture.request.method,
    url: new URL(keysToIds(fixture.request.path, keys), 'https://nix.test'),
    body,
  };
}

/** Every fixture of one slice, from fixtures/<slice>/*.json. */
export function loadFixtures(slice: string): Fixture[] {
  const folder = join(import.meta.dirname, '..', 'fixtures', slice);
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')) as Fixture);
}
