# October 2026

# October 2026

## Version 0.5.0

### A workspace for people and their AI agents

- Nix is now presented as a free, open-source workspace where people and their AI agents work together, and is licensed under AGPL-3.0 from this version. Using and self-hosting Nix, including commercially, is unaffected; running a modified Nix for other people means offering them its source. Versions up to 0.4.x stay MIT.
- The landing page and the live demo show the companion at work: in the demo, a sample chat answers from the workspace, builds a table, makes an approved change and remembers a preference.

### The companion

- Pets can do anything you can do in Nix. For actions without their own tool, a pet finds the action and asks before running it; the approval card shows the exact request, and permanent deletes, access changes and publishing carry a warning. Pets never touch access tokens, AI keys, pet settings or calendar accounts.
- Search by meaning across the workspace, so a note that says "holiday" answers a question about a trip, and across a note far too long to read in one go, such as a 200-page document. The small search model runs inside the server, with no key or cost.
- The companion remembers lasting facts and preferences. Settings > Pets > Memory lists them to edit or forget, and chooses whether pets don't remember, ask first (the default) or remember automatically, with Undo in the chat.
- With an Anthropic or OpenRouter key, long tool runs no longer make it forget the start of a conversation, and replies cost less and start sooner.

### Working together

- Comments on notes, with replies, resolving and @mentions, and a Commenter role that can read and comment but not edit.
- Suggesting mode: propose edits for others to accept or reject one by one or all at once.
- Live collaboration can be switched off for a workspace or a file, so one person edits at a time.
- Invitations arrive in the inbox and grant nothing until accepted. Owners can close a workspace to new members.

### Everyday use

- Homebase is where a workspace opens: today's date, one-press New note, Today's note, Calendar, Templates and your recent notes. It replaces My Day.
- The note tree is now the Explorer. Drag files and folders from your computer onto it, and use its New note button for an untitled note in one press.
- An embedded note shows its views, with tabs to switch between them. Every note shows a word count, reading time and heading outline.
- Charts can group by priority, checkbox or completion, and a period chart without a date says so.
- PDF and DOCX exports draw Mermaid diagrams as pictures.

### nixctl and MCP

- `nixctl api list` and `nixctl api call` reach every operation by id, and the MCP tools `find_nix_action` and `run_nix_action` do the same for agents, except credentials. New MCP tools move, rename, trash and restore items, set properties, and work with comments and note history.

### Removed

- My Day, offline notes and the "Show status footer" setting. Sync any notes created offline in 0.4 before updating.

### Security

- Upload links now fix the stored file's type. Reload tabs and installed apps opened before the update, and update `nixctl`, or uploads fail with a 403.
- The last-administrator guard counts only administrators who can act, and two administrators can no longer remove each other at once.
- Both production edges forbid framing the app, dependencies with advisories are updated, and CI actions and images are pinned.

## Version 0.4.0

### Site style choices

- Pick a site's typeface (rounded Nunito Sans, book serif Literata or Atkinson Hyperlegible Next), the mark before headings and cards (square, diamond or none) and its spacing (compact, comfortable or airy), in the site settings or with `nixctl site update`. Every font is self-hosted.
- Code blocks have a Copy button, and a section's `#` link copies the link to that section. In search, the arrow keys move through the results and Enter opens the first one.
- On phones, docs pages fold "On this page" above the text and the site navigation sits on one scrolling row. Every page ends with "Back to top".
- Links take the site's accent colour, adjusted until it reads clearly on both themes. List views show each page's first properties beside its title, and charts label their columns and fit phone screens.
- A blog home page no longer repeats what the top navigation already links.

### Note bodies over the API

- Read, replace or append a note body as Markdown at `/api/v1/items/{itemId}/body` with a personal access token. An editor that already has the note open sees the change, and appending leaves the existing text in place.

### Landing page and demo

- An install can show a landing page to signed-out visitors and offer a demo that tries the board, list, calendar, timeline, spreadsheet, gallery, checklist and matrix views on sample data in the browser, with no account. Both are off unless the install turns them on.

### Self-hosting

