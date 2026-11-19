import { petRuns, type NixClient, type PetRunProposal, type PetRunResponse } from '@nix/api-client';
import { Text, focusRing } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';
import { z } from 'zod';

const savedVisit = z.object({
  actionId: z.uuid(),
  visit: z.object({ url: z.string() }),
  page: z.object({ forms: z.array(z.object({ supported: z.boolean() })).max(20) }),
});

const savedSubmission = z.object({
  proposal: z.object({ pageUrl: z.string() }),
});

function reviewedWebAddress(address: string): string | null {
  if (address.length > 2048 || !/^https?:\/\//u.test(address) || /[\s\\\p{Cc}]/u.test(address)) {
    return null;
  }
  try {
    const url = new URL(address);
    return url.username === '' && url.password === '' && url.port === '' && url.hash === ''
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function needsBrowserDetails(proposal: PetRunProposal): boolean {
  return (
    (proposal.capability === 'browser.browse' && proposal.status === 'applied') ||
    (proposal.capability === 'browser.submitForm' && proposal.status === 'refused')
  );
}

interface Continuation {
  readonly proposalId: string;
  readonly address: string;
  readonly message: string;
}

function continuationFor(proposal: PetRunProposal): Continuation | null {
  if (proposal.capability === 'browser.submitForm' && proposal.status === 'refused') {
    const submission = savedSubmission.safeParse(proposal.preview);
    if (!submission.success) return null;
    const address = reviewedWebAddress(submission.data.proposal.pageUrl);
    return address === null
      ? null
      : {
          proposalId: proposal.id,
          address,
          message:
            'Your pet couldn’t submit the form. Open the reviewed page to continue manually.',
        };
  }
  if (
    proposal.capability !== 'browser.browse' ||
    proposal.status !== 'applied' ||
    typeof proposal.receipt !== 'string' ||
    proposal.receipt.length > 64_000
  ) {
    return null;
  }
  try {
    const visit = savedVisit.safeParse(JSON.parse(proposal.receipt));
    if (
      !visit.success ||
      visit.data.actionId !== proposal.id ||
      !visit.data.page.forms.some((form) => !form.supported)
    ) {
      return null;
    }
    const address = reviewedWebAddress(visit.data.visit.url);
    return address === null
      ? null
      : {
          proposalId: proposal.id,
          address,
          message: 'A form on this page needs you to complete it in your browser.',
        };
  } catch {
    return null;
  }
}

const noContinuations: readonly Continuation[] = [];

export function useBrowserContinuations(
  client: NixClient,
  run: PetRunResponse,
): readonly Continuation[] {
  const { id, itemId } = run;
  const candidates = run.proposals
    .filter(needsBrowserDetails)
    .map((proposal) => proposal.id)
    .join(',');
  const [details, setDetails] = useState<{
    readonly client: NixClient;
    readonly id: string;
    readonly itemId: string;
    readonly candidates: string;
    readonly continuations: readonly Continuation[];
  } | null>(null);

  useEffect(() => {
    if (candidates === '') return;
    const controller = new AbortController();
    // The lists omit historical receipts. Extract only safe links from the authorized run detail.
    void client
      .query(petRuns.getRun(itemId, id), { signal: controller.signal, forceRefresh: true })
      .then(({ proposals }) => {
        if (controller.signal.aborted) return;
        const continuations = proposals
          .map(continuationFor)
          .filter((continuation) => continuation !== null);
        setDetails({ client, id, itemId, candidates, continuations });
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetails(null);
      });
    return () => {
      controller.abort();
    };
  }, [client, id, itemId, candidates]);

  return details?.client === client &&
    details.id === id &&
    details.itemId === itemId &&
    details.candidates === candidates
    ? details.continuations
    : noContinuations;
}

export function BrowserContinuation({
  step,
}: {
  readonly step: Continuation | undefined;
}): ReactElement | null {
  if (step === undefined) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Text variant="note">{step.message}</Text>
      <Text variant="note" tone="muted" className="wrap-anywhere">
        {step.address}
      </Text>
      <a
        className={`self-start underline ${focusRing}`}
        href={step.address}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Text variant="note" as="span">
          Open website
        </Text>
      </a>
    </div>
  );
}
