import {
  isNixApiError,
  items,
  locks,
  templates,
  type Item,
  type TemplateCaptureResult,
  type TemplateDetail,
  type TemplateInput,
  type TemplateInitializationRule,
  type TemplateItem,
  templateInitializationRuleSchema,
} from '@nix/api-client';
import { resolveFieldRef, type SaveSpec } from '@nix/structure-spec';
import type { CompanionPorts } from '../ports.js';
import { checkItem, requirePetItem } from '../guards.js';
import { WorkspaceToolRefusal } from '../tool-args.js';

const MAX_SOURCE_ITEMS = 200;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

export interface SaveAsTemplateClaim {
  toolId: string | undefined;
  claimId: string | undefined;
  approvedFingerprint: string;
  captureFingerprint: string;
  buildLedger?: readonly { nodeId: string; itemId?: string; status?: string }[] | undefined;
}

export interface SaveAsTemplateInput {
  itemId: string;
  title: string;
  spec: SaveSpec;
}

export interface SaveAsTemplateResult {
  templateId: string;
  title: string;
  itemCount: number;
  includedSamples: boolean;
  savedWithInputs: boolean;
  reason?: string;
  restoreFailures?: string[];
}

export interface SourceTreeNode {
  item: Item;
  children: SourceTreeNode[];
  depth: number;
}

class MappingMismatch extends Error {}

/** Reads one bounded source subtree; it performs no mutation. */
export async function readSourceTree(
  ports: CompanionPorts,
  workspaceId: string,
  itemId: string,
  signal: AbortSignal,
): Promise<SourceTreeNode> {
  const root = await checkItem(ports, workspaceId, itemId, signal);
  const flat: Item[] = [root];
  const childrenByParent = new Map<string, Item[]>();

  for (const parent of flat) {
    const children: Item[] = [];
    for await (const child of ports.core.paginate(
      items.listItems(workspaceId, { parentId: parent.id, pageSize: PAGE_SIZE }),
      { signal, forceRefresh: true, maxPages: MAX_PAGES },
    )) {
      if (child.workspaceId !== workspaceId || child.parentId !== parent.id)
        throw new WorkspaceToolRefusal(
          'The item tree changed or left this workspace. No template was saved.',
        );
      requirePetItem(child);
      children.push(child);
      flat.push(child);
      if (flat.length > MAX_SOURCE_ITEMS)
        throw new WorkspaceToolRefusal(
          'This item tree is larger than 200 items. No template was saved.',
        );
    }
    childrenByParent.set(parent.id, children.sort(compareItems));
  }

  function build(item: Item, depth: number): SourceTreeNode {
    return {
      item,
      depth,
      children: (childrenByParent.get(item.id) ?? []).map((child) => build(child, depth + 1)),
    };
  }
  return build(root, 0);
}

