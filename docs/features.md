# Nix features

The full list of what Nix does today, moved out of the README. Behaviour is defined by the source; this is a map.


## Notes, structure and editing

- Rich notes with headings, lists, tasks, quotes, code, callouts, tables, images, links, columns,
  collapsible sections, colour, page breaks, embedded live note sections, drag handles and slash
  commands. Optional Vim (Normal, Visual, Visual Line, text objects, `.` repeat, search, marks,
  registers, macros and `:s`) and Emacs (kill ring, mark ring, I-search, query replace,
  numeric arguments, registers and keyboard macros) keyboard modes.
- Notes, canvases and spreadsheets as body kinds. Canvases use shared Excalidraw scenes; spreadsheets
  provide A1 addressing, references, ranges, formula functions, dependency tracking and cycle checks.
- Durable file items with immutable versions, replace-in-place, PDF and image previews, file-backed
  editor images, and built-in viewers for EPUB, CSV, Markdown, Mermaid, media and text.
- A composable item tree with nesting, breadcrumbs, drag-to-reparent, cycle checking, a six-entry
  New menu (note, canvas, sheet, upload, structured item, from a template) that asks for a title
  and a location, delete with Undo restore, bookmarks, hidden items, moving items between
  workspaces, two-pane navigation and responsive phone layouts.
- Daily notes with a per-workspace switch, Year/Month folders, a quick capture dialog and a
  "Today" app shortcut.
- CRDT editing over an append-only update log, rebuildable snapshots, WebSocket synchronisation,
  authorization handshakes, presence, live cursors and connection status.
- Version history derived from the collaboration log: revisions, the document as it stood at any
  revision, restore as a new revision, and named versions that retention never deletes.
- Password locks that withhold a subtree's titles, children, views and rollups, and item
  protections (`no_delete`, `no_children`, `managed_by`) for items an integration owns.
- `[[` and `@` references, backlinks, full-text search, a command palette and an accessible graph
  with pan, zoom, fit, neighbourhood highlight, shape by kind, filters, collapsing, a time view and
  saved views.

## Data, views and workflows

- Ancestor-cascading property schemas, validated writes and in-place editing for supported property
  types.
- Formula properties, child rollups and server-backed charts with bounded evaluation and cycle
  detection.
- List, board, calendar, gallery, timeline, spreadsheet, chart, drive, habit tracker, finance,
  Quick Form, Interactive Form and Smart List views, including composed primary and companion
  views; filters on every view, several sort keys and column summaries.
- Guided setup for structured views, with tab-persistent drafts.
- Task semantics for completion, due dates, start dates, priority, estimates and assignees; recurring
  tasks and calendar entries; Today, Next 7 days, Overdue and Assigned to me workflows.
- Habit tracking with check-in and undo, status, streak insights and charts.
- Finance tracking: accounts, loans, budget lines and actuals, transactions, scheduled postings,
  cash flow, a dashboard, a close-month checklist and bank CSV import with preview before commit.
- Reminders as an explicit `reminder` property, due and habit reminders, a notification inbox,
  Web Push through the installed app, quiet hours, a time zone and per-container muting.
- Automations owned by the person who wrote them: schedule, date-arrives and property-changed
  triggers, up to five conditions, and notify, set-property and create-item actions, with a run
  log, a dry run and automatic disable after repeated failures.
- Two-way calendar sync with Google Calendar and Microsoft Outlook from a Calendars settings tab:
  external events in the calendar view, dated Nix items pushed out, last-write-wins with a log,
  and 15-minute drag and resize on entries.
- Model-free suggestions with an off switch: duplicate notices, property suggestions, similar
  items, free-slot and fill-series helpers.
- User-authored, file-backed and managed templates: capture, edit, browse, apply and create from a
  validated template tree, with initialization inputs and relative dates.
- Revocable, opaque Interactive Form links. Sanitized public forms turn responses into ordinary child
  items without exposing the workspace or existing responses.

## Companion

