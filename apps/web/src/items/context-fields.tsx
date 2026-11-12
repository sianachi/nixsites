import { Button, Text, useUndo } from '@nix/ui';
import type { ItemProperties } from '@nix/web-collections/properties/use-item-properties';
import { PropertyPanel } from '@nix/web-collections/properties/property-panel';
import type { ReactNode } from 'react';

export function useContextWrite(details: ItemProperties): ItemProperties['write'] {
  const undo = useUndo();
  return async (changes) => {
    const item = details.item;
    if (item === null) return 'This item is unavailable.';
    const before = Object.fromEntries(
      Object.keys(changes).map((key) => [key, item.properties[key] ?? null]),
    );
    const refusal = await details.write(changes);
    if (refusal === null) {
      undo.push(`Updated ${item.title || 'Untitled'}`, async () => {
        const problem = await details.write(before);
        if (problem !== null) throw new Error(problem);
      });
    }
    return refusal;
  };
}

export function ContextFields({
  details,
  fields,
}: {
  readonly details: ItemProperties;
  readonly fields: readonly string[];
}): ReactNode {
  const write = useContextWrite(details);
  if (details.error !== null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Text role="alert" variant="note">
          {details.error}
        </Text>
        <Button variant="secondary" onClick={details.retry}>
          Try again
        </Button>
      </div>
    );
  }
  const item = details.item;
  if (item === null)
    return (
      <Text role="status" variant="note">
        Loading fields…
      </Text>
    );
  const schema = details.schema?.properties ?? [];
  const chosen = fields.flatMap((key) => schema.find((property) => property.key === key) ?? []);
  const properties = chosen.length > 0 ? chosen : schema;
  return (
    <PropertyPanel
      item={item}
      properties={properties}
      compact={chosen.length === 0}
      onChange={write}
    />
  );
}