/** Captures one approved subtree, temporarily removing sample entries when requested. */
export async function saveAsTemplate(
  ports: CompanionPorts,
  workspaceId: string,
  input: SaveAsTemplateInput,
  claim: SaveAsTemplateClaim,
  signal: AbortSignal,
): Promise<SaveAsTemplateResult> {
  if (!claim.toolId || !claim.claimId) throw new Error('A claimed tool id is required.');
  if (!claim.approvedFingerprint || !claim.captureFingerprint)
    throw new WorkspaceToolRefusal('Review the current source before saving it as a template.');
  const requestOptions = { signal, forceRefresh: true };
  const hasInitialization = Boolean(input.spec.inputs?.length ?? input.spec.rules?.length);
  // A plain capture with samples included needs no sample selection or source-to-template
  // mapping, so Core's preview count and fingerprint stand in for the per-item child walk.
  const source =
    input.spec.includeSamples && !hasInitialization
      ? undefined
      : await readSourceTree(ports, workspaceId, input.itemId, signal);
  if (source === undefined) await checkItem(ports, workspaceId, input.itemId, signal);
  const excludedIds =
    source === undefined || input.spec.includeSamples
      ? new Set<string>()
      : sampleSubtreeIds(source);
  const excludedNodes = source
    ? flatten(source).filter((node) => excludedIds.has(node.item.id))
    : [];
  const attemptedTrash: string[] = [];
  let captured: TemplateCaptureResult | undefined;
  let detail: TemplateDetail | undefined;
  let savedWithInputs = false;
  let reason: string | undefined;
  let operationFailure: unknown;

  try {
    // Sample rows are temporarily trashed before capture. Check their persistent lock state
    // first, since Core's capture lock guard only sees active rows and would otherwise miss a
    // locked sample subtree after this temporary exclusion.
    for (const node of excludedNodes) {
      const lock = await ports.core.query(locks.getItemLock(node.item.id), requestOptions);
      if (lock.selfLocked)
        throw new WorkspaceToolRefusal(
          'This item or something under it is locked. Remove the lock before saving it as a template.',
        );
    }
    // Check the complete approved source immediately before changing sample rows. Core then
    // enforces the projected fingerprint after those rows have been temporarily trashed.
    const current = await ports.core.query(
      templates.previewTemplateCapture(workspaceId, input.itemId, true, !input.spec.includeSamples),
      requestOptions,
    );
    if (
      current.fingerprint !== claim.approvedFingerprint ||
      current.captureFingerprint !== claim.captureFingerprint
    )
      throw new WorkspaceToolRefusal(
        'The source changed since you approved this. Review it again before saving.',
      );
    if (source === undefined && current.itemCount > MAX_SOURCE_ITEMS)
      throw new WorkspaceToolRefusal(
        'This item tree is larger than 200 items. No template was saved.',
      );
    for (const node of excludedNodes.slice().sort((left, right) => right.depth - left.depth)) {
      attemptedTrash.push(node.item.id);
      await ports.core.execute(items.deleteItem(workspaceId, node.item.id), requestOptions);
    }

    const idempotencyKey = petIdempotencyKey(claim.toolId, claim.claimId);
    const captureRequest = {
      workspaceId,
      sourceItemId: input.itemId,
      title: input.title,
      description: input.spec.description ?? null,
      includeBody: true,
      includeChildren: true,
      idempotencyKey,
      expectedFingerprint: claim.captureFingerprint,
    };
    const initial = await ports.collab.execute(
      templates.captureTemplate(captureRequest),
      requestOptions,
    );
    captured = await templates.resumeTemplateFileTransfer(
      ports.collab,
      initial,
      () => ports.collab.execute(templates.captureTemplate(captureRequest), requestOptions),
      signal,
    );
    detail = await ports.core.query(templates.templateById(captured.templateId), requestOptions);

    if (hasInitialization && source) {
      const draft = await ports.collab.execute(
        templates.beginTemplateDraft(captured.templateId, idempotencyKey),
        requestOptions,
      );
      let rules: TemplateInitializationRule[];
      try {
        const sourceToTemplate = pairSourceAndTemplate(
          source,
          detail.root,
          excludedIds,
          input.title,
        );
        rules = mapRules(
          input.spec.rules ?? [],
          input.spec.inputs ?? [],
          source,
          detail,
          sourceToTemplate,
          claim.buildLedger ?? [],
        );
      } catch (error) {
        if (!(error instanceof MappingMismatch)) throw error;
        reason = error.message;
        await ports.collab.execute(
          templates.discardTemplateDraft(captured.templateId, draft.operationId),
          requestOptions,
        );
        rules = [];
      }

      if (reason === undefined) {
        const initialization = {
          version: 1 as const,
          inputs: toTemplateInputs(input.spec.inputs ?? []),
          rules,
          references: [],
        };
        try {
          await ports.collab.execute(
            templates.updateTemplateDraft(captured.templateId, draft.operationId, {
              initialization,
            }),
            requestOptions,
          );
        } catch (error) {
          reason = error instanceof Error ? error.message : 'Template inputs could not be saved.';
          await ports.collab.execute(
            templates.discardTemplateDraft(captured.templateId, draft.operationId),
            requestOptions,
          );
        }
        if (reason === undefined) {
          await ports.collab.execute(
            templates.saveTemplateDraft(captured.templateId, workspaceId, draft.operationId),
            requestOptions,
          );
          savedWithInputs = true;
        }
      }
    }
  } catch (error) {
    operationFailure = error;
  }

  const restoreFailures: string[] = [];
  const cleanupOptions = { forceRefresh: true };
  for (const itemToRestore of attemptedTrash.slice().reverse()) {
    try {
      // Core's restore handler is idempotent for a visible, already-active row. Always issue it:
      // a delete may have committed even when its response was lost, and reading the trash first
      // would itself be ambiguous across that failure boundary.
      await ports.core.execute(items.restoreItem(workspaceId, itemToRestore), cleanupOptions);
    } catch {
      restoreFailures.push(itemToRestore);
    }
  }

  if (operationFailure !== undefined) {
    const message =
      operationFailure instanceof Error ? operationFailure.message : 'Template capture failed.';
    if (restoreFailures.length > 0)
      throw new WorkspaceToolRefusal(
        `${message} These sample items could not be restored: ${restoreFailures.join(', ')}.`,
      );
    if (isNixApiError(operationFailure) && operationFailure.code === 'templates.source_locked')
      throw new WorkspaceToolRefusal(operationFailure.message);
    if (isNixApiError(operationFailure) && operationFailure.code === 'templates.conflict')
      throw new WorkspaceToolRefusal(operationFailure.message);
    throw operationFailure instanceof Error ? operationFailure : new Error(message);
  }
  if (captured === undefined || detail === undefined)
    throw new Error('Template capture did not return a saved template.');

  return {
    templateId: captured.templateId,
    title: detail.title,
    itemCount: countTemplateItems(detail.root),
    includedSamples: input.spec.includeSamples,
    savedWithInputs,
    ...(reason === undefined ? {} : { reason }),
    ...(restoreFailures.length === 0 ? {} : { restoreFailures }),
  };
}

