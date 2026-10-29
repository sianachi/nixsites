import { type PetConnection } from '@nix/api-client';
import { Button, Icon, Text } from '@nix/ui';
import { ArrowLeft } from 'lucide-react';
import { type ComponentProps, type ReactElement, type RefObject } from 'react';
import { PetHistory } from '../../pet-history';

export function HistoryPanel({
  headingRef,
  onBack,
  onResumed,
  ...history
}: {
  readonly headingRef: RefObject<HTMLDivElement | null>;
  readonly onBack: () => void;
  readonly onResumed: (resumed: PetConnection) => void;
} & Omit<ComponentProps<typeof PetHistory>, 'onResumed'>): ReactElement {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3 @sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          <Icon icon={ArrowLeft} size="sm" />
          Back
        </Button>
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <Text as="h3" variant="h3">
            Past conversations
          </Text>
        </div>
      </div>
      <PetHistory {...history} onResumed={onResumed} />
    </div>
  );
}
