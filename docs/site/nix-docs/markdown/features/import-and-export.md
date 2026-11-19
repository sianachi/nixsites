# Import and export

Nix is designed so that leaving is cheap. Everything you put in can come out, and any format that cannot carry something tells you before you export.

## Import

Open **Import** on the rail, or use `nixctl import`. Nix accepts:

| Source | Result |
| --- | --- |
| Markdown files and folders | Editable notes; folders keep their hierarchy, and non-hidden attachments come along |
| An Obsidian vault | Notes, folders and attachments, imported once |
| Word documents (DOCX) | Editable notes, with the original file kept as a child |
| PDF | Editable notes from the text, with the original kept as a child |
| UTF-8 text | Editable notes |
| Nix archives (.nix) | The archived items, bodies, properties and views |

Every import shows a preview first. Markdown imports report links that could not be resolved, images that could not be found and formatting that has no equivalent. Obsidian embeds that cannot be resolved are kept as text and listed. Worker-backed imports of documents and archives can be inspected, committed or cancelled by ID, and carry on if your browser disconnects. PDF text is extracted; scanned pages are not read with OCR.

```sh
nixctl import ./vault --workspace <workspace-id> --dry-run
nixctl import ./vault --workspace <workspace-id> --parent <item-id>
```

## Export

Export a single document or a whole subtree from the editor's export menu or with `nixctl export`.

| Format | Best for |
| --- | --- |
| .nix | A lossless archive of items, bodies, properties, views and files that Nix can import again |
| Markdown | Plain text you can read and edit anywhere |
| PDF | Reading and printing, with page breaks honoured. Choose A4 or Letter in the export dialog |
| Word (DOCX) | Editing in a word processor |

Exports draw an item's views into the document, so a board or a calendar appears as it does in Nix. Before you export, Nix lists anything the chosen format cannot represent.

```sh
nixctl export <item-id> --format nix --scope subtree -o projects.nix
nixctl export <item-id> --format md -o note.md
```

A `.nix` archive is a portable copy of your content, not a database backup. For instance backups, see [Backups](nix://item/01a130b0-1468-74cc-ac27-9468e85f46ff).

## Properties

- title: Import and export

