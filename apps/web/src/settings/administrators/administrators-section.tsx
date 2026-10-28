import { Button, Field, Input, Select, Table, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { SettingsSection } from '../shared/settings-section';
import { ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import { useWorkspaceAssignablePrincipals } from '../../workspaces/use-workspace-assignable-principals';
import { formatDay } from '../access-tokens/token-facts';
import { useCapabilities } from '../../session/capabilities-context';
import {
  SITE_APPROVERS,
  TENANT_ADMINS,
  usePeople,
  type Person,
  type PeopleSource,
} from './use-administrators';

/** Who can administer the tenant, and who can approve first publishes. Each block shows only to those it concerns. */
export function AdministratorsSection(): ReactElement {
  const { tenantAdministrator, siteApprover } = useCapabilities();
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {tenantAdministrator ? (
        <PeopleBlock
          title="Tenant administrators"
          summary="Manage roles and groups across the whole tenant"
          more="There is always at least one tenant administrator."
          source={TENANT_ADMINS}
        />
      ) : null}
      {siteApprover ? (
        <PeopleBlock
          title="Site approvers"
          summary="Decide a site's first publish"
          more="Approvers set in the deployment's configuration cannot be removed here."
          source={SITE_APPROVERS}
          showSource
        />
      ) : null}
    </div>
  );
}

function PeopleBlock({
  title,
  summary,
  more,
  source,
  showSource = false,
}: {
  readonly title: string;
  readonly summary: string;
  readonly more: string;
  readonly source: PeopleSource;
  readonly showSource?: boolean;
}): ReactElement {
  const { status, people, error, actionError, busyId, reload, add, remove } = usePeople(source);
  const narrow = useNarrowViewport();

  const columns = [
    { key: 'name', header: 'Person', rowHeader: true, cell: (person: Person) => person.name },
    ...(showSource
      ? [
          {
            key: 'source',
            header: 'Source',
            cell: (person: Person) => (person.configured ? 'Configured' : 'Granted'),
          },
        ]
      : []),
    {
      key: 'since',
      header: 'Since',
      cell: (person: Person) => (person.since === null ? '' : formatDay(person.since)),
    },
    {
      key: 'actions',
      header: 'Remove',
      cell: (person: Person) =>
        person.configured ? null : (
          <Button
            variant="secondary"
            disabled={busyId !== null}
            aria-label={`Remove ${person.name} from ${title}`}
            onClick={() => {
              void remove(person.id);
            }}
          >
            Remove
          </Button>
        ),
    },
  ];

  return (
    <SettingsSection title={title} summary={summary}>
      <details>
        <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
          More<span className="sr-only"> about {title}</span>
        </summary>
        <Text variant="note" tone="muted">
          {more}
        </Text>
      </details>

      {status === 'error' ? (
        <ErrorPanel
          title={`${title} could not be loaded`}
          detail={error ?? 'Something went wrong reading the list.'}
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <>
          {narrow ? (
            <ul aria-label={title} className="flex flex-col divide-y divide-divider">
              {people.length === 0 ? (
                <Text variant="note" tone="muted" role="status">
                  {status === 'loading'
                    ? `Loading ${title.toLocaleLowerCase()}.`
                    : 'Nobody is listed yet.'}
                </Text>
              ) : null}
              {people.map((person) => (
                <li key={person.id} className="flex min-h-11 flex-wrap items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <Text as="p" variant="bodySmall" className="break-words">
                      {person.name}
                    </Text>
                    <Text as="p" variant="caption" tone="muted">
                      {[
                        showSource ? (person.configured ? 'Configured' : 'Granted') : null,
                        person.since === null ? null : `since ${formatDay(person.since)}`,
                      ]
                        .filter((part) => part !== null)
                        .join(', ')}
                    </Text>
                  </div>
                  {person.configured ? null : (
                    <Button
                      variant="secondary"
                      disabled={busyId !== null}
                      aria-label={`Remove ${person.name} from ${title}`}
                      onClick={() => {
                        void remove(person.id);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div
              className="min-w-0 overflow-x-auto"
              role="region"
              aria-label={`${title} table`}
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to scroll the table horizontally.
              tabIndex={0}
            >
              <Table
                caption={title}
                columns={columns}
                rows={people}
                rowKey={(person) => person.id}
                loading={status === 'loading'}
                loadingMessage={`Loading ${title.toLocaleLowerCase()}.`}
                emptyMessage="Nobody is listed yet."
              />
            </div>
          )}
          <PersonPicker
            label={title}
            taken={people}
            disabled={busyId !== null}
            onAdd={(personId) => add(personId)}
          />
          {actionError === null ? null : (
            <Text role="alert" variant="note">
              {actionError}
            </Text>
          )}
        </>
      )}
    </SettingsSection>
  );
}

/** Search the workspace's people and add one who is not already listed. */
function PersonPicker({
  label,
  taken,
  disabled,
  onAdd,
}: {
  readonly label: string;
  readonly taken: readonly Person[];
  readonly disabled: boolean;
  readonly onAdd: (id: string) => Promise<void>;
}): ReactElement {
  const directory = useWorkspaceAssignablePrincipals();
  const [chosen, setChosen] = useState('');
  const candidates = directory.principals.filter(
    (principal) => !taken.some((person) => person.id === principal.principalId),
  );

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Search people" className="w-full sm:w-56">
        {(control) => (
          <Input
            {...control}
            value={directory.query}
            onChange={(event) => {
              directory.setQuery(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={`Add to ${label}`} className="w-full sm:w-64">
        {(control) => (
          <Select
            {...control}
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            <option value="">Choose a person</option>
            {candidates.map((principal) => (
              <option key={principal.principalId} value={principal.principalId}>
                {principal.displayName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button
        disabled={disabled || chosen === ''}
        aria-label={`Add to ${label}`}
        onClick={() => {
          void onAdd(chosen).then(() => {
            setChosen('');
          });
        }}
      >
        Add
      </Button>
    </div>
  );
}
