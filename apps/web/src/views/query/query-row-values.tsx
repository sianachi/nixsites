import { isNixApiError, structure as coreStructure } from '@nix/api-client';
import { useState, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { PropertyInput, isKnownPropertyType } from '../../collections/properties/property-input';
import type { PropertyDefinition, PropertyValue } from '../../collections/core/container-model';
import { ValuePopover, useTrackWrite } from '../../collections/properties/value-popover';

/**
 * One matched value of a query row, editable in place through the same popover the phone list
 * uses. The row comes from another container, so the write goes straight to the item; the caller
 * re-runs the query afterwards, because a changed value may take the row out of the list.
 */
export function QueryRowValue(props: {
  readonly itemId: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly property: PropertyDefinition;
  readonly onSaved: () => void;
}): ReactNode {
  const { itemId, title, properties, property, onSaved } = props;
  const client = useApiClient();
  const [refusal, setRefusal] = useState<string | null>(null);
  const owner = { title, properties };

  async function write(value: PropertyValue): Promise<boolean> {
    setRefusal(null);
    try {
      await client.execute(coreStructure.setItemProperties(itemId, { [property.key]: value }));
      onSaved();
      return true;
    } catch (reason) {
      setRefusal(
        isNixApiError(reason)
          ? (reason.detail ?? 'That change could not be saved.')
          : 'That change could not be sent. Check the connection and try again.',
      );
      return false;
    }
  }

  return (
    <ValuePopover item={owner} property={property} density="cell" labelled>
      <RowEditor owner={owner} property={property} refusal={refusal} write={write} />
    </ValuePopover>
  );
}

/** The editor inside the popover, so it can reach the popover's "stored" signal. */
function RowEditor(props: {
  readonly owner: {
    readonly title: string;
    readonly properties: Readonly<Record<string, unknown>>;
  };
  readonly property: PropertyDefinition;
  readonly refusal: string | null;
  readonly write: (value: PropertyValue) => Promise<boolean>;
}): ReactNode {
  const trackWrite = useTrackWrite();
  return (
    <PropertyInput
      item={props.owner}
      property={props.property}
      density="panel"
      error={props.refusal}
      onCommit={(value) => {
        trackWrite(props.write(value));
      }}
    />
  );
}

/** Whether a rule's property can be edited from a row: declared here, of a type this build knows. */
export function editableDefinition(
  schema: readonly PropertyDefinition[],
  key: string,
): PropertyDefinition | undefined {
  const definition = schema.find((candidate) => candidate.key === key);
  return definition !== undefined && isKnownPropertyType(definition.type) ? definition : undefined;
}
