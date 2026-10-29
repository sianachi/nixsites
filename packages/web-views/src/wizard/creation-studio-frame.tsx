import { Button, Dialog, Icon, Text, cn, focusRing } from '@nix/ui';
import { ArrowLeft, ArrowRight, Check, Eye } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import type { PropertyDefinition } from '@nix/web-collections/core/container-model';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';
import {
  STEPS,
  validateDraft,
  validateStep,
  type StudioDraft,
  type StudioIntent,
} from './creation-studio-model';
import type { StructuredRecipe } from './structured-recipes';
import { StudioPreview } from './creation-studio-preview';

export function CreationStudioFrame({
  recipe,
  itemId,
  viewId,
  destination,
  intent,
  step,
  draft,
  existingProperties,
  previewing,
  saving,
  error,
  discarding,
  onStepChange,
  onError,
  onPreviewToggle,
  onCancel,
  onFinish,
  onDiscardClose,
  onDiscard,
  children,
}: {
  readonly recipe: StructuredRecipe;
  readonly itemId: string | undefined;
  readonly viewId: string | undefined;
  readonly destination: string;
  readonly intent: StudioIntent;
  readonly step: number;
  readonly draft: StudioDraft;
  readonly existingProperties: readonly PropertyDefinition[];
  readonly previewing: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly discarding: boolean;
  readonly onStepChange: (step: number) => void;
  readonly onError: (error: string | null) => void;
  readonly onPreviewToggle: () => void;
  readonly onCancel: () => void;
  readonly onFinish: () => void;
  readonly onDiscardClose: () => void;
  readonly onDiscard: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const zen = useZenActive();
  const stepMainRef = useRef<HTMLElement>(null);
  const previousStep = useRef(step);

  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const heading = stepMainRef.current?.querySelector<HTMLElement>('h2');
    if (heading === null || heading === undefined) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [step]);

  useEffect(() => {
    if (discarding) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [discarding, onCancel]);

  function focusFirstField(): void {
    queueMicrotask(() => {
      stepMainRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    });
  }

  function goToStep(nextStep: number): void {
    if (nextStep <= step) {
      onError(null);
      onStepChange(nextStep);
      return;
    }

    for (let candidate = step; candidate < nextStep; candidate += 1) {
      const reason = validateStep(candidate, draft, existingProperties);
      if (reason !== null) {
        onStepChange(candidate);
        onError(reason);
        focusFirstField();
        return;
      }
    }

    onError(null);
    onStepChange(nextStep);
  }

  return (
    <div className="@container/studio flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className={`flex min-w-0 shrink-0 items-center gap-2 border-b border-divider px-3 py-2 ${zen ? 'pr-16' : ''}`}
      >
        <Button variant="icon" aria-label="Cancel guided setup" onClick={onCancel}>
          <Icon icon={ArrowLeft} size="sm" />
        </Button>
        <div className="min-w-0 flex-1">
          <Text variant="h4" as="h1" className="truncate">
            {itemId === undefined
              ? `New ${recipe.label}`
              : viewId === undefined
                ? `Add ${recipe.label} view`
                : `Edit ${recipe.label}`}
          </Text>
          <Text variant="note" tone="muted" className="mt-0.5 block truncate">
            {itemId === undefined
              ? `Creating in ${destination}`
              : viewId === undefined
                ? `Adding to ${destination}`
                : `Editing in ${destination}`}
          </Text>
        </div>
        <Button
          variant="icon"
          className="shrink-0 @4xl/studio:hidden"
          aria-label={previewing ? 'Hide preview' : 'Preview'}
          aria-expanded={previewing}
          aria-controls="creation-studio-preview"
          onClick={onPreviewToggle}
        >
          <Icon icon={Eye} size="sm" />
        </Button>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col @4xl/studio:flex-row">
        <nav
          aria-label="Creation steps"
          className="min-w-0 shrink-0 border-b border-divider bg-surface p-2 @4xl/studio:w-44 @4xl/studio:border-b-0 @4xl/studio:border-r"
        >
          <ol className="grid grid-cols-2 gap-1 @4xl/studio:flex @4xl/studio:flex-col @4xl/studio:gap-2">
            {STEPS.map((entry, index) => (
              <li key={entry.id} className="min-w-0">
                <button
                  type="button"
                  aria-current={step === index ? 'step' : undefined}
                  aria-label={`${entry.label}: ${entry.detail}`}
                  onClick={() => {
                    goToStep(index);
                  }}
                  className={cn(
                    `flex min-h-(--control-lg) w-full flex-row items-center gap-2 rounded-md px-2 py-1 ${focusRing}`,
                    step === index ? 'bg-foreground/10 text-foreground' : 'hover:bg-foreground/7',
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background">
                    {index < step ? <Icon icon={Check} size="sm" /> : String(index + 1)}
                  </span>
                  <span className="min-w-0 max-w-full">
                    <Text variant="bodySmall" as="span" className="block max-w-full truncate">
                      {entry.label}
                    </Text>
                    <Text
                      variant="caption"
                      as="span"
                      tone="muted"
                      className="hidden truncate @4xl/studio:block"
                    >
                      {entry.detail}
                    </Text>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section
          aria-label="Guided setup"
          ref={stepMainRef}
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-5',
            previewing ? 'hidden @4xl/studio:block' : '',
          )}
        >
          <div className="mx-auto flex min-w-0 max-w-xl flex-col gap-4">
            {children}

            {error === null ? null : (
              <Text
                variant="bodySmall"
                role="alert"
                className="rounded-md border border-divider p-3"
              >
                {error}
              </Text>
            )}
          </div>
        </section>

        <aside
          id="creation-studio-preview"
          aria-label="Live preview"
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain border-t border-divider bg-surface p-4',
            '@4xl/studio:flex-none @4xl/studio:shrink-0 @4xl/studio:border-l @4xl/studio:border-t-0 @4xl/studio:w-80 @5xl/studio:w-96',
            previewing ? 'block' : 'hidden @4xl/studio:block',
          )}
        >
          <Text variant="note" as="div" tone="muted" className="mb-3">
            Preview
          </Text>
          <StudioPreview draft={draft} />
        </aside>
      </div>

      <footer className="shrink-0 border-t border-divider px-3 py-2">
        <div className="mx-auto flex max-w-xl flex-wrap items-center justify-between gap-2">
          {step > 0 ? (
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => {
                goToStep(step - 1);
              }}
            >
              Back
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {step < STEPS.length - 1 ? (
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  goToStep(step + 1);
                }}
              >
                Continue <Icon icon={ArrowRight} size="sm" />
              </Button>
            ) : null}
            <Button
              disabled={saving || validateDraft(draft, existingProperties) !== null}
              onClick={onFinish}
            >
              {saving
                ? intent === 'create'
                  ? 'Creating…'
                  : intent === 'add'
                    ? 'Adding…'
                    : 'Updating…'
                : intent === 'create'
                  ? `Create ${recipe.label}`
                  : intent === 'add'
                    ? `Add ${recipe.label}`
                    : 'Save changes'}
            </Button>
          </div>
        </div>
      </footer>

      <Dialog
        open={discarding}
        title="Discard this setup?"
        onClose={onDiscardClose}
        actions={
          <>
            <Button variant="secondary" onClick={onDiscardClose}>
              Keep editing
            </Button>
            <Button onClick={onDiscard}>Discard setup</Button>
          </>
        }
      >
        <Text variant="bodySmall">
          {itemId === undefined
            ? 'The item has not been created yet.'
            : viewId === undefined
              ? 'The view has not been added yet.'
              : 'The existing view has not been changed yet.'}{' '}
          Discarding removes this tab&rsquo;s saved draft.
        </Text>
      </Dialog>
    </div>
  );
}
