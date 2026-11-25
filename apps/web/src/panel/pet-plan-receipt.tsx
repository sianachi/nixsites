import type { PetPlanReceiptView } from '@nix/api-client';
import { Text } from '@nix/ui';
import { ValueFields } from '@nix/web-pets/pets/approval/value-fields';
import type { ReactElement } from 'react';

export function PetPlanReceipt({ view }: { readonly view: PetPlanReceiptView }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Text>{view.summary}</Text>
      {view.details == null ? null : <ValueFields label="Observed result" value={view.details} />}
      {view.text == null || view.text === view.summary ? null : (
        <Text className="whitespace-pre-wrap">{view.text}</Text>
      )}
    </div>
  );
}
