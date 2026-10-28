import type { Site, SiteBuild, SiteLayout } from '@nix/api-client';
import { Button, Dialog, Field, Input, Select, Tag, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { failureMessage, lossDetail, pages, progressMessage } from './site-copy';
import { SiteApproval } from './site-approval';
import { SiteExclusionsPicker } from './site-exclusions';
import { SiteHostnames } from './site-hostnames';
import { SitePagesList } from './site-pages-list';
import { SitePublishDialog } from './site-publish-dialog';
import { SiteDatedCollections, SiteSettingsForm } from './site-settings-form';
import { useItemSite, type ItemSiteActions, type ItemSiteState } from './use-item-site';

/** The Site pane of the item panel: publish this item and everything inside it as a website. */
export function SitePane({
  itemId,
  title,
}: {
  readonly itemId: string;
  readonly title: string;
}): ReactNode {
  const { workspaceId, workspace } = useWorkspace();
  const { state, actions } = useItemSite(itemId, workspaceId);
  // A hint only: Core decides on create, and a refusal is shown in words.
  return (
    <SitePaneView
      state={state}
      actions={actions}
      rootTitle={title}
      canCreate={workspace.canRename}
    />
  );
}

const LOSS_SHOWN = 8;

// The item menu's Site entry asks for focus before the pane may exist, so the request waits here
// until a pane heading mounts. It lapses quickly so a much later render never steals focus.
let focusRequestedUntil = 0;
const FOCUS_REQUEST_MS = 5_000;

function takeRequestedFocus(node: HTMLElement | null): void {
  if (node === null || Date.now() > focusRequestedUntil) return;
  focusRequestedUntil = 0;
  // A frame later, so the closing menu's own focus return lands first.
  requestAnimationFrame(() => {
    node.focus();
  });
}

/** Moves focus to the Site pane's heading, now if it is showing or as soon as it renders. */
export function focusSitePaneHeading(): void {
  focusRequestedUntil = Date.now() + FOCUS_REQUEST_MS;
  requestAnimationFrame(() => {
    const heading = document.querySelector('[data-site-pane-heading]');
    if (heading instanceof HTMLElement) takeRequestedFocus(heading);
  });
}

/** A pane heading that can take focus from the item menu. */
function PaneHeading({
  children,
  title,
}: {
  readonly children: string;
  readonly title?: string;
}): ReactNode {
  return (
    <h2
      ref={takeRequestedFocus}
      tabIndex={-1}
      data-site-pane-heading
      className="min-w-0 outline-none"
    >
      <Text
        variant="h5"
        as="span"
        truncate={title !== undefined}
        {...(title === undefined ? {} : { title })}
      >
        {children}
      </Text>
    </h2>
  );
}

export function SitePaneView({
  state,
  actions,
  rootTitle,
  canCreate,
}: {
  readonly state: ItemSiteState;
  readonly actions: ItemSiteActions;
  readonly rootTitle: string;
  readonly canCreate: boolean;
}): ReactNode {
  if (state.phase === 'loading') return <LoadingPanel label="the site" />;
  if (state.phase === 'error')
    return (
      <ErrorPanel
        title="The site could not be loaded"
        detail={state.message}
        action={
          <Button variant="secondary" onClick={actions.retry}>
            Retry
          </Button>
        }
      />
    );
  if (state.phase === 'none')
    return canCreate ? (
      <CreateSite rootTitle={rootTitle} onCreate={actions.create} />
    ) : (
      <EmptyPanel
        title="Not a site"
        detail="This item is not published as a website. Only a workspace owner can make it one."
      />
    );
  return (
    <SiteDetails
      site={state.site}
      builds={state.builds}
      buildsError={state.buildsError}
      rollingBackTo={state.rollingBackTo}
      rollbackStalled={state.rollbackStalled}
      actions={actions}
      rootTitle={rootTitle}
    />
  );
}

function slugFrom(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63);
}

