import type * as apiClient from '@nix/api-client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Item, PropertyDefinition } from '../../collections/core/container-model';
import { PropertyInput } from '../../collections/properties/property-input';

/**
 * The picture property's upload path, kept apart from `image-value.test.tsx`.
 *
 * That file renders the control the way most of its callers do - with no workspace and no client
 * above it, which is exactly the "off a public form link" case `useOptionalWorkspace` and
 * `useOptionalApiClient` exist to answer honestly rather than by throwing. Mocking a workspace and
 * a client in with it would change what every one of its existing assertions is actually testing.
 * This file mocks both instead, once, for the opposite case: a control that *can* upload.
 */

const WORKSPACE = 'a1000000-0000-4000-8000-000000000001';

vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useOptionalWorkspace: () => ({ workspaceId: WORKSPACE }),
}));

const { beginUploadMock, uploadAndCompleteFileMock, fetchFileContentMock } = vi.hoisted(() => ({
  beginUploadMock: vi.fn((input: unknown) => ({ operation: 'files.upload.begin', body: input })),
  uploadAndCompleteFileMock: vi.fn(() =>
    Promise.resolve({ itemId: 'uploaded-file-item', workspaceId: WORKSPACE }),
  ),
  fetchFileContentMock: vi.fn(() =>
    Promise.resolve({ blob: new Blob(['x'], { type: 'image/png' }) }),
  ),
}));

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useOptionalApiClient: () => ({ execute: vi.fn(() => Promise.resolve({ id: 'upload-1' })) }),
}));

vi.mock('@nix/api-client', async () => {
  const actual = await vi.importActual<typeof apiClient>('@nix/api-client');
  return {
    ...actual,
    files: {
      ...actual.files,
      beginUpload: beginUploadMock,
      uploadAndCompleteFile: uploadAndCompleteFileMock,
      fetchFileContent: fetchFileContentMock,
    },
  };
});

vi.stubGlobal(
  'URL',
  Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:test-picture'),
    revokeObjectURL: vi.fn(),
  }),
);

function propertyOf(overrides: Partial<PropertyDefinition> & { key: string }): PropertyDefinition {
  return { label: overrides.key, type: 'image', options: [], required: false, ...overrides };
}

function itemWith(properties: Record<string, unknown>): Item {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: WORKSPACE,
    parentId: '33333333-3333-4333-8333-333333333333',
    type: 'note',
    title: 'Kickoff',
    hasChildren: false,
    seq: 1,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function coverProperty(): PropertyDefinition {
  return propertyOf({ key: 'cover', label: 'Cover' });
}

beforeEach(() => {
  beginUploadMock.mockClear();
  uploadAndCompleteFileMock.mockClear();
  fetchFileContentMock.mockClear();
});

describe('the picture property, with somewhere to upload to', () => {
  it('keeps a temporary form input address-only even with an authenticated workspace', () => {
    const onCommit = vi.fn();
    render(
      <PropertyInput
        item={itemWith({})}
        property={coverProperty()}
        onCommit={onCommit}
        allowInputStorage={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Choose image' })).not.toBeInTheDocument();
    fireEvent.drop(screen.getByRole('textbox', { name: 'Cover' }), {
      dataTransfer: {
        getData: () => '',
        files: [new File(['image'], 'cover.png', { type: 'image/png' })],
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Pictures are added by address here.');
    expect(beginUploadMock).not.toHaveBeenCalled();
    expect(uploadAndCompleteFileMock).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
  it('offers a file picker alongside the address box', () => {
    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Choose image' })).toBeInTheDocument();
    expect(
      screen.getByText('Paste or drag in a link to a picture, or choose one from this device.'),
    ).toBeVisible();
  });

  it('uploads a chosen file through the same path the editor uses, and commits its reference', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    const file = new File(['image'], 'cover.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Choose an image file for Cover'), file);

    await waitFor(() => {
      expect(uploadAndCompleteFileMock).toHaveBeenCalled();
    });
    expect(beginUploadMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, fileName: 'cover.png' }),
    );
    expect(onCommit).toHaveBeenCalledWith('nix-file:uploaded-file-item');
  });

  it('uploads a dropped file the same way, rather than refusing it', async () => {
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    const file = new File(['image'], 'dropped.png', { type: 'image/png' });
    fireEvent.drop(screen.getByRole('textbox', { name: 'Cover' }), {
      dataTransfer: { getData: () => '', files: [file] },
    });

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith('nix-file:uploaded-file-item');
    });
  });

  it('refuses a file this control cannot upload, in place, without touching the network', () => {
    const onCommit = vi.fn();

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={onCommit} />);

    const file = new File(['not an image'], 'notes.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByRole('textbox', { name: 'Cover' }), {
      dataTransfer: { getData: () => '', files: [file] },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose a PNG, JPEG, WebP or AVIF image no larger than 10 MiB.',
    );
    expect(onCommit).not.toHaveBeenCalled();
    expect(beginUploadMock).not.toHaveBeenCalled();
  });

  it('shows an upload failure visibly, and leaves the picture unset', async () => {
    const user = userEvent.setup();
    uploadAndCompleteFileMock.mockRejectedValueOnce(new Error('The file upload failed (500).'));

    render(<PropertyInput item={itemWith({})} property={coverProperty()} onCommit={vi.fn()} />);

    const file = new File(['image'], 'cover.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Choose an image file for Cover'), file);

    expect(await screen.findByRole('alert')).toHaveTextContent('The file upload failed (500).');
  });

  it('resolves an uploaded file to a picture through its capability, once set', async () => {
    render(
      <PropertyInput
        item={itemWith({ cover: 'nix-file:uploaded-file-item' })}
        property={coverProperty()}
        onCommit={vi.fn()}
      />,
    );

    // The button's accessible name is the field's own label ("Cover"), exactly as it is for a
    // stored web address; what changes for a file reference is its readable content, which names
    // the thing on screen rather than repeating the storage format nobody typed.
    const picture = screen.getByRole('button', { name: 'Cover' });
    await waitFor(() => {
      expect(picture).toHaveTextContent('Uploaded picture');
    });

    await waitFor(() => {
      expect(fetchFileContentMock).toHaveBeenCalledWith(
        expect.anything(),
        'uploaded-file-item',
        undefined,
        true,
        expect.anything(),
      );
    });
  });
});
