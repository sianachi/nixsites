import * as Y from 'yjs';

const FRAGMENT = 'default';

function fragmentText(node: Y.XmlFragment | Y.XmlElement): string {
  const blocks: string[] = [];
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText)
      blocks.push(
        (child.toDelta() as { insert?: unknown }[])
          .map((part) => (typeof part.insert === 'string' ? part.insert : ''))
          .join(''),
      );
    else if (child instanceof Y.XmlElement) blocks.push(fragmentText(child));
  }
  return blocks.join(node instanceof Y.XmlElement && node.nodeName === 'paragraph' ? '' : '\n');
}

/**
 * The plain text of a refused note edit kept by the mirror, so it can be copied out and pasted
 * back. Formatting is not kept: the point is that the words are not lost.
 */
export function recoveryText(update: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    const fromFragment = fragmentText(doc.getXmlFragment(FRAGMENT)).trim();
    return fromFragment !== '' ? fromFragment : doc.getText('content').toJSON();
  } finally {
    doc.destroy();
  }
}
