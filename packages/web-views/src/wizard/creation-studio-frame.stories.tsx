import { useState, type ReactNode } from 'react';

import { CreationStudioFrame } from './creation-studio-frame';
import { draftFor, FALLBACK_RECIPE } from './creation-studio-model';
import { BasicsStep, OptionsStep } from './creation-studio-steps';

export default { title: 'Nix/Creation/Guided setup', parameters: { layout: 'fullscreen' } };

const noop = (): void => undefined;

function Example({
  small = false,
  initialStep = 0,
  initialPreviewing = false,
}: {
  readonly small?: boolean;
  readonly initialStep?: number;
  readonly initialPreviewing?: boolean;
}): ReactNode {
  const [draft, setDraft] = useState(() => draftFor(FALLBACK_RECIPE));
  const [step, setStep] = useState(initialStep);
  const [previewing, setPreviewing] = useState(initialPreviewing);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  return (
    <main
      aria-label="Guided setup example"
      className={`flex h-dvh ${small ? 'w-60 max-w-full' : 'w-full'}`}
    >
      <CreationStudioFrame
        recipe={FALLBACK_RECIPE}
        itemId={undefined}
        viewId={undefined}
        destination="Personal workspace"
        intent="create"
        step={step}
        draft={draft}
        existingProperties={[]}
        previewing={previewing}
        saving={false}
        error={error}
        discarding={discarding}
        onStepChange={setStep}
        onError={setError}
        onPreviewToggle={() => {
          setPreviewing((value) => !value);
        }}
        onCancel={() => {
          setDiscarding(true);
        }}
        onFinish={noop}
        onDiscardClose={() => {
          setDiscarding(false);
        }}
        onDiscard={() => {
          setDraft(draftFor(FALLBACK_RECIPE));
          setStep(0);
          setDiscarding(false);
        }}
      >
        {step === 0 ? (
          <BasicsStep recipe={FALLBACK_RECIPE} draft={draft} onChange={setDraft} />
        ) : (
          <OptionsStep draft={draft} existingProperties={[]} onChange={setDraft} />
        )}
      </CreationStudioFrame>
    </main>
  );
}

export const Desktop = { render: (): ReactNode => <Example /> };

function checkCreationFits({ canvasElement }: { readonly canvasElement: HTMLElement }): void {
  const example = canvasElement.querySelector<HTMLElement>('[aria-label="Guided setup example"]');
  const setup = canvasElement.querySelector<HTMLElement>('[aria-label="Guided setup"]');
  if (example === null || setup === null) throw new Error('Guided setup must be visible.');
  if (example.scrollWidth > example.clientWidth || setup.scrollWidth > setup.clientWidth) {
    throw new Error('Guided setup fields and actions must fit within the available pane width.');
  }
  const bounds = example.getBoundingClientRect();
  for (const button of example.querySelectorAll('button')) {
    const rect = button.getBoundingClientRect();
    if (rect.width > 0 && (rect.left < bounds.left || rect.right > bounds.right)) {
      throw new Error('Setup controls must stay reachable inside the narrow pane.');
    }
  }
}

export const SmallScreen = { render: (): ReactNode => <Example small />, play: checkCreationFits };
export const SmallScreenOptions = {
  render: (): ReactNode => <Example small initialStep={1} />,
  play: checkCreationFits,
};
export const SmallScreenPreviewing = {
  render: (): ReactNode => <Example small initialPreviewing />,
  play: ({ canvasElement }: { readonly canvasElement: HTMLElement }): void => {
    const create = [...canvasElement.querySelectorAll('button')].find((button) =>
      button.textContent.startsWith('Create'),
    );
    if (create === undefined || create.getBoundingClientRect().height === 0) {
      throw new Error('Create must stay visible while the preview is open.');
    }
  },
};
export const ConstrainedDesktopOptions = {
  render: (): ReactNode => (
    <div className="w-4xl max-w-full">
      <Example initialStep={1} />
    </div>
  ),
  play: checkCreationFits,
};
export const DarkSmallScreen = { ...SmallScreen, globals: { ground: 'dark' } };
export const DarkSmallScreenOptions = { ...SmallScreenOptions, globals: { ground: 'dark' } };
