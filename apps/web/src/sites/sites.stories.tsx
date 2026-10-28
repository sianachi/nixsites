import type { Site, SiteBuild } from '@nix/api-client';
import { fireEvent, within } from '@testing-library/dom';
import type { ReactElement } from 'react';

import { settingsPanelWidth } from '@nix/web-foundation/layout/regions';
import { SiteExclusionsPicker } from './site-exclusions';
import { SitePagesList } from './site-pages-list';
import { SitePaneView } from './site-pane';
import { SitePublishDialog } from './site-publish-dialog';
import { SiteDatedCollections, SiteSettingsForm } from './site-settings-form';
import type { ItemSiteActions, ItemSiteState } from './use-item-site';

export default { title: 'Nix/Sites/Site pane', parameters: { layout: 'padded' } };

const accept = (): Promise<string | null> => Promise.resolve(null);
const noop = (): void => undefined;

const actions: ItemSiteActions = {
  retry: noop,
  create: accept,
  update: accept,
  setHostnames: accept,
  publish: accept,
  rollback: accept,
  unpublish: accept,
  remove: accept,
  setPath: accept,
  listPages: () =>
    Promise.resolve([
      { itemId: 'd1111111-1111-4111-8111-111111111111', path: '/', pinned: false, title: 'Garden' },
    ]),
  listChildren: () =>
    Promise.resolve([
      { id: 'd2222222-2222-4222-8222-222222222222', title: 'Beds', hasChildren: true },
    ]),
  listProperties: () => Promise.resolve([{ key: 'date', label: 'Date', type: 'date' }]),
};

const build: SiteBuild = {
  id: 'd3333333-3333-4333-8333-333333333333',
  siteId: 'd4444444-4444-4444-8444-444444444444',
  status: 'live',
  origin: 'manual',
  pageCount: 12,
  fileCount: 30,
  totalBytes: 4096,
  loss: [],
  failureCode: null,
  createdAt: '2026-10-11T09:00:00+00:00',
  activatedAt: '2026-10-11T09:00:05+00:00',
};

const draft: Site = {
  id: build.siteId,
  workspaceId: 'd5555555-5555-4555-8555-555555555555',
  rootItemId: 'd1111111-1111-4111-8111-111111111111',
  slug: 'garden',
  layout: 'docs',
  settings: {
    name: 'Garden notes',
    description: 'What grew and what did not.',
    accent: '#2f6f4f', // design-token-exempt: a site owner's chosen accent, data rather than styling.
    navigation: [],
    footerText: '',
    builtWithNix: true,
    language: 'en',
    noindex: false,
    author: null,
    headingMark: 'square',
    typeface: 'rounded',
    spacing: 'comfortable',
  },
  republishMode: 'manual',
  debounceSeconds: 300,
  status: 'draft',
  canManage: true,
  hostnames: [
    {
      hostname: 'garden.nixsites.com',
      url: 'https://garden.nixsites.com/',
      kind: 'default',
      verified: true,
      primary: true,
      serveMode: 'serve',
      status: 'verified',
      checkedAt: null,
      checkError: null,
      managed: false,
      records: [],
    },
  ],
  excludedItemIds: [],
  datedCollections: [],
  liveBuild: null,
  latestBuild: null,
  createdAt: '2026-10-11T08:00:00+00:00',
  updatedAt: '2026-10-11T08:00:00+00:00',
  primaryHostname: null,
  approvalRequired: false,
  approval: null,
};

const liveWithLoss = {
  ...build,
  loss: ['mermaid-as-code: The diagram on /plans/ is shown as code.'],
};
const published: Site = {
  ...draft,
  status: 'published',
  liveBuild: liveWithLoss,
  latestBuild: liveWithLoss,
  hostnames: [
    ...draft.hostnames,
    {
      hostname: 'garden.example.com',
      url: 'https://garden.example.com/',
      kind: 'custom',
      verified: false,
      primary: false,
      serveMode: 'serve',
      status: 'pending',
      checkedAt: '2026-10-11T08:05:00+00:00',
      checkError: 'txt_missing',
      managed: false,
      records: [
        {
          type: 'TXT',
          name: '_nix-site.garden.example.com',
          value: 'nix-site-verification=0123456789abcdef0123456789abcdef',
          purpose: 'verification',
        },
        { type: 'CNAME', name: 'garden.example.com', value: 'nixsites.com', purpose: 'routing' },
      ],
    },
  ],
};

function ready(
  site: Site,
  builds: readonly SiteBuild[] | null = [build],
): Extract<ItemSiteState, { phase: 'ready' }> {
  return {
    phase: 'ready',
    site,
    builds,
    buildsError: null,
    rollingBackTo: null,
    rollbackStalled: false,
  };
}

function Pane({
  state,
  canCreate = true,
}: {
  state: ItemSiteState;
  canCreate?: boolean;
}): ReactElement {
  return (
    <div className={settingsPanelWidth}>
      <SitePaneView state={state} actions={actions} rootTitle="Garden" canCreate={canCreate} />
    </div>
  );
}

export function Loading(): ReactElement {
  return <Pane state={{ phase: 'loading' }} />;
}

export function NotASiteForAnOwner(): ReactElement {
  return <Pane state={{ phase: 'none' }} />;
}

/** Empty: somebody who cannot manage the workspace sees no offer to publish. */
export function NotASiteForAReader(): ReactElement {
  return <Pane state={{ phase: 'none' }} canCreate={false} />;
}