function CreateSite({
  rootTitle,
  onCreate,
}: {
  readonly rootTitle: string;
  readonly onCreate: ItemSiteActions['create'];
}): ReactNode {
  const [slug, setSlug] = useState(() => slugFrom(rootTitle));
  const [layout, setLayout] = useState<SiteLayout>('docs');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-col gap-3"
      aria-label="Make this a site"
      onSubmit={(event) => {
        event.preventDefault();
        setWorking(true);
        setError(null);
        void onCreate(slug.trim(), layout).then((refusal) => {
          setWorking(false);
          setError(refusal);
        });
      }}
    >
      <PaneHeading>Make this a site</PaneHeading>
      <Text variant="note" tone="muted">
        Publish this item and everything inside it as a website. Nothing is public until you
        publish, and you can leave items out first.
      </Text>
      <Field
        label="Address"
        hint={
          slug.trim() === ''
            ? 'Type an address to continue. The title has no letters an address can use, so one could not be suggested.'
            : 'Lowercase letters, numbers and hyphens. It becomes the first part of the site’s web address.'
        }
        error={error}
        required
      >
        {(control) => (
          <Input
            {...control}
            value={slug}
            maxLength={63}
            onChange={(event) => {
              setSlug(event.currentTarget.value.toLowerCase());
            }}
          />
        )}
      </Field>
      <Field label="Layout">
        {(control) => (
          <Select
            {...control}
            value={layout}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === 'docs' || value === 'blog') setLayout(value);
            }}
          >
            <option value="docs">Docs: pages with a sidebar</option>
            <option value="blog">Blog: dated posts first</option>
          </Select>
        )}
      </Field>
      <div>
        <Button type="submit" disabled={working || slug.trim() === ''}>
          {working ? 'Creating…' : 'Make this a site'}
        </Button>
      </div>
    </form>
  );
}

const STATUS_LABEL: Record<Site['status'], string> = {
  draft: 'Draft',
  published: 'Live',
  unpublished: 'Unpublished',
};

function dateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

type Confirming =
  | { readonly kind: 'unpublish' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'rollback'; readonly build: SiteBuild };

