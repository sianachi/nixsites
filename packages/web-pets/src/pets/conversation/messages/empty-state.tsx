import { type PetProfile, type PetSettings } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { type ReactElement } from 'react';
import { PetAvatar } from '../../pet-avatar';

/** The pet itself, then at most three ways to begin. */
export function PetEmptyState({
  pet,
  settings,
  workspaceAccess,
  suggestions,
  onPick,
}: {
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly workspaceAccess: boolean;
  readonly suggestions: readonly string[];
  readonly onPick: (suggestion: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <PetAvatar
        appearance={pet.appearance}
        motion={settings.motion}
        state="idle"
        label={`${pet.name}: ready`}
      />
      {workspaceAccess ? null : (
        <Text variant="note" tone="muted" className="text-center">
          {`Turn on Workspace in + to let ${pet.name} use your notes.`}
        </Text>
      )}
      <div className="flex w-full flex-col items-stretch gap-2">
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            variant="secondary"
            className="justify-start"
            onClick={() => {
              onPick(suggestion);
            }}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}

// "Summarize this page" and its siblings only make sense with an item open. "Plan my week" is
// left out until the owner confirms it.
export function petSuggestions(hasItem: boolean): readonly string[] {
  return hasItem
    ? ['Summarize this page', 'Turn this note into views', 'Find notes about ']
    : ['Find notes about '];
}
