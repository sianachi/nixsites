import type { TemplateInitializationRule, TemplateInput, TemplateItem } from '../template-api';

export interface TargetOption {
  readonly sourceId: string;
  readonly itemTitle: string;
  readonly propertyKey: string;
  readonly label: string;
  readonly type: string;
  readonly options: readonly string[];
}

export function collectTargets(root: TemplateItem): readonly TargetOption[] {
  const items: TemplateItem[] = [];
  const visit = (item: TemplateItem): void => {
    items.push(item);
    item.children.forEach(visit);
  };
  visit(root);
  return items.flatMap((item) => [
    ...(item.schema?.properties ?? [])
      .filter((property) => !['formula', 'rollup'].includes(property.type.toLocaleLowerCase()))
      .map((property) => ({
        sourceId: item.sourceId,
        itemTitle: item.title,
        propertyKey: property.key,
        label: `${item.title} · ${property.label}`,
        type: property.type,
        options: property.options,
      })),
    ...(item.recurrence == null
      ? []
      : [
          {
            sourceId: item.sourceId,
            itemTitle: item.title,
            propertyKey: 'recurrence.until',
            label: `${item.title} · Series end date`,
            type: 'date',
            options: [],
          },
        ]),
  ]);
}

export function targetKey(target: {
  readonly sourceId: string;
  readonly propertyKey: string;
}): string {
  return `${target.sourceId}:${target.propertyKey}`;
}

export function targetFromRule(rule: TemplateInitializationRule): TargetOption {
  return {
    sourceId: rule.sourceId,
    itemTitle: 'Selected item',
    propertyKey: rule.propertyKey,
    label: rule.propertyKey === 'recurrence.until' ? 'Series end date' : rule.propertyKey,
    type: rule.propertyKey === 'recurrence.until' ? 'date' : 'text',
    options: [],
  };
}

export function createRule(
  target: TargetOption,
  kind: string,
  inputs: readonly TemplateInput[],
): TemplateInitializationRule {
  const base = { sourceId: target.sourceId, propertyKey: target.propertyKey };
  if (kind === 'clear') return { ...base, kind: 'clear' };
  if (kind === 'set') return { ...base, kind: 'set', value: '' };
  if (kind === 'input') {
    const candidate = inputs.find((input) => compatibleInput(input.type, target.type));
    return { ...base, kind: 'input', inputKey: candidate?.key ?? '' };
  }
  if (kind === 'relativeDate') {
    return {
      ...base,
      kind: 'relativeDate',
      inputKey: availableDateInputs(inputs)[0]?.key ?? '',
      offsetDays: 0,
      timeOfDay: null,
      timeZone: null,
    };
  }
  return { ...base, kind: 'keep' };
}

export function compatibleInput(
  inputType: TemplateInput['type'],
  propertyType: string | undefined,
): boolean {
  if (propertyType === undefined) return inputType === 'text';
  const type = propertyType.toLocaleLowerCase();
  if (type.includes('date') || type.includes('time')) return inputType === 'date';
  if (type.includes('member') || type.includes('person') || type === 'assignee')
    return inputType === 'member';
  return (type === 'text' || type === 'long_text') && inputType === 'text';
}

export function withOptionalDefault(
  input: TemplateInput,
  value: string | undefined,
): TemplateInput {
  return { ...input, defaultValue: value ?? null };
}

export function requiredSetValue(
  value: unknown,
): Extract<TemplateInitializationRule, { kind: 'set' }>['value'] {
  return value ?? '';
}

export function availableDateInputs(inputs: readonly TemplateInput[]): readonly TemplateInput[] {
  return inputs.filter((input) => input.type === 'date');
}

export function firstItemInput(inputs: readonly TemplateInput[]): string {
  return inputs.find((input) => input.type === 'item')?.key ?? '';
}