- A Kubernetes install can turn remote MCP off with `NIX_MCP_ENABLED=false`.
- A Compose release now starts the remote MCP service when its profile is on.
- The one-line install lists what it needs, including about 8 GB of memory for Docker, stops if a tool is missing and warns when Docker has less memory.

## Version 0.3.1

### One-line install

- One command installs or upgrades Nix on a machine of your own: it generates every secret, bundles the identity provider behind Caddy with automatic HTTPS, migrates the database and prints the administrator sign-in. Run it again to upgrade. `http://nix.localhost` gives a try-out without DNS, and `--kubernetes` installs into a cluster.
- Releases now name their images `vX.Y.Z` and `latest`, so an install picks up the current release without a commit hash.

### Interactive replies and artifacts

- The pet and chat notes can answer with live components: calculators, quizzes, converters, forms, tables, charts and lists of your items. Lists stay live and respect permissions and locks.
- Save any component as an artifact: a new item kind that opens in a pane, embeds in notes and keeps its values for everyone who opens it. Edit its source like a note, or ask the pet to change it, with a before and after preview.
- Components can change your workspace through an approval card, and simple requests (titles, note text, property values, task completion) can be edited before you approve.
- The pet can add a custom view to a collection and change its program; the approval card shows the whole program before and after.
- Published sites show a notice in place of an interactive component.

### Pet attachments

- The pet reads files you attach or link in a note: text, Markdown, CSV and JSON as text, PDFs by their text, and images as pictures it can see.

### Vim and Emacs modes

- Vim: text objects, `.` repeat, `f`/`t` motions, search with `/` and `?`, marks, registers, macros and `:` commands.
- Emacs: incremental search, query replace, goto-line, numeric arguments, word case and transposing commands, a mark ring, registers and keyboard macros.

### Fixes

- Copying spreadsheet cells that hold line breaks, tabs or quotes no longer spills into the rows below on paste.
- A one-line text property that holds line breaks is edited as several lines, so the first edit no longer joins them.
- Spreadsheet cells edit long text in a box that grows, and long text in list and calendar cells rests as one clean line.
- Board and gallery cards no longer read each value twice to a screen reader.

## Version 0.3.0

### Sites

- Attach an MP4 or WebM video (up to 50 MB) to a note and it plays on your published site, with a download link underneath. Videos are published exactly as you recorded them, so remove any location or device information first.
- A file you remove from your site stops being served as soon as you publish again.
- Publishing now lists posts that were left out because they are scheduled, undated or have an invalid date.
- Site approvals can be handled in Settings: approvers see waiting sites, with the hostnames and who asked, and approve or reject them there.
- An Administrators tab in Settings lets tenant administrators add and remove other administrators, and lets approvers name more site approvers.

### My Day and views

- My Day shows the tasks that are due, overdue or assigned to you and the habits scheduled today, and says when a limit hides some of them. `nixctl my-day` reads the same list.
- Outline, timeline and calendar views use the same multi-select as the other views, and habit trackers gain the shared item actions.
- Drive uses checkboxes, range selection and a floating bulk-action tray.
- Dynamic fields, workspace groups and durable group chats.
- Turn a note into sensible views, or write a note from your views, with the original always kept. PDF, Word and Markdown exports now include readable versions of every view.

### nixctl

- `nixctl canvas` reads and writes canvases.

### Fixes

- Selecting items across a long sidebar and deleting them works, and view selection keeps focus and native gestures.
- Mermaid diagrams load only when one is shown.
- Archive exports are identical across time zones.

## Offline notes

