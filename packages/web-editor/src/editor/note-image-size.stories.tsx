import { useState, type ReactElement } from 'react';
import { NoteImageSize } from './note-image-size';

export default { title: 'Nix/Editor/Image size', parameters: { layout: 'padded' } };

function Example({ initialWidth }: { readonly initialWidth?: number }): ReactElement {
  const [width, setWidth] = useState<number | undefined>(initialWidth);
  return <NoteImageSize width={width} onChange={setWidth} />;
}

export const OriginalSize = { render: (): ReactElement => <Example /> };
export const Resized = { render: (): ReactElement => <Example initialWidth={320} /> };
