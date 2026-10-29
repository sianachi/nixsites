import type { Extensions } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { Highlight } from '@tiptap/extension-highlight';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Image } from '@tiptap/extension-image';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Strike } from '@tiptap/extension-strike';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Text } from '@tiptap/extension-text';
import { Underline } from '@tiptap/extension-underline';

import { TextAlignmentAttributes, TextAlignmentEditing } from './text-alignment.js';
import { ItemBlock, PageBreak } from './note-blocks.js';
import { Callout } from './callout.js';
import { ColumnEditing } from './column-commands.js';
import { Column, ColumnBlock } from './columns.js';
import { CommentMark, TextColorMark } from './marks.js';
import { Reference } from './references.js';
import {
  SuggestionAttributes,
  SuggestionDeleteMark,
  SuggestionFormatMark,
  SuggestionInsertMark,
} from './suggestions.js';
import { Details, DetailsContent, DetailsSummary } from './details.js';

/**
 * The document's block and mark set.
 *
 * **Schema only.** Nothing here installs editing behaviour - no gap cursor, no drop
 * cursor, no keymaps, no history. Those belong to the editor and are added by
 * `apps/web`; the collaboration service builds this same list in Node to check that an
 * update still produces a document that parses, and has no use for any of them.
 *
 * **The set is close to complete on purpose.** `SCHEMA_VERSION` is what stored documents
 * are validated against, so a block added later is a version bump every stored document
 * has to be migrated past. Tables and callouts are here now rather than as a follow-on
 * for exactly that reason - they are the two that a thin first cut always omits and
 * always needs.
 */
export const nixExtensions: Extensions = [
  // Structure.
  Document.extend({ content: '(block | pageBoundary)+' }),
  Paragraph,
  TextAlignmentAttributes,
  SuggestionAttributes,
  Text,
  HardBreak,

  // Blocks.
  Heading.configure({ levels: [1, 2, 3] }),
  Blockquote,
  CodeBlock.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        /**
         * Version 6. A Mermaid block's captured picture (ADR-0063): the file item holding it, and
         * the SHA-256 of the source it was drawn from. Neither travels through HTML, so a pasted
         * copy captures its own picture rather than sharing, and overwriting, this one's file.
         */
        renderFileId: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
        renderSourceHash: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      };
    },
  }),
  HorizontalRule,
  Callout,
  Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        /** A durable Nix file item. Its preview URL is resolved only while rendering. */
        fileItemId: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-nix-file-id'),
          renderHTML: (attributes) =>
            typeof attributes.fileItemId === 'string' && attributes.fileItemId.length > 0
              ? { 'data-nix-file-id': attributes.fileItemId }
              : {},
        },
      };
    },
  }),

  // Lists. Nesting is allowed; a list item holds blocks, so a bullet can carry a
  // paragraph and a nested list rather than text alone.
  BulletList,
  OrderedList,
  ListItem,
  TaskList,
  TaskItem.configure({ nested: true }),

  // Tables, via prosemirror-tables. The one block where a naive schema produces a
  // structure nobody can edit sanely - column sizing, cell selection, merged cells -
  // and the ProseMirror table module is the mature answer. Yjs merges its cell nodes
  // like any others, so collaboration needs nothing special here.
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,

  // Composition, added at SCHEMA_VERSION 2. A row of columns is the horizontal axis of a
  // document's layout; the vertical one is ordinary flow and needs no node.
  ColumnBlock,
  Column,

  // Collapsible sections, also version 2. Three node types because that is what a summary
  // and a body are; no `open` attribute, because a collapse is a reading posture and storing
  // it would fold the section for everybody at once.
  Details,
  DetailsSummary,
  DetailsContent,

  // A pointer to another item, or to a person. Version 2. The two blocks computed from the
  // document's own shape - a table of contents, a breadcrumb - are deliberately *not* here:
  // both need a renderer that walks something this build does not yet walk, and legalising a
  // node that draws an empty box costs a version bump to take back.
  Reference,
  ItemBlock,
  PageBreak,

  // Marks.
  Bold,
  Italic,
  Underline,
  Strike,
  Code,
  Highlight.configure({ multicolor: false }),
  Link.configure({ openOnClick: false, autolink: true }),

  // Version 2. Colour by token name rather than by CSS value, and the range a comment
  // thread hangs off.
  TextColorMark,
  CommentMark,

  // Version 7. Track-changes marks; the block-level half is `SuggestionAttributes`.
  SuggestionInsertMark,
  SuggestionDeleteMark,
  SuggestionFormatMark,
];

/**
 * The extension list an *editor* builds from: the schema, plus the behaviour that keeps a
 * column structure one the product can draw.
 *
 * **Why the pairing has a name.** `nixExtensions` is schema only, and `ColumnEditing` is not
 * optional to it in an editor: without it the slash menu offers a row of columns whose commands
 * are not registered, which fails by doing nothing at all. Naming the pair is what stops each
 * caller assembling it - and forgetting it - by hand.
 *
 * The collaboration service keeps building `nixExtensions`: it parses documents and repairs
 * nothing (see `columnRepairPlugin` for why the repair is a client's job today), so the schema
 * alone is what it needs.
 */
export const nixEditingExtensions: Extensions = [
  ...nixExtensions,
  ColumnEditing,
  TextAlignmentEditing,
];