- The installed app can download every note you have access to, open them with no connection, edit and create notes offline, and sync when you are back. See [Collaboration and offline](nix://item/01a130b0-0b97-7da4-aaf4-8ece03849441).

## Sites

- Publish any page tree as a static website, with a docs layout and a blog and portfolio layout, stable paths, rollback and three republish modes. This site is the first one. See [Sites](nix://item/01a130b0-106e-79a7-868c-435fae417b52).

## Views, queries and charts

- Three new views: Checklist, Matrix and Outline.
- List views can be gathered into sections, and smart lists appear in the navigation rail.
- Filters on every view, several sort keys, wider grouping and column summaries.
- Filters with any-of groups, structural fields such as the kind of item, and relative day tokens.
- A title search and saved filters inline above each view.
- Charts gained column, pie, line and area types, a time axis, series split by a choice field, and a year grid. Habit insights show a year grid too.
- Spreadsheet view cells are edited with controls that match each field's type.
- Ad-hoc queries and aggregates across a workspace.
- Each view has an "Open items" setting: Auto, Full page, Dialog, Beside, New tab or None. Graph nodes have their own control.
- Multi-select in lists, galleries, boards and checklists with Shift or checkboxes, and a floating tray for bulk move and delete. Items that cannot move say why.
- Resizable columns in list and spreadsheet views, remembered per device. Drag list rows onto each other to reparent them.
- Rename, Move to and Delete are available from every view that supports them.

## Formulas

- An extended formula language and a full formula guide with worked examples, error explanations and limits.

## Calendar and protections

- Two-way sync with Google Calendar and Microsoft Outlook, managed from a Calendars tab in settings, with a visible sync log.
- Drag and resize calendar entries in 15-minute steps, and a fixed month grid.
- Item protections: no delete and no children, and managed items for linked calendars.

## Writing and navigation

- A six-entry New menu that asks for a title and a location for every new item.
- Usable Vim and Emacs modes.
- Responsive Zen mode and better touch editing.
- Simpler writing and navigation on phones.
- Model-free suggestions across notes and views, with an off switch.
- A rebuilt graph: camera with fit, pan and zoom, folding branches, neighbourhoods, size by references, a time view and new layouts.
- Hide an item's children from your workspace tree.
- Improved finance and habit workflows, and clearer daily note errors.
- A Markdown editing mode for notes, with a dialog listing anything Markdown cannot hold, a warning when someone else edits, one-step undo and a `[[` link picker.
- The New menu groups every item type under headings, including a Chart recipe.
- Personal workspace groups and pins in the workspace menu, managed under Settings > Workspace.
- Graph labels stay readable at every zoom and no longer collide.

## The companion pet

- Design and building now happen in the one chat, without a separate Design mode.
- Block-level note edits, with the changed block shown before and after on the approval card.
- The pet can read your calendar, complete tasks, and inspect and refine views.
- Apply without asking, for one conversation at a time.
- Claude and OpenRouter join the existing providers, each person using their own key. Models that cannot use tools are labelled.
- Chat threads: name, search, resume and reopen past conversations, including as a tab beside your note.
- Chat reads the open note, searches before answering and cites sources. Attach several notes to one message.
- Regenerate or edit the last turn. Code in replies is highlighted and can be copied.
- "Apply changes without asking" can be set per pet, including in note chats.

## nixctl

- Browser-approved, renewable sign-in for `nixctl`, so you no longer need to paste a token on your own machine.

## Accounts

- Verified email addresses and pending workspace invitations are refreshed when you sign in.

## Self-hosting

- Fewer services to run: search now runs inside PostgreSQL, so the separate search index and its worker are gone, as is the central logging stack.
- CI rebuilds only the images whose sources changed, and retags the rest.

## MCP

- A remote MCP endpoint over Streamable HTTP, with note and item tools and a Settings > MCP tab for tokens. Setup guides cover Claude Code, Codex and other clients.

## Settings

- Tabs are regrouped and device-only settings are marked. Interface settings now sync across your devices.
- A "Keep notes on this device" toggle and a Publishing toggle for sites.
- Operators see nightly backup status in Settings.

## Fixes and security

- Items under a closed lock no longer appear in trash or plugin metadata, and collaboration recovers from a lost lock session.
- Google Calendar all-day events sync correctly and no longer push twice.
- Sites keep serving when one stored page fails.
- One account's settings no longer show up for another on a shared browser.
- Workspace arrangement, provider keys and MCP tokens can be changed only interactively, not with a personal access token. Provider keys are stored protected and never shown again.

## Properties

- date: 2026-10-11
- tags: offline; sites; views; charts; formulas; calendar; pets; cli; deploy
- title: October 2026



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

