import { Button, Dialog, Icon, Text, cn, focusRing } from '@nix/ui';
import { ArrowLeft, ArrowRight, Check, Eye } from 'lucide-react';
import { useEffect, type ReactNode, type RefObject } from 'react';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';

import { TemplateBlueprint } from './template-studio-facts';
import type { TemplateDetail } from './template-api';
import {
  TEMPLATE_STUDIO_STEPS,
  type RootTemplateFacts,
  type StudioMode,
  type TemplateDraft,
} from './template-studio-model';

export function TemplateStudioShell({
  mode,
  title,
  destination,
  step,
  working,
  statusMessage,
  previewing,
  error,
  discarding,
  draft,
  template,
  rootFacts,
  missingFactsLabel,
  stepMainRef,
  children,
  onRequestDiscard,
  onCloseDiscard,
  onDiscard,
  onTogglePreview,
  onStepChange,
  onBack,
  onNext,
  onFinish,
  finishLabel,
  finishDisabled,
}: {
  readonly mode: StudioMode;
  readonly title: string;
  readonly destination: string;
  readonly step: number;
  readonly working: boolean;
  readonly statusMessage: string | null;
  readonly previewing: boolean;
  readonly error: string | null;
  readonly discarding: boolean;
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly rootFacts: RootTemplateFacts | null;
  readonly missingFactsLabel: string | null;
  readonly stepMainRef: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
  readonly onRequestDiscard: () => void;
  readonly onCloseDiscard: () => void;
  readonly onDiscard: () => void;
  readonly onTogglePreview: () => void;
  readonly onStepChange: (index: number) => void;
  readonly onBack: () => void;
  readonly onNext: () => void;
  readonly onFinish: () => void;
  readonly finishLabel: string;
  readonly finishDisabled: boolean;
}): ReactNode {
  const zen = useZenActive();
  useEffect(() => {
    if (discarding) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) onRequestDiscard();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [discarding, onRequestDiscard]);
  return (
    <div className="@container/studio flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className={`flex min-w-0 shrink-0 items-center gap-2 border-b border-divider px-3 py-2 ${zen ? 'pr-16' : ''}`}
      >
        <Button variant="icon" aria-label="Cancel template setup" onClick={onRequestDiscard}>
          <Icon icon={ArrowLeft} size="sm" />
        </Button>
        <div className="min-w-0 flex-1">
          <Text variant="h4" as="h1" className="truncate">
            {title}
          </Text>
          <Text variant="caption" tone="muted" className="truncate">
            {mode === 'capture' || mode === 'edit'
              ? 'Shared with this workspace'
              : `Destination: ${destination}`}
          </Text>
        </div>
        <Button
          variant="icon"
          className="shrink-0 @4xl/studio:hidden"
          aria-label={previewing ? 'Hide preview' : 'Preview'}
          aria-expanded={previewing}
          aria-controls="template-studio-preview"
          onClick={onTogglePreview}
        >
          <Icon icon={Eye} size="sm" />
        </Button>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col @4xl/studio:flex-row">
        <nav
          aria-label="Template steps"
          className="min-w-0 shrink-0 border-b border-divider bg-surface p-2 @4xl/studio:w-44 @4xl/studio:border-b-0 @4xl/studio:border-r"
        >
          <ol className="grid grid-cols-3 gap-1 @4xl/studio:flex @4xl/studio:flex-col @4xl/studio:gap-2">
            {TEMPLATE_STUDIO_STEPS.map((entry, index) => (
              <li key={entry.label} className="min-w-0">
                <button
                  type="button"
                  aria-current={index === step ? 'step' : undefined}
                  aria-label={`${entry.label}: ${entry.detail}`}
                  disabled={working}
                  onClick={() => {
                    onStepChange(index);
                  }}
                  className={cn(
                    `flex min-h-(--control-lg) w-full flex-col items-center gap-1 rounded-md px-2 py-2 text-center ${focusRing} @4xl/studio:flex-row @4xl/studio:items-center @4xl/studio:gap-2 @4xl/studio:text-left`,
                    index === step ? 'bg-accent/10 text-accent-text' : 'hover:bg-foreground/7',
                  )}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background">
                    {index < step ? <Icon icon={Check} size="sm" /> : String(index + 1)}
                  </span>
                  {/* The name under the number, at every width - a phone reader used to see only
                      "1 2 3" here, which names nothing. Truncated rather than wrapped so a long
                      step name never grows the rail; the detail line stays lg-only, since a step's
                      one-line description is the part a phone's narrower column has least room
                      for. */}
                  <span className="min-w-0 max-w-full">
                    <Text variant="caption" as="span" className="block max-w-full truncate">
                      {entry.label}
                    </Text>
                    <Text
                      variant="caption"
                      as="span"
                      tone="muted"
                      className="hidden max-w-full truncate @4xl/studio:block"
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
          aria-label="Template setup"
          ref={stepMainRef}
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-5',
            previewing ? 'hidden @4xl/studio:block' : '',
          )}
        >
          <div className="mx-auto flex min-w-0 max-w-2xl flex-col gap-4">{children}</div>
        </section>

        <aside
          id="template-studio-preview"
          aria-label="Template preview"
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain border-t border-divider bg-surface p-4',
            '@4xl/studio:flex-none @4xl/studio:shrink-0 @4xl/studio:border-l @4xl/studio:border-t-0 @4xl/studio:w-80 @5xl/studio:w-96',
            previewing ? 'block' : 'hidden @4xl/studio:block',
          )}
        >
          <TemplateBlueprint
            draft={draft}
            template={template}
            destination={destination}
            mode={mode}
            rootFacts={rootFacts}
            missingFactsLabel={missingFactsLabel}
          />
        </aside>
      </div>

      <footer className="shrink-0 border-t border-divider bg-background px-3 py-2">
        <div className="mx-auto flex max-w-2xl min-w-0 flex-col gap-2">
          {statusMessage === null ? null : (
            <Text variant="bodySmall" role="status" className="bg-surface px-3 py-2">
              {statusMessage}
            </Text>
          )}
          {error === null ? null : (
            <Text variant="bodySmall" role="alert" className="bg-surface px-3 py-2">
              {error}
            </Text>
          )}
          <div className="flex items-center justify-between gap-2">
            {step > 0 ? (
              <Button variant="secondary" disabled={working} onClick={onBack}>
                Back
              </Button>
            ) : (
              <span />
            )}
            {step < TEMPLATE_STUDIO_STEPS.length - 1 ? (
              <Button disabled={working} onClick={onNext}>
                {working ? 'Checking…' : 'Continue'} <Icon icon={ArrowRight} size="sm" />
              </Button>
            ) : (
              <Button disabled={working || finishDisabled} onClick={onFinish}>
                {working ? 'Saving…' : finishLabel}
              </Button>
            )}
          </div>
        </div>
      </footer>

      <Dialog
        open={discarding}
        title="Discard this setup?"
        onClose={onCloseDiscard}
        actions={
          <>
            <Button variant="secondary" onClick={onCloseDiscard}>
              Keep editing
            </Button>
            <Button disabled={working} onClick={onDiscard}>
              Discard setup
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">Nothing is saved. This tab&rsquo;s draft is removed.</Text>
      </Dialog>
    </div>
  );
}
