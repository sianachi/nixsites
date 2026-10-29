import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { PwaControls } from '../../pwa/pwa-controls';

afterEach(() => {
  vi.restoreAllMocks();
});

it('renders nothing while online with no update waiting', () => {
  const { container } = render(<PwaControls />);
  expect(container).toBeEmptyDOMElement();
});

it('shows one offline row and never an install nudge', () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  render(<PwaControls />);
  expect(screen.getByRole('status')).toHaveTextContent('Offline.');
  expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument();
});
