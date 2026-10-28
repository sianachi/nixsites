import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@nix/ui';
import { ErrorPanel } from './states/status-panels';

/**
 * The application's crash barrier.
 *
 * React still requires a class for this - there is no hook equivalent - so
 * this is the one class component in the app. It sits at the root, inside the
 * router, so recovery can re-render the current route rather than forcing a
 * full page reload.
 *
 * Honesty rules it follows:
 *   - It says a render failed. It does not show an empty page or a permanent
 *     spinner, which are the two ways a crash usually reaches a user.
 *   - It surfaces the thrown message. A user cannot act on it, but they can
 *     report it, and support can act on it.
 *   - It always offers a recovery affordance, because the failure may be
 *     transient and a reload is a worse first suggestion than a retry.
 *
 * `onReset` lets a caller clear whatever produced the failure (a route param,
 * a cache entry) before the subtree is re-mounted.
 */

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onReset?: (() => void) | undefined;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Telemetry lands here in a later goal. Until then the console is the
    // only sink, and swallowing the stack silently would be worse.
    console.error('Unhandled render error', error, info.componentStack);
  }

  private readonly handleReset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }

    return (
      <div className="p-6">
        <ErrorPanel
          title="This view failed to render"
          detail={`The error was: ${error.message}. Retrying re-renders this view; if it keeps failing, the report will help us fix it.`}
          action={<Button onClick={this.handleReset}>Try again</Button>}
        />
      </div>
    );
  }
}