export function LoadFailed(): ReactElement {
  return <Pane state={{ phase: 'error', message: 'The request did not complete. Try again.' }} />;
}

export function Draft(): ReactElement {
  return <Pane state={ready(draft, [])} />;
}

export function Building(): ReactElement {
  return (
    <Pane
      state={ready(
        { ...draft, latestBuild: { ...build, status: 'building', activatedAt: null } },
        [],
      )}
    />
  );
}

export function LiveWithLosses(): ReactElement {
  return (
    <Pane
      state={ready(published, [
        build,
        { ...build, id: 'd6666666-6666-4666-8666-666666666666', status: 'superseded' },
      ])}
    />
  );
}

/** Partial: the site loaded, its build history did not. */
export function BuildsUnavailable(): ReactElement {
  return (
    <Pane
      state={{
        phase: 'ready',
        site: published,
        builds: null,
        buildsError: 'The request did not complete. Try again.',
        rollingBackTo: null,
        rollbackStalled: false,
      }}
    />
  );
}

export function BuildFailed(): ReactElement {
  const failed: SiteBuild = {
    ...build,
    status: 'failed',
    failureCode: 'site_body_withheld',
    activatedAt: null,
  };
  return <Pane state={ready({ ...draft, latestBuild: failed }, [failed])} />;
}

export function ReaderOfALiveSite(): ReactElement {
  return <Pane state={ready({ ...published, canManage: false })} />;
}

export function FirstPublishDisclosure(): ReactElement {
  return (
    <SitePublishDialog
      open
      url="https://garden.nixsites.com/"
      republishMode="manual"
      onPublish={accept}
      onClose={noop}
    />
  );
}

/** Publishing again after an unpublish, with automatic publishing on, names what that means. */
export function RepublishDisclosureInAutoMode(): ReactElement {
  return (
    <SitePublishDialog
      open
      url="https://garden.nixsites.com/"
      republishMode="auto"
      onPublish={accept}
      onClose={noop}
    />
  );
}

export function Unpublished(): ReactElement {
  return <Pane state={ready({ ...draft, status: 'unpublished' }, [])} />;
}

const previousBuild: SiteBuild = {
  ...build,
  id: 'd6666666-6666-4666-8666-666666666666',
  status: 'superseded',
};

export function RollingBack(): ReactElement {
  return (
    <Pane
      state={{ ...ready(published, [build, previousBuild]), rollingBackTo: previousBuild.id }}
    />
  );
}

export function RollbackNotYetServed(): ReactElement {
  return <Pane state={{ ...ready(published, [build, previousBuild]), rollbackStalled: true }} />;
}

export const ConfirmUnpublish = {
  render: (): ReactElement => <Pane state={ready(published)} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    (await canvas.findByRole('button', { name: 'Unpublish' })).click();
    await canvas.findByRole('dialog', { name: 'Unpublish this site' });
  },
};

export const ConfirmRollback = {
  render: (): ReactElement => <Pane state={ready(published, [build, previousBuild])} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    (await canvas.findByRole('button', { name: /roll back to the build/i })).click();
    await canvas.findByRole('dialog', { name: 'Roll back to an earlier build' });
  },
};

export const ConfirmAutomaticPublishing = {
  render: (): ReactElement => (
    <div className={settingsPanelWidth}>
      <SiteSettingsForm site={draft} onSave={accept} />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    fireEvent.change(canvas.getByRole('combobox', { name: /publish changes/i }), {
      target: { value: 'auto' },
    });
    canvas.getByRole('button', { name: 'Save settings' }).click();
    await canvas.findByRole('dialog', { name: 'Publish every edit automatically?' });
  },
};

export function ExclusionsPicker(): ReactElement {
  return (
    <SiteExclusionsPicker
      open
      rootItemId={draft.rootItemId}
      rootTitle="Garden"
      excluded={[]}
      listChildren={actions.listChildren}
      onSave={accept}
      onClose={noop}
    />
  );
}

export const DatedCollectionForm = {
  render: (): ReactElement => (
    <div className={settingsPanelWidth}>
      <SiteDatedCollections
        site={{
          ...draft,
          datedCollections: [
            {
              itemId: 'd2222222-2222-4222-8222-222222222222',
              dateProperty: 'date',
              tagsProperty: null,
              coverProperty: null,
              summaryProperty: null,
            },
          ],
        }}
        onSave={accept}
        listChildren={actions.listChildren}
        listProperties={actions.listProperties}
      />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByText('Beds, dated by Date');
    canvas.getByRole('button', { name: 'Add a dated collection' }).click();
    const collection = await canvas.findByRole('combobox', { name: /collection/i });
    await canvas.findByRole('option', { name: 'Beds' });
    fireEvent.change(collection, { target: { value: 'd2222222-2222-4222-8222-222222222222' } });
    await canvas.findByRole('combobox', { name: /^date/i });
  },
};

export const PathEditing = {
  render: (): ReactElement => (
    <div className={settingsPanelWidth}>
      <SitePagesList
        listPages={() =>
          Promise.resolve([
            { itemId: draft.rootItemId, path: '/', pinned: false, title: 'Garden' },
            {
              itemId: 'd2222222-2222-4222-8222-222222222222',
              path: '/beds/',
              pinned: true,
              title: 'Beds',
            },
          ])
        }
        setPath={accept}
        canManage
      />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    (await canvas.findByRole('button', { name: 'Change the path of Beds' })).click();
    await canvas.findByText(/keeps redirecting/);
  },
};
