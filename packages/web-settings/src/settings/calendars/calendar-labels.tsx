import type { CalendarLink } from '@nix/api-client';
import { Tag } from '@nix/ui';
import type { ReactNode } from 'react';

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  google: 'Google Calendar',
  microsoft: 'Outlook',
};

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** What came back from the provider's consent screen, read from the address it returned to. */
export const RETURN_NOTICES: Readonly<Record<string, string>> = {
  connected: 'The account is connected. Link one of its calendars to start syncing.',
  cancelled: 'Connecting was cancelled. Nothing was changed.',
  failed: 'The account could not be connected. Try again.',
};

export function connectionTag(status: string): ReactNode {
  if (status === 'active') {
    return <Tag tone="accent">Connected</Tag>;
  }
  return (
    <Tag tone="muted">{status === 'needs_reauth' ? 'Needs reconnecting' : 'Disconnected'}</Tag>
  );
}

export function linkTag(link: CalendarLink): ReactNode {
  if (link.status === 'active') {
    return <Tag tone="accent">Syncing</Tag>;
  }
  if (link.status === 'paused') {
    return <Tag tone="muted">Paused</Tag>;
  }
  return <Tag tone="muted">{link.status === 'error' ? 'Failing' : 'Stopped'}</Tag>;
}

export function formatMoment(value: string | null): string {
  return value === null ? 'never' : new Date(value).toLocaleString();
}

/** One line under the title: how many accounts are connected and how many calendars sync. */
export function calendarSummary(
  connections: readonly { readonly status: string }[],
  links: readonly { readonly status: string }[],
): string {
  const accounts = connections.filter((connection) => connection.status === 'active').length;
  const syncing = links.filter((link) => link.status === 'active').length;
  return `${String(accounts)} ${accounts === 1 ? 'account' : 'accounts'} connected, ${String(syncing)} ${syncing === 1 ? 'calendar' : 'calendars'} syncing.`;
}
