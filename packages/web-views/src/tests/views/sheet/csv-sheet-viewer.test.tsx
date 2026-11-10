import { SHEET_LIMITS } from '@nix/sheet';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CsvSheetViewer } from '../../../sheet/csv-sheet-viewer';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(cleanup);

async function edit(cell: string, from: string, value: string): Promise<void> {
  fireEvent.doubleClick(screen.getByRole('gridcell', { name: `${cell}, ${from}` }));
  const box = screen.getByRole('textbox', { name: `Edit cell ${cell}` });
  fireEvent.change(box, { target: { value } });
  await userEvent.setup().type(box, '{Enter}');
}

describe('a CSV file in the sheet', () => {
  it('opens as a grid and keeps Save off until something changes', () => {
    render(<CsvSheetViewer fileName="m.csv" source={'a,b\n1,2\n'} onSave={vi.fn()} />);
    expect(screen.getByRole('gridcell', { name: 'B2, 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves the edit with quotes, the file delimiter and raw formulas, then clears dirty', async () => {
    const onSave = vi.fn<(text: string) => Promise<boolean>>(() => Promise.resolve(true));
    render(<CsvSheetViewer fileName="m.tsv" source={'a\tb\n1\t=A2+1\n'} onSave={onSave} />);
    await edit('A1', 'a', 'say\t"hi"');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    await userEvent.setup().click(save);
    expect(onSave).toHaveBeenCalledWith('"say\t""hi"""\tb\n1\t=A2+1\n');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  it('stays dirty when the save fails', async () => {
    render(
      <CsvSheetViewer fileName="m.csv" source={'a\n'} onSave={() => Promise.resolve(false)} />,
    );
    await edit('A1', 'a', 'z');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });
  });

  it('is read-only without a Save control when the file cannot be written', () => {
    render(<CsvSheetViewer fileName="m.csv" source={'a\n'} readOnly onSave={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.doubleClick(screen.getByRole('gridcell', { name: 'A1, a' }));
    expect(screen.queryByRole('textbox', { name: 'Edit cell A1' })).toBeNull();
  });

  it('falls back to the read-only table past the sheet limits', () => {
    const source = `${'x'.repeat(SHEET_LIMITS.maxRawLength + 1)},b\n1,2\n`;
    render(<CsvSheetViewer fileName="big.csv" source={source} onSave={vi.fn()} />);
    expect(screen.getByRole('table', { name: 'big.csv' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
