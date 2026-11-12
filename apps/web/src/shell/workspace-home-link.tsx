import { Icon, cn } from '@nix/ui';
import { House } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export interface WorkspaceHomeLinkProps {
  readonly to: string;
  readonly current: boolean;
  readonly onActivate: () => void;
  readonly className: string;
}

export function WorkspaceHomeLink({
  to,
  current,
  onActivate,
  className,
}: WorkspaceHomeLinkProps): ReactNode {
  return (
    <Link
      to={to}
      aria-label="Home"
      aria-current={current ? 'page' : undefined}
      title="Homebase"
      className={cn(className, current && 'bg-accent/15 text-accent-text')}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (current) event.preventDefault();
        onActivate();
      }}
    >
      <Icon icon={House} size="sm" />
    </Link>
  );
}