- A ChatGPT companion connected through the Codex device login, with account-scoped character,
  personality, response-length and instruction settings, model selection, per-workspace
  conversations and saved history.
- Explicitly approved companion workspace tools for searching, reading, creating, appending to,
  renaming, moving, trashing, restoring and updating items, and structure tools that create
  structured containers, add views and fields, edit forms and set recurrence. A Design (consult)
  mode validates and builds blueprints and saves them as templates. Every plan is previewed in Nix
  before it runs, reads and writes stay behind Core's permissions, and uncertain results are
  reported for inspection rather than claimed as complete.

## Access, portability and operations

- Core-owned browser BFF authentication with OIDC, PKCE, HttpOnly sessions and short-lived Nix tokens;
  multi-issuer support; workspace-scoped roles, invitations, membership administration, tenant administrators
  managed from Settings, personal workspace provisioning and live revocation. Passwords, passkeys and second factors live at the
  identity provider.
- Nix Sites publish a subtree of a workspace as a static website at `<slug>.<sites-domain>` or a
  verified custom hostname, in a docs or blog layout with navigation, search, feeds, a sitemap and
  link previews. Images, captured Mermaid diagrams and attached PDF, text, CSV, MP4 and WebM files
  are published (videos play in a player, up to 50 MB, and are published as stored, metadata
  included). Locked, excluded, trashed and unscheduled content is withheld; a file removed from
  the site stops being served at the next publish. Where first publishes need approval, operators
  review them in Settings or with `nixctl site approvals`, and can name more approvers and tenant
  administrators in Settings. Off unless `Nix:Sites:Enabled`; see ADR-0063.
- Permission-filtered access backed by Postgres row-level security; roles live in the database, not
  in tokens.
- Personal access tokens with independent `read`, `write` and `admin` scopes and a required expiry
  of 1 to 365 days, for `nixctl`, MCP and scripts. After exchanging a token, a script can read,
  replace, or append a note's Markdown at `GET`, `PUT`, and `POST /api/v1/items/{itemId}/body`.
  The write is the same Yjs update an open editor applies, so live collaborators see it.
- Export of documents and subtrees to lossless `.nix`, PDF, DOCX and Markdown, with declared losses.
- Editable Markdown, TXT, DOCX and PDF imports, `.nix` archive import, and a one-time Obsidian
  vault import. PDF OCR is unavailable.
- `nixctl`, a scriptable CLI with JSON output and 28 command groups: auth, workspaces, items,
  notes, properties, schema, views, query, search, structure and blueprints, templates, history,
  recurrence, calendar and calendar sync, finance, habits, notifications, reminders, automations,
  files, export, import, document import, operations, the companion and stress runs.
- An MCP server started through `nixctl mcp`, authenticated as the acting principal and limited to
  that principal's reach, with 93 tools covering workspaces and members, templates, finance,
  habits, document import, files, the companion, structure and blueprints, notifications,
  reminders, item protection, calendar links and automations. Item CRUD and search stay `nixctl`
  commands.
- One Go worker binary with roles for import, export, signed WebAssembly plugin
  execution, calendar sync and notifications, driven by RabbitMQ; workers use internal
  APIs and object capabilities without database credentials.
- Uploads are inspected by the worker before they are published: size and expiry checks, SHA-256,
  media type from magic bytes, preview and thumbnail generation. Files are not malware-scanned.
- An installable web app with manifest shortcuts (New note, Today, Search), a share target, a
  Markdown file handler, an offline page, last-location restore, right-click context menus and a keyboard shortcuts dialog; light and dark themes.
- Docker Compose production manifests with CI-built multi-architecture images, migrations, seed and
  verification jobs, a smoke-tested release script and a restic-to-R2 backup helper. Kubernetes
  manifests are retained. Logical database dumps alone do not restore file-backed documents.


Each planned area has a measurable stress test. A green test suite is not treated as proof of layout,
accessibility, query plans, export fidelity or production operations until those things are observed.


