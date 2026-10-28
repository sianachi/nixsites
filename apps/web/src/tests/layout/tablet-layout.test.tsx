import { renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import {
  useDrawerNavigation,
  useNarrowViewport,
  useOverlayDetails,
  useRoomForAnotherPane,
} from '../../layout/viewport';
import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { stubViewport } from '../stub-viewport';

const note = item({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'Tablet document' });
beforeEach(() => {
  signedIn();
  stubCoreApi({ items: [note] });
});

it.each([768, 820, 912])(
  'uses a dismissible workspace drawer at %ipx while keeping document tabs',
  async (width) => {
    stubViewport(width);
    renderAt(<App />, `/?item=${note.id}`);
    await screen.findByRole('textbox', { name: 'Note title' });
    expect(screen.queryByRole('button', { name: 'Children' })).not.toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Open documents' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Explorer' })).not.toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: 'Mobile navigation' });
    await userEvent.click(within(navigation).getByRole('button', { name: 'Explorer' }));
    expect(await screen.findByRole('button', { name: 'Tablet document' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close the Explorer' }));
    expect(screen.getByRole('textbox', { name: 'Note title' })).toBeVisible();
  },
);

it.each([768, 1024, 1180])(
  'opens tablet settings as a dismissible overlay at %ipx',
  async (width) => {
    stubViewport(width);
    renderAt(<App />, `/?item=${note.id}`);
    await screen.findByRole('textbox', { name: 'Note title' });
    expect(screen.queryByRole('button', { name: 'Children' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Item settings' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Item details' });
    expect(within(dialog).getByRole('complementary', { name: 'Item settings' })).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Note title' })).toHaveValue('Tablet document');
  },
);

it('retains a fixed workspace and removes the bottom bar on landscape tablets', async () => {
  stubViewport(1024);
  renderAt(<App />, `/?item=${note.id}`);
  expect(await screen.findByRole('complementary', { name: 'Explorer' })).toBeVisible();
  expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).not.toBeInTheDocument();
});

it('adapts from portrait through landscape to desktop without treating a tablet as a phone', () => {
  stubViewport(820);
  const { result, rerender } = renderHook(() => ({
    phone: useNarrowViewport(),
    drawer: useDrawerNavigation(),
    overlay: useOverlayDetails(),
    split: useRoomForAnotherPane(),
  }));
  expect(result.current).toEqual({ phone: false, drawer: true, overlay: true, split: false });
  stubViewport(1180);
  rerender();
  expect(result.current).toEqual({ phone: false, drawer: false, overlay: true, split: false });
  stubViewport(1366);
  rerender();
  expect(result.current).toEqual({ phone: false, drawer: false, overlay: false, split: true });
  stubViewport(390);
  rerender();
  expect(result.current).toEqual({ phone: true, drawer: true, overlay: true, split: false });
});
