# August 2026

August turned the foundations laid at the end of July (the item tree, cascading fields, collaborative notes and the first list, board, calendar, gallery and timeline views) into a workspace you could live in.

## Editor

- Columns, collapsible sections, references and two new text marks in a new document schema version.
- A drag handle on every block, colour and highlight from a selection bubble, toggles and columns that repair themselves after a merge.
- Wiki links with an item picker, a slash menu read from the document, and a backlinks panel.
- Picture picker with paste, drop, thumbnail and undo.
- Optional Vim and Emacs key bindings, and collaborative undo and redo shortcuts.

## Views and data

- Spreadsheet bodies, with resizable columns.
- Smart lists and a cross-container query view; form and spreadsheet views over a container's children.
- Interactive forms behind revocable public links, and a guided studio for setting up structured views.
- Gallery card sizes. Drag unscheduled items onto the hour they belong at.
- A collated workspace calendar that gathers every calendar into one, with drag to reschedule and a filter by note.
- Task fields with meaning: due date, start date, completion, priority, estimate and assignee, plus an Assigned to me smart list.
- Recurring tasks, worked out when read rather than copied.
- Formula and rollup fields, and the chart view.
- Keyboard navigation between list cells.

## Navigation

- A rail of destinations, notes side by side, tabs per pane with preview and pinned tabs, moving tabs between panes, and F6 to cycle regions.
- A single New menu, a draggable sidebar width, a drawer on small screens and an Undo toast instead of a delete confirmation.
- Bookmarks, so you can keep items from wherever you are looking at them.
- A command palette and permission-filtered search.
- The first workspace graph: drag, zoom, labels on demand and open a note from its node.

## Import, export and templates

- Export to `.nix`, PDF and Word, then Markdown, with a loss report and views drawn into the document.
- Markdown import in the web app and from `nixctl`, with a preview, a report and undo. Markdown pipe tables become editor tables.
- Workspace templates with atomic capture and apply, and managed templates kept up to date on deployment.

## nixctl

- The first release of `nixctl`: workspaces, items, schema, properties, views, queries, search, note bodies as Markdown, import, export and recurrence.
- Stress commands for seeding a container at scale and measuring read, query and search latency.

## Accounts and the app

- Personal access tokens, with a management screen.
- Sign-in mediated by Core, with personal workspaces created on first sign-in.
- Shared workspaces with invitations, membership and roles.
- Daily notes and a Today shortcut.
- Nix became installable as an app.
- Durable background jobs and Go workers over RabbitMQ for imports and exports.

## Canvas

- Item cards that show properties and open their item, images, a shape library and multi-selection.

## Properties

- date: 2026-08-31
- tags: editor; views; formulas; templates; import; export; cli; pwa
- title: August 2026

## Fields

### Date

- aggregate: Unset
- expression: Unset
- key: date
- label: Date
- options: 
- required: false
- source: Unset
- type: date

### Tags

- aggregate: Unset
- expression: Unset
- key: tags
- label: Tags
- options: automations; calendar; charts; cli; deploy; editor; export; files; finance; formulas; habits; import; locks; offline; pets; pwa; reminders; sites; templates; views
- required: false
- source: Unset
- type: multi\_select

