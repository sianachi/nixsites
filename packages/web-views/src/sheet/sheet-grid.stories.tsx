import { writeCell } from '@nix/sheet';
import { useEffect, useState, type ReactNode } from 'react';
import * as Y from 'yjs';

import { SheetGrid } from './sheet-grid';
import { useSheet } from './use-sheet';

export default { title: 'Nix/Views/Sheet body', parameters: { layout: 'padded' } };

function Example(): ReactNode {
  const [doc] = useState(() => {
    const sheet = new Y.Doc();
    writeCell(sheet, { row: 0, col: 0 }, 'Monthly plan');
    writeCell(sheet, { row: 1, col: 0 }, 'Rent');
    writeCell(sheet, { row: 1, col: 1 }, '800');
    writeCell(sheet, { row: 2, col: 0 }, 'Groceries');
    writeCell(sheet, { row: 2, col: 1 }, '240');
    writeCell(sheet, { row: 3, col: 0 }, 'Total');
    writeCell(sheet, { row: 3, col: 1 }, '=SUM(B2:B3)');
    return sheet;
  });
  const sheet = useSheet(doc);
  useEffect(
    () => () => {
      doc.destroy();
    },
    [doc],
  );

  return (
    <div className="flex h-[75dvh] min-w-0 flex-col">
      <SheetGrid sheet={sheet} />
    </div>
  );
}

export const Desktop = { render: (): ReactNode => <Example /> };
export const Phone = { ...Desktop, parameters: { viewport: { defaultViewport: 'mobile1' } } };
export const Tablet = { ...Desktop, parameters: { viewport: { defaultViewport: 'tablet' } } };
export const DarkDesktop = { ...Desktop, globals: { ground: 'dark' } };
export const DarkPhone = { ...Phone, globals: { ground: 'dark' } };
export const DarkTablet = { ...Tablet, globals: { ground: 'dark' } };