function SiteDetails({
  site,
  builds,
  buildsError,
  rollingBackTo,
  rollbackStalled,
  actions,
  rootTitle,
}: {
  readonly site: Site;
  readonly builds: readonly SiteBuild[] | null;
  readonly buildsError: string | null;
  readonly rollingBackTo: string | null;
  readonly rollbackStalled: boolean;
  readonly actions: ItemSiteActions;
  readonly rootTitle: string;
}): ReactNode {
  const [publishOpen, setPublishOpen] = useState(false);
  const [exclusionsOpen, setExclusionsOpen] = useState(false);
  const [showPages, setShowPages] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const latest = site.latestBuild;
  const live = site.liveBuild;
  const building =
    latest !== null &&
    (latest.status === 'queued' || latest.status === 'building' || latest.status === 'sealed');
  // Publishing anything that is not live right now makes content public again, so it asks first.
  const needsDisclosure = site.status !== 'published';
  const defaultHost = site.hostnames.find((entry) => entry.kind === 'default');
  const previous = (builds ?? []).filter((build) => build.status === 'superseded');

  async function act(body: () => Promise<string | null>): Promise<void> {
    setWorking(true);
    setError(null);
    const refusal = await body();
    setWorking(false);
    setError(refusal);
  }

  function publish(): void {
    if (needsDisclosure) setPublishOpen(true);
    else void act(() => actions.publish(false));
  }

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Status" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <PaneHeading title={site.settings.name}>{site.settings.name}</PaneHeading>
          <div className="flex shrink-0 gap-1">
            <Tag tone={site.status === 'published' ? 'accent' : 'neutral'}>
              {STATUS_LABEL[site.status]}
            </Tag>
            {latest?.status === 'failed' ? <Tag tone="muted">Build failed</Tag> : null}
          </div>
        </div>

        <ul className="flex flex-col gap-1" aria-label="Addresses">
          {site.hostnames.map((entry) => (
            <li key={entry.hostname} className="flex flex-wrap items-center gap-2">
              {entry.verified && site.status === 'published' ? (
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-text underline"
                >
                  <Text variant="note" as="span" tone="accent">
                    {entry.url}
                  </Text>
                </a>
              ) : (
                <Text variant="note" as="span">
                  {entry.hostname}
                </Text>
              )}
            </li>
          ))}
        </ul>

        {/* One live region, always mounted, so a screen reader hears each change of its text. */}
        <Text variant="note" role="status" aria-live="polite">
          {building
            ? progressMessage(latest)
            : rollingBackTo !== null
              ? 'Rolling back. The earlier build will be served in a moment.'
              : rollbackStalled
                ? 'The rollback has not taken effect yet. Refresh, or try again.'
                : ''}
        </Text>
        {latest?.status === 'failed' ? (
          <Text variant="note" role="alert">
            {failureMessage(latest, live !== null)}
          </Text>
        ) : null}
        {live === null ? (
          site.status === 'draft' && !building ? (
            <Text variant="note" tone="muted">
              Not published yet. Nothing is public.
            </Text>
          ) : null
        ) : (
          <Text variant="note" tone="muted">
            {`Live since ${live.activatedAt === null ? dateTime(live.createdAt) : dateTime(live.activatedAt)}, ${pages(live.pageCount)}.`}
          </Text>
        )}
        {site.status === 'unpublished' ? (
          <Text variant="note" tone="muted">
            Unpublished. The site is not served; copies others made while it was live may remain.
          </Text>
        ) : null}

        {live !== null && live.loss.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Text variant="note" as="h3">
              {`Not everything could be published as written (${String(live.loss.length)})`}
            </Text>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {live.loss.slice(0, LOSS_SHOWN).map((line) => (
                <li key={line}>
                  <Text variant="note" as="span" tone="muted">
                    {lossDetail(line)}
                  </Text>
                </li>
              ))}
            </ul>
            {live.loss.length > LOSS_SHOWN ? (
              <Text variant="note" tone="muted">
                {`And ${String(live.loss.length - LOSS_SHOWN)} more.`}
              </Text>
            ) : null}
          </div>
        ) : null}
      </section>

      <SiteApproval site={site} />

      {site.canManage ? (
        <section aria-label="Publishing" className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button disabled={working || building || rollingBackTo !== null} onClick={publish}>
              {site.status === 'draft'
                ? 'Publish'
                : site.status === 'published'
                  ? 'Publish changes'
                  : 'Publish again'}
            </Button>
            {site.status === 'published' ? (
              <Button
                variant="secondary"
                disabled={working || building}
                onClick={() => {
                  setConfirming({ kind: 'unpublish' });
                }}
              >
                Unpublish
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={working || building}
                onClick={() => {
                  setConfirming({ kind: 'delete' });
                }}
              >
                Delete site
              </Button>
            )}
          </div>
          {error === null ? null : (
            <Text role="alert" variant="note">
              {error}
            </Text>
          )}
        </section>
      ) : (
        <Text variant="note" tone="muted">
          Only a workspace owner can change or publish this site.
        </Text>
      )}

      {site.status === 'published' || previous.length > 0 || buildsError !== null ? (
        <section aria-label="Previous builds" className="flex flex-col gap-2">
          <Text variant="h6" as="h3">
            Previous builds
          </Text>
          {buildsError === null ? null : (
            <PartialNotice pending={`Previous builds could not be loaded. ${buildsError}`} />
          )}
          {builds === null && buildsError === null ? (
            <Text variant="note" tone="muted" role="status">
              Loading builds…
            </Text>
          ) : previous.length === 0 && buildsError === null ? (
            <Text variant="note" tone="muted">
              No earlier build to go back to.
            </Text>
          ) : (
            <ul className="flex flex-col gap-1">
              {previous.map((build) => (
                <li key={build.id} className="flex items-center justify-between gap-2">
                  <Text variant="note" as="span">
                    {`${dateTime(build.createdAt)}, ${pages(build.pageCount)}`}
                  </Text>
                  {site.canManage && site.status === 'published' ? (
                    <Button
                      variant="ghost"
                      disabled={working || building || rollingBackTo !== null}
                      aria-label={`Roll back to the build from ${dateTime(build.createdAt)}`}
                      onClick={() => {
                        setConfirming({ kind: 'rollback', build });
                      }}
                    >
                      Roll back
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section aria-label="Pages" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Text variant="h6" as="h3">
            Pages
          </Text>
          <Button
            variant="ghost"
            aria-expanded={showPages}
            onClick={() => {
              setShowPages(!showPages);
            }}
          >
            {showPages ? 'Hide paths' : 'Show paths'}
          </Button>
        </div>
        {showPages ? (
          <SitePagesList
            listPages={actions.listPages}
            setPath={actions.setPath}
            canManage={site.canManage}
          />
        ) : null}
      </section>

      {site.canManage ? (
        <>
          <section aria-label="Left out" className="flex flex-col gap-2">
            <Text variant="h6" as="h3">
              Left out
            </Text>
            <Text variant="note" tone="muted">
              {site.excludedItemIds.length === 0
                ? 'Everything inside this item is included, except locked and trashed items.'
                : `${String(site.excludedItemIds.length)} ${site.excludedItemIds.length === 1 ? 'item is' : 'items are'} left out, with everything inside them.`}
            </Text>
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  setExclusionsOpen(true);
                }}
              >
                Choose what to leave out
              </Button>
            </div>
          </section>

          <section aria-label="Settings" className="flex flex-col gap-2">
            <Text variant="h6" as="h3">
              Settings
            </Text>
            <SiteSettingsForm site={site} onSave={actions.update} />
          </section>

          <section aria-label="Dated collections" className="flex flex-col gap-2">
            <Text variant="h6" as="h3">
              Dated collections
            </Text>
            <SiteDatedCollections
              site={site}
              onSave={actions.update}
              listChildren={actions.listChildren}
              listProperties={actions.listProperties}
            />
          </section>

          <SiteHostnames site={site} />

          {publishOpen ? (
            <SitePublishDialog
              open
              url={defaultHost?.url ?? null}
              republishMode={site.republishMode}
              onPublish={() => actions.publish(true)}
              onClose={() => {
                setPublishOpen(false);
              }}
            />
          ) : null}
          {exclusionsOpen ? (
            <SiteExclusionsPicker
              open
              rootItemId={site.rootItemId}
              rootTitle={rootTitle}
              excluded={site.excludedItemIds}
              listChildren={actions.listChildren}
              onSave={(excludedItemIds) => actions.update({ excludedItemIds })}
              onClose={() => {
                setExclusionsOpen(false);
              }}
            />
          ) : null}
          {confirming === null ? null : (
            <ConfirmDialog
              confirming={confirming}
              onClose={() => {
                setConfirming(null);
              }}
              onConfirm={() =>
                confirming.kind === 'rollback'
                  ? actions.rollback(confirming.build.id)
                  : confirming.kind === 'unpublish'
                    ? actions.unpublish()
                    : actions.remove()
              }
            />
          )}
        </>
      ) : null}
    </div>
  );
}

const CONFIRM_COPY: Record<Confirming['kind'], { title: string; action: string }> = {
  rollback: { title: 'Roll back to an earlier build', action: 'Roll back' },
  unpublish: { title: 'Unpublish this site', action: 'Unpublish' },
  delete: { title: 'Delete this site', action: 'Delete site' },
};

function ConfirmDialog({
  confirming,
  onConfirm,
  onClose,
}: {
  readonly confirming: Confirming;
  readonly onConfirm: () => Promise<string | null>;
  readonly onClose: () => void;
}): ReactNode {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = CONFIRM_COPY[confirming.kind];

  return (
    <Dialog
      open
      title={copy.title}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={working}
            onClick={() => {
              setWorking(true);
              setError(null);
              void onConfirm().then((refusal) => {
                setWorking(false);
                if (refusal === null) onClose();
                else setError(refusal);
              });
            }}
          >
            {copy.action}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {confirming.kind === 'rollback' ? (
          <Text>
            {`The site will serve the build from ${dateTime(confirming.build.createdAt)} again, with its content exactly as it was then. That includes pages that have since been locked, trashed or left out.`}
          </Text>
        ) : confirming.kind === 'unpublish' ? (
          <Text>
            The site stops being served and its builds are deleted. Search engines and web archives
            may still hold copies made while it was live; unpublishing cannot recall them.
          </Text>
        ) : (
          <Text>
            The site’s settings and page paths are deleted. The items themselves are not touched.
          </Text>
        )}
        {error === null ? null : (
          <Text role="alert" variant="note">
            {error}
          </Text>
        )}
      </div>
    </Dialog>
  );
}
