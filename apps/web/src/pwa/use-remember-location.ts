import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useSessionStore } from '../lib/session-store';
import { rememberLocation } from './last-location';

export function useRememberLocation(workspaceId: string): void {
  const location = useLocation();
  const subject = useSessionStore((state) => state.profile?.subject);
  useEffect(() => {
    if (subject)
      rememberLocation(
        subject,
        workspaceId,
        `${location.pathname}${location.search}${location.hash}`,
      );
  }, [subject, workspaceId, location.pathname, location.search, location.hash]);
}
