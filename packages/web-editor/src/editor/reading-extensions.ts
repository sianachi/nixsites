import { nixExtensions } from '@nix/editor-schema';

import { headingClass, proseClasses } from './prose';

/**
 * The note schema with its clothes on, and none of its node views.
 *
 * `nixExtensions` is the editable schema: every node also carries the interactive machinery
 * (drag handles, resize corners, slash-menu affordances) that only makes sense on a document
 * somebody can change. A read-only rendering - a Markdown file preview, a history revision - wants
 * the same class map so the same document looks the same whether it is being edited or merely
 * shown, but none of that machinery. This is that projection: each extension configured with the
 * class it wears in `prose.ts`, and nothing else touched.
 *
 * Shared by `plugins/markdown-viewer.tsx` and `history/history-sidebar.tsx` so the two read-only
 * surfaces cannot quietly drift into two different renderings of the same schema.
 */
export const readingExtensions = nixExtensions.map((extension) => {
  if (extension.name === 'heading') {
    return extension.extend({
      renderHTML({
        node,
        HTMLAttributes,
      }: {
        node: { attrs: { level?: unknown } };
        HTMLAttributes: Record<string, unknown>;
      }) {
        const level = Number(node.attrs.level ?? 1);
        return [`h${String(level)}`, { ...HTMLAttributes, class: headingClass(level) }, 0];
      },
    });
  }
  const className = proseClasses[extension.name];
  return className === undefined
    ? extension
    : extension.configure({ HTMLAttributes: { class: className } });
});