function sampleSubtreeIds(root: SourceTreeNode): Set<string> {
  const excluded = new Set<string>();
  function visit(node: SourceTreeNode, excludedByParent: boolean): void {
    const isSample = excludedByParent || (node !== root && node.item.title.startsWith('Sample: '));
    if (isSample) excluded.add(node.item.id);
    for (const child of node.children) visit(child, isSample);
  }
  visit(root, false);
  return excluded;
}

function flatten(root: SourceTreeNode): SourceTreeNode[] {
  const nodes = [root];
  for (const node of nodes) nodes.push(...node.children);
  return nodes;
}

function compareItems(left: Item, right: Item): number {
  const leftSeq = BigInt(left.seq);
  const rightSeq = BigInt(right.seq);
  return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : left.id.localeCompare(right.id);
}

function pairSourceAndTemplate(
  source: SourceTreeNode,
  template: TemplateItem,
  excludedIds: ReadonlySet<string>,
  capturedRootTitle: string,
): Map<string, string> {
  const mapping = new Map<string, string>();
  function pair(sourceNode: SourceTreeNode, templateNode: TemplateItem): void {
    const expectedTitle = sourceNode === source ? capturedRootTitle : sourceNode.item.title;
    if (expectedTitle !== templateNode.title || String(sourceNode.item.seq) !== templateNode.seq)
      throw new MappingMismatch(`Template item mismatch at '${sourceNode.item.title}'.`);
    mapping.set(sourceNode.item.id, templateNode.sourceId);
    const expected = sourceNode.children.filter((child) => !excludedIds.has(child.item.id));
    if (expected.length !== templateNode.children.length)
      throw new MappingMismatch(`Template children do not match below '${sourceNode.item.title}'.`);
    const templateChildren = new Map(templateNode.children.map((child) => [child.seq, child]));
    for (const child of expected) {
      const templateChild = templateChildren.get(String(child.item.seq));
      if (templateChild === undefined)
        throw new MappingMismatch(
          `Template child position does not match below '${sourceNode.item.title}'.`,
        );
      pair(child, templateChild);
    }
  }
  pair(source, template);
  return mapping;
}

