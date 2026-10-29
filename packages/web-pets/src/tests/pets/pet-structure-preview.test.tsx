import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PreviewModel } from '@nix/structure-spec';
import { PetStructurePreview } from '../../pets/pet-structure-preview';

function model(overrides: Partial<PreviewModel> = {}): PreviewModel {
  return {
    headline: 'I will create a reading board.',
    destination: { title: 'Reading log', path: ['Books', 'Reading log'] },
    counts: { items: 3, fields: 7, views: 2, entries: 0, writes: 12 },
    tree: [],
    notes: [],
    warnings: [],
    problems: [],
    neverDoes: ['Publish a public link', 'Delete anything permanently'],
    ...overrides,
  };
}

describe('PetStructurePreview', () => {
  it('renders the destination and counts on one line, leaving the headline to its frame', () => {
    render(<PetStructurePreview model={model()} />);
    expect(screen.queryByText('I will create a reading board.')).not.toBeInTheDocument();
    // UX fix U15: a zero count is dropped rather than shown as "0 entries".
    expect(
      screen.getByText('In: Books / Reading log · 3 items, 7 fields, 2 views, 12 writes'),
    ).toBeVisible();
    expect(screen.getByText(/This never: Publish a public link/)).toBeVisible();
  });

  it('collapses descendants beyond depth two with the full hidden-node count', async () => {
    render(
      <PetStructurePreview
        model={model({
          tree: [
            {
              label: 'Board',
              detail: [],
              children: [
                {
                  label: 'Reading list',
                  detail: [],
                  children: [
                    {
                      label: 'Fields',
                      detail: [],
                      children: [
                        { label: 'Rating', detail: [], children: [] },
                        { label: 'Finished', detail: [], children: [] },
                        { label: 'Notes', detail: [], children: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        })}
      />,
    );
    expect(screen.queryByText('Rating')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));
    expect(screen.getByText('Rating')).toBeVisible();
    expect(screen.getByText('Notes')).toBeVisible();
  });

  it('never folds descendants, "Why", or warnings on a pending card (security fix S1)', () => {
    render(
      <PetStructurePreview
        pending
        model={model({
          warnings: [{ path: 'fields[0]', code: 'notice', message: 'Worth a look.' }],
          tree: [
            {
              label: 'Board',
              detail: [],
              why: 'Because the pet said so.',
              children: [
                {
                  label: 'Reading list',
                  detail: [],
                  children: [
                    {
                      label: 'Fields',
                      detail: [],
                      children: [
                        { label: 'Rating', detail: [], children: [] },
                        { label: 'Finished', detail: [], children: [] },
                        { label: 'Notes', detail: [], children: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument();
    expect(screen.getByText('Rating')).toBeVisible();
    expect(screen.getByText('Notes')).toBeVisible();
    expect(screen.getByText('Because the pet said so.')).toBeVisible();
    expect(screen.getByText(/Worth a look\./)).toBeVisible();
  });

  it('renders model-authored text literally without interpreting markup or links', () => {
    render(
      <PetStructurePreview
        model={model({
          tree: [
            {
              label: '<b>x</b> [link](javascript:alert(1))',
              detail: [],
              why: '<img src=x onerror=alert(1)>',
              children: [],
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('<b>x</b> [link](javascript:alert(1))')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });

  it('puts blocking problems under an alert', () => {
    render(
      <PetStructurePreview
        model={model({
          problems: [{ path: 'fields[0].key', code: 'invalid', message: 'The key is not valid.' }],
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot run');
    expect(screen.getByRole('alert')).toHaveTextContent('fields[0].key: The key is not valid.');
  });

  it('renders a form diff with added and removed questions', () => {
    render(
      <PetStructurePreview
        model={model({
          headline: 'I will update the interactive form on Reading log.',
          tree: [
            {
              label: 'Page 1: Review',
              detail: [
                'Added question: Rating',
                'Removed question: Old rating',
                'Reworded question: Notes',
                'Now shown when Status equals Done.',
              ],
              children: [],
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('Page 1: Review')).toBeVisible();
    expect(screen.getByText('Added question: Rating')).toBeVisible();
    expect(screen.getByText('Removed question: Old rating')).toBeVisible();
    expect(screen.getByText('Reworded question: Notes')).toBeVisible();
    expect(screen.getByText('Now shown when Status equals Done.')).toBeVisible();
  });

  it('states the recurrence schedule in words', () => {
    render(
      <PetStructurePreview
        model={model({
          headline: 'I will make the linked item repeat every 2 weeks on Monday and Friday.',
          counts: { items: 0, fields: 0, views: 0, entries: 0, writes: 1 },
          tree: [
            {
              label: 'Recurrence',
              detail: ['every 2 weeks on Monday and Friday'],
              children: [],
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('every 2 weeks on Monday and Friday')).toBeVisible();
  });

  it('places its children after the notes and before the warnings', () => {
    render(
      <PetStructurePreview
        model={model({
          notes: ['A note'],
          warnings: [{ path: 'This section', code: 'x', message: 'A warning' }],
        })}
        pending
      >
        <p>The comparison</p>
      </PetStructurePreview>,
    );
    const note = screen.getByText('A note');
    const child = screen.getByText('The comparison');
    const warning = screen.getByText('This section: A warning');
    expect(note.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(child.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
