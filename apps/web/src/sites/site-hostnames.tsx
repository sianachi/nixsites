import { sites, type CommandEndpoint, type Site, type SiteHostname } from '@nix/api-client';
import { Button, Field, Input, Select, Tag, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { useOptionalApiClient } from '@nix/web-platform/api/api-client-provider';
import { refusalMessage } from './site-copy';

/** Runs one hostname command; resolves to the refusal in words, or null when it went through. */
export type RunHostnameCommand = (endpoint: CommandEndpoint<Site>) => Promise<string | null>;

const STATUS_COPY: Readonly<Record<SiteHostname['status'], string>> = {
  verified: 'Verified',
  failing: 'Verified, but the last check failed',
  pending: 'Waiting for DNS records',
  checking: 'Not checked yet',
};

const CHECK_ERRORS: Readonly<Record<string, string>> = {
  txt_missing: 'The TXT record was not found.',
  txt_mismatch: 'A TXT record was found, but it holds a different value.',
  routing_missing: 'Verified, but the name does not resolve yet. Create the CNAME record.',
  dns_unavailable: 'DNS could not be reached. It will be checked again.',
  hostname_taken: 'Another site already serves this hostname.',
  routing_record_foreign:
    'A record Nix did not create already routes this name; it was left alone.',
};

/** What a check found, in words; Cloudflare failures keep their code. */
export function checkErrorCopy(code: string | null): string | null {
  if (code === null) return null;
  return CHECK_ERRORS[code] ?? `Setup failed (${code}).`;
}

/**
 * The hostnames section of the Site pane: the default address, custom domains and aliases, the
 * primary (canonical) hostname, and how each alias answers. Owns its own requests, so the pane
 * only mounts it with the site.
 */
export function SiteHostnames({ site }: { readonly site: Site }): ReactNode {
  // Optional, so the pane still renders where no client is provided (stories); actions then refuse.
  const client = useOptionalApiClient();
  const [current, setCurrent] = useState(site);
  const [seen, setSeen] = useState(site);
  if (seen !== site) {
    // A newer site from the pane (a reload or another change) replaces what this section showed.
    setSeen(site);
    setCurrent(site);
  }

  async function run(endpoint: CommandEndpoint<Site>): Promise<string | null> {
    try {
      if (client === null) return 'Not connected to Nix.';
      setCurrent(await client.execute(endpoint));
      return null;
    } catch (error) {
      return refusalMessage(error);
    }
  }

  return <SiteHostnamesView site={current} run={run} />;
}

/** The section without its data source, for stories and tests. */
export function SiteHostnamesView({
  site,
  run,
}: {
  readonly site: Site;
  readonly run: RunHostnameCommand;
}): ReactNode {
  const [hostname, setHostname] = useState('');
  const [mode, setMode] = useState<'serve' | 'redirect'>('serve');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string>('');
  const customCount = site.hostnames.filter((entry) => entry.kind === 'custom').length;

  async function act(endpoint: CommandEndpoint<Site>): Promise<boolean> {
    setWorking(true);
    setError(null);
    const refusal = await run(endpoint);
    setWorking(false);
    setError(refusal);
    return refusal === null;
  }

  function copy(value: string): void {
    if (!('clipboard' in navigator)) {
      setCopied('The clipboard could not be reached. Select the value and copy it yourself.');
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied('Copied to the clipboard.');
      },
      () => {
        setCopied('The clipboard could not be reached. Select the value and copy it yourself.');
      },
    );
  }

  return (
    <section aria-label="Hostnames" className="flex flex-col gap-2">
      <Text variant="h6" as="h3">
        Hostnames
      </Text>
      <Text variant="note" tone="muted">
        The primary hostname is the one search engines are told to use. Other hostnames either serve
        the same pages or redirect to the primary. Canonical links in pages change at the next
        publish.
      </Text>

      <ul className="flex flex-col gap-3" aria-label="Site hostnames">
        {site.hostnames.map((entry) => (
          <li key={entry.hostname} className="flex flex-col gap-1 border-b border-divider pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <Text variant="body" as="span">
                {entry.hostname}
              </Text>
              {entry.primary ? <Tag tone="accent">Primary</Tag> : null}
              {entry.kind === 'custom' ? (
                <Tag tone={entry.status === 'verified' ? 'neutral' : 'muted'}>
                  {STATUS_COPY[entry.status]}
                </Tag>
              ) : (
                <Tag tone="neutral">Default</Tag>
              )}
              {entry.managed ? <Tag tone="neutral">Managed by Nix</Tag> : null}
            </div>
            {checkErrorCopy(entry.checkError) === null ? null : (
              <Text variant="note" tone="muted">
                {checkErrorCopy(entry.checkError)}
              </Text>
            )}

            {entry.kind === 'custom' && !entry.managed && entry.status !== 'verified' ? (
              <div className="flex flex-col gap-1">
                <Text variant="note">Create these records at your DNS provider:</Text>
                <ul
                  className="flex flex-col gap-1"
                  aria-label={`DNS records for ${entry.hostname}`}
                >
                  {entry.records.map((record) => (
                    <li key={record.type} className="flex flex-wrap items-center gap-2">
                      <Text variant="note" as="span">
                        {`${record.type} ${record.name}`}
                      </Text>
                      <Text variant="note" as="span" tone="muted">
                        {record.value}
                      </Text>
                      <Button
                        variant="secondary"
                        aria-label={`Copy the ${record.type} value for ${entry.hostname}`}
                        onClick={() => {
                          copy(record.value);
                        }}
                      >
                        Copy
                      </Button>
                    </li>
                  ))}
                </ul>
                {entry.records.some((record) => record.type === 'CNAME') ? (
                  <Text variant="note" tone="muted">
                    For a bare domain such as example.com, use your provider’s CNAME flattening or
                    ALIAS record.
                  </Text>
                ) : null}
              </div>
            ) : null}

            {site.canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                {entry.primary ? null : (
                  <>
                    <Button
                      variant="secondary"
                      disabled={working}
                      onClick={() =>
                        void act(
                          sites.updateSiteHostname(site.id, entry.hostname, { primary: true }),
                        )
                      }
                    >
                      Make primary
                    </Button>
                    <Field label={`How ${entry.hostname} answers`}>
                      {(control) => (
                        <Select
                          {...control}
                          value={entry.serveMode}
                          disabled={working}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            if (value === 'serve' || value === 'redirect')
                              void act(
                                sites.updateSiteHostname(site.id, entry.hostname, {
                                  serveMode: value,
                                }),
                              );
                          }}
                        >
                          <option value="serve">Serves the same pages</option>
                          <option value="redirect">Redirects to the primary</option>
                        </Select>
                      )}
                    </Field>
                  </>
                )}
                {entry.kind === 'custom' ? (
                  <>
                    <Button
                      variant="secondary"
                      disabled={working}
                      onClick={() => void act(sites.verifySiteHostname(site.id, entry.hostname))}
                    >
                      Check now
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={working}
                      onClick={() => void act(sites.removeSiteHostname(site.id, entry.hostname))}
                    >
                      Remove
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {/* Live without the status role: the pane already has one status region for the build. */}
      <Text variant="note" aria-live="polite">
        {copied}
      </Text>

      {site.canManage ? (
        <form
          className="flex flex-col gap-2"
          aria-label="Add a hostname"
          onSubmit={(event) => {
            event.preventDefault();
            void act(sites.addSiteHostname(site.id, hostname.trim().toLowerCase(), mode)).then(
              (added) => {
                if (added) setHostname('');
              },
            );
          }}
        >
          <Field
            label="Add a hostname"
            hint={
              customCount >= 10
                ? 'A site may have at most 10 custom hostnames.'
                : 'A domain you control, such as docs.example.com or example.com.'
            }
          >
            {(control) => (
              <Input
                {...control}
                value={hostname}
                maxLength={253}
                onChange={(event) => {
                  setHostname(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Field label="While it is not the primary">
            {(control) => (
              <Select
                {...control}
                value={mode}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value === 'serve' || value === 'redirect') setMode(value);
                }}
              >
                <option value="serve">Serve the same pages</option>
                <option value="redirect">Redirect to the primary</option>
              </Select>
            )}
          </Field>
          <div>
            <Button type="submit" disabled={working || hostname.trim() === '' || customCount >= 10}>
              Add hostname
            </Button>
          </div>
        </form>
      ) : null}

      {error === null ? null : (
        <Text role="alert" variant="note">
          {error}
        </Text>
      )}
    </section>
  );
}