function mapRules(
  rules: NonNullable<SaveSpec['rules']>,
  inputs: NonNullable<SaveSpec['inputs']>,
  source: SourceTreeNode,
  detail: TemplateDetail,
  sourceToTemplate: ReadonlyMap<string, string>,
  buildLedger: SaveAsTemplateClaim['buildLedger'],
): TemplateInitializationRule[] {
  const sourceNodes = new Map(flatten(source).map((node) => [node.item.id, node]));
  const templateNodes = new Map<string, TemplateItem>();
  function visit(node: TemplateItem): void {
    templateNodes.set(node.sourceId, node);
    node.children.forEach(visit);
  }
  visit(detail.root);
  const inputKeys = new Set(inputs.map((input) => input.key));

  return rules.map((rule) => {
    const sourceItemId = isUuid(rule.node)
      ? rule.node
      : buildLedger?.find(
          (entry) =>
            entry.nodeId === rule.node && entry.status !== 'failed' && entry.status !== 'skipped',
        )?.itemId;
    if (!sourceItemId || !sourceNodes.has(sourceItemId))
      throw new MappingMismatch(`Rule target '${rule.node}' is not in the captured source tree.`);
    const templateSourceId = sourceToTemplate.get(sourceItemId);
    if (templateSourceId === undefined)
      throw new MappingMismatch(`Rule target '${rule.node}' was excluded from the template.`);
    const templateNode = templateNodes.get(templateSourceId);
    if (templateNode === undefined)
      throw new MappingMismatch(`Rule target '${rule.node}' has no matching template item.`);
    const field = resolveFieldRef(rule.field, {
      existing: templateNode.schema?.properties ?? [],
      added: [],
    });
    if (!field.ok)
      throw new MappingMismatch(`Rule field '${rule.field}' no longer matches '${rule.node}'.`);
    if ((rule.kind === 'input' || rule.kind === 'relativeDate') && !inputKeys.has(rule.input ?? ''))
      throw new MappingMismatch(`Rule input '${rule.input ?? ''}' is not declared.`);

    const base = { sourceId: templateSourceId, propertyKey: field.key };
    switch (rule.kind) {
      case 'keep':
      case 'clear':
        return templateInitializationRuleSchema.parse({ ...base, kind: rule.kind });
      case 'set':
        if (rule.value === undefined || rule.value === null)
          throw new MappingMismatch(`Rule '${rule.node}.${rule.field}' has no value.`);
        return templateInitializationRuleSchema.parse({ ...base, kind: 'set', value: rule.value });
      case 'input': {
        if (rule.input === undefined)
          throw new MappingMismatch(`Rule '${rule.node}.${rule.field}' has no input.`);
        return templateInitializationRuleSchema.parse({
          ...base,
          kind: 'input',
          inputKey: rule.input,
        });
      }
      case 'relativeDate': {
        if (rule.input === undefined || rule.offsetDays === undefined)
          throw new MappingMismatch(
            `Rule '${rule.node}.${rule.field}' has incomplete relative-date settings.`,
          );
        return templateInitializationRuleSchema.parse({
          ...base,
          kind: 'relativeDate',
          inputKey: rule.input,
          offsetDays: rule.offsetDays,
          timeOfDay: null,
          timeZone: null,
        });
      }
    }
  });
}

function toTemplateInputs(inputs: NonNullable<SaveSpec['inputs']>): TemplateInput[] {
  return inputs.map((input) => ({
    key: input.key,
    label: input.label,
    type: input.type,
    required: input.required ?? false,
    defaultValue: input.default ?? null,
  }));
}

function countTemplateItems(root: TemplateItem): number {
  return 1 + root.children.reduce((count, child) => count + countTemplateItems(child), 0);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function petIdempotencyKey(toolId: string, claimId: string): string {
  const key = `pet:${toolId}:${claimId}`;
  if (key.length > 160)
    throw new WorkspaceToolRefusal('The tool claim cannot be safely keyed for template capture.');
  return key;
}
