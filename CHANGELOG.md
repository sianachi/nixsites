# Changelog

All notable changes to Nix are recorded here. The format follows Keep a Changelog and the project
follows semantic versioning (`0.x` pre-1.0).

## Unreleased

### Added

- Homebase, the screen a workspace opens to when no note is open: a greeting with today's date
  and week, one-press New note, Structured note, Today's note, Calendar, Templates and Import beside the
  notes you opened last on this browser. It replaces Notes as the first entry in the side rail.
- Owners can close a workspace to new members in its settings. While it is closed, nobody can be
  invited and pending invitations cannot be accepted.
- Live collaboration can be switched off for a workspace (owners) or for one file (anyone who can
  edit it, from the item menu). With it off, one person edits at a time. Everyone else reads
  until that person leaves, and the next one can then edit.
- An invitation arrives as a notification in the inbox, and opening it shows the workspace's
  Accept and Decline.
- `nixctl ws sharing` and `nixctl item protect --collaboration`, and the MCP tool
  `set_workspace_sharing`.

### Changed

- The note tree is now called the Explorer, so "workspace" only means a workspace you belong to.
- **Breaking:** an invitation grants nothing until it is accepted. Invitees no longer get
  provisional access, and signing in no longer accepts a pending invitation. Updating removes the
  provisional access existing pending invitations gave.
- People editing a document appear as small, quiet profiles: their initials in a circle outlined
  in their cursor colour, with their name on hover. A profile disappears as soon as that
  person's tab is hidden or closed.
- The Explorer has a New note button, which makes an untitled note in one press, and a New view
  menu for every other kind of item.
- The companion pet stands on the page without a card behind it.
- Workspace settings take far less room: the name is renamed in place, Leave and Archive sit in
  a menu beside it, the three switches are one Options group, members and pending invitations
  are one People list with a single invite row, and save messages are toasts. New workspace and
  Arrange workspaces moved to the workspace switcher.
- Pets settings are compact: saved pets are avatar tiles, the identity fields share a row, the
  model shows as a status line once connected, instructions fold away, behaviour and device
  settings are one group, and Save appears only when something changed.
- The optional landing page follows the new design: a hero gallery with a screenshot of every view
  (note, board, list, calendar, timeline, spreadsheet, gallery, checklist, matrix, outline, chart,
  form, habit tracker and companion), a light and dark theme switch, and sections on views, the
  companion and owning your data.
- The optional `/demo` now runs the full Nix interface over a sample workspace held in the
  browser: the sidebar, notes, every view, structured items, My Day and the calendar. Nothing is
  sent to the server and a reload starts over; finances need a real server.

### Removed

- My Day. Homebase is where a day starts now: the My Day page, its rail entry, its Homebase
  tile, `GET /api/v1/workspaces/{workspaceId}/my-day` and `nixctl my-day` are gone. Tasks and
  habits are unchanged and still show in their own views and the calendar.
- The "Show status footer" setting, which no longer controlled anything. Settings > General only
  appears when sites are available, since publishing is all it holds.
- Offline notes. The installed app no longer downloads your notes, the "Keep notes on this
  device" setting, Notes on this device page and Sync notes menu items are gone, and an
  installed app without a connection shows the reconnect screen. Signing out deletes notes an
  earlier version downloaded. Notes created offline that never synced are not published; open
  Notes on this device in the current release and sync before updating to keep them.

## 0.4.0 - 2026-10-23

### Added

**Note bodies over the API**

- A note body can be read, replaced, or appended as Markdown at
  `GET`, `PUT`, and `POST /api/v1/items/{itemId}/body`. Exchange a personal access token at
  `POST /public/v1/auth/token` and send the returned session as a bearer token. Reading needs
  the read scope and writing needs the write scope. The write is a Yjs update, so an editor
  that already has the note open sees it. Appending adds blocks and leaves the existing rich
  text in place. A canvas or a spreadsheet is refused.

**Site style choices**

- A site can pick its typeface (rounded Nunito Sans, book serif Literata, or Atkinson
  Hyperlegible Next), the mark before headings and cards (square, diamond or none) and its
  spacing (compact, comfortable or airy), in the site settings form or with
  `nixctl site update --typeface --heading-mark --spacing`. Every font is self-hosted.
- Published sites have a Copy button on every code block, and a section's `#` link copies the
  link to that section. On touch screens the section links always show. In search, the arrow
  keys move through the results and Enter opens the first one.
- On phones, docs pages fold "On this page" above the text, and the site navigation sits on one
  scrolling row under the site name. Every page footer has "Back to top".
- List views on published sites show each page's first properties, such as its status, beside
  its title.
- Published charts label every column when there are six or fewer, cut long labels to fit, set
  larger text on phones, and draw a single series in the site's accent.
- A blog home page no longer repeats under "Pages" what the top navigation already links, and no
  longer captions a collection "N pages".

**Landing page and demo**

- An optional landing page for signed-out visitors at `/`, and an optional `/demo` that lets
  anyone try the board, list, calendar, timeline, spreadsheet, gallery, checklist and matrix
  views on sample data kept in the browser, with no account and no server calls. Both are off by
  default; on Kubernetes set `NIX_WEB_LANDING=true` and `NIX_WEB_DEMO=true` before
  `deploy/k8s/deploy.sh`.

### Changed

- Links on published sites take the site's accent colour, adjusted until it reads at 4.5:1 on
  both themes. Dates, tags and other metadata use the site's own typeface when it is the serif
  or Atkinson.
- A Kubernetes install can turn remote MCP off with `NIX_MCP_ENABLED=false` on
  `deploy/k8s/deploy.sh`. The `/mcp` route and its service are removed, and Settings no longer
  shows an MCP endpoint. It stays on by default.
- The backend runs on the .NET 10.0.13 servicing release (ASP.NET Core, Entity Framework Core and
  JWT bearer authentication), and the Go workers take minor updates to their PDF, image and
  RabbitMQ libraries.

### Fixed

- A Compose release now pulls and restarts the remote MCP service when the `mcp` profile is on.
  Before, turning the profile on never started it.
- The one-line install lists Docker with the Compose plugin, `curl`, `openssl`, `jq` and about
  8 GB of memory for Docker before the command. `deploy/install.sh` stops if one of those tools
  is missing, and warns when Docker has less than about 8 GB.

## 0.3.1 - 2026-10-21

### Added

**One-line install**

- `deploy/install.sh` installs or upgrades Nix on one machine from a single command: it generates
  every secret, bundles the identity provider behind Caddy with automatic HTTPS, migrates the
  database and prints the administrator sign-in. Re-running upgrades. With no argument it is
  a try-out at `http://nix.localhost` needing only Docker; `--kubernetes` installs into the
  current `kubectl` context.
- Pushing a `vX.Y.Z` tag names that commit's images `vX.Y.Z` and `latest`, which the installer
  uses by default.

**Interactive replies and artifacts (OpenUI, ADR-0066)**

- The pet and chat notes can answer with live components: calculators, quizzes, converters,
  forms, tables, charts and lists of your items, built from generic pieces (state, inputs,
  buttons, expressions, date functions and validated forms). Lists of your items stay live and
  respect permissions and locks.
- Save any component as an artifact: a new item kind that opens in a pane, embeds in notes and
  keeps its values for everyone who opens it. Edit its source like a note, or ask the pet to
  change it, with a before and after preview.
- Components can change your workspace (add entries, tick off tasks, write notes) through an
  approval card. "Apply without asking" in the pet panel covers them under the usual rules.
- Approval cards show a summary of what changes, and simple requests (titles, note text,
  property values, task completion) can be edited before you approve; the pet is told what you
  changed.
- Ask the pet to adjust a component it just made, and it changes only what you asked.
- The pet can add a custom view to a collection and change its program; the approval card shows
  the whole program before and after.
- Published sites show a notice in place of an interactive component.

**Pet attachments**

- The pet reads files you attach or link in a note: text, Markdown, CSV and JSON as text, PDFs
  by their text (a scanned PDF by a picture of its first page), and images as pictures it can see.

**Vim mode**

- Text objects (`iw`, `aw`, quotes, brackets, `ip`, `ap`) with `d`, `c`, `y` and in Visual mode.
- `.` repeats the last change, including the text typed in its Insert.
- `f`, `t`, `F`, `T` with `;` and `,`; `{` and `}`; `r`, `~`, `J`, `s`, `S`, `Y`, and `>>`/`<<`
  to indent list items.
- Search with `/` and `?`, then `n` and `N`, typed in the status line.
- Marks (`m`, `` ` ``, `'`), named registers and the `"+` clipboard register, macros (`q`, `@`),
  and `:` commands for line numbers and `:s` substitution.

**Emacs mode**

- Incremental search with Ctrl+S and Ctrl+R, query replace with Alt+%, and goto-line with Alt+G G,
  typed in a status line under the note.
- Numeric arguments (Ctrl+U, Alt+digits) and Ctrl+X Z to repeat the last command.
- Word case (Alt+U/L/C, Ctrl+X Ctrl+U/L), transposing (Ctrl+T, Alt+T), Alt+Backspace, Alt+Z,
  Alt+\ and Alt+Space, Ctrl+O, Alt+^, Alt+M, and paragraph motion with Alt+{ and Alt+}.
- A mark ring (Ctrl+U Ctrl+Space), Ctrl+X Ctrl+X and Ctrl+X H; registers for text and places
  (Ctrl+X R S/I/Space/J); and keyboard macros (Ctrl+X ( ) E, F3 and F4).
- Vim's `{` now stops on an empty block straight before the cursor.

### Fixed

**Multi-line values in views**

- Copying spreadsheet or sheet cells that hold line breaks, tabs or quotes no longer spills into the
  rows below on paste: such values are quoted, as Excel and Google Sheets do.
- A one-line text property that holds line breaks (from the API, an import or the pet) is edited
  as several lines, so the first edit no longer joins them.
- Spreadsheet cells edit long text in a box that grows, with Alt+Enter or Shift+Enter for a new
  line, and show the first line with "…" and the whole text on hover.
- Long text in a list or calendar cell rests as one clean line; matrix, checklist and query rows
  keep line breaks and stop at two or three lines.
- Board and gallery cards no longer read each value twice to a screen reader.

## 0.3.0 - 2026-10-16

Work recorded on 2026-10-15 and 2026-10-16. The `v0.3` branch is merged into `main`.

### Added

**Note/view conversion and document exports**

- The workspace pet offers "Turn this note into sensible Nix views" and "Write a note from
  these views". Conversion preserves the original note, entries and views, uses the existing
  approval previews, and reports sampling or access limits.
- PDF, Word and Markdown exports include readable static representations of every view kind,
  with accessible source records, field definitions and form content. Incomplete source
  snapshots are labelled. Interactive queries, calculations and controls are not reproduced.
- Spreadsheet exports retain cell contents and formulas as text. Canvas exports include a
  labelled inventory of text, geometry and connections. Attachments link to their original
  Nix items. Unfamiliar body kinds retain readable stored fields.
- Markdown keeps readable children of unfamiliar editor blocks, with a presentation warning
  and a bounded nesting limit. Exported source content escapes active HTML, and document
  exports preserve the exact decimal text of numeric properties.
- Provider tool calls can supply object arguments as native JSON or JSON-encoded text; both
  encodings pass through the same operation, size, depth and permission checks.

**Dynamic fields**

- Fields can suggest values from previous entries in the same field, supporting growing lists
  such as "Who offended you" in a grudge list.
- Select and multi-select choices can come from other notes and fields. Field-source settings
  are supported by the editor, templates, API and companion tools.
- The AI companion can change a field's property type.

**Workspace groups**

- A groups hub at `/workspaces/groups` and a page for each group at
  `/workspaces/groups/:groupId`, with Overview, Chats and Manage tabs.
- Create, rename, order and remove personal groups, and assign accessible workspaces. Groups
  organise navigation and analysis without granting access to their contents.
- Group pages show their workspaces and saved chats, with prompts such as "Compare priorities"
  and "Summarize recent work". Analysis starts when requested; there is no automatic briefing.
- New-chat setup shows the pet, selected source workspaces and destination workspace or parent
  note. The last destination is remembered per group and checked before reuse.
- Groups retain references to saved chat notes, filtering references the reader cannot access.
  Removing a group leaves its chats and workspaces intact.

**Chat notes and cross-workspace analysis**

- New > Chat and a Chat view for live conversations. A conversation is an ordinary parent note
  with ordered message children; its document body and other views remain usable.
- Saved messages, source links, paginated history, streaming replies, errors, cancellation and
  a composer use the pet conversation interface. Existing content needs compatible message
  fields before a Chat view can be added.
- Core stores conversation configuration, messages and turn state. Completed messages survive
  refreshes and service restarts; provider sessions are private and replaceable.
- One active turn per conversation, interrupted-turn status and stable request identifiers
  prevent concurrent replies and duplicate messages on retry.
- Readers can read saved transcripts. Editors send using their own connected provider account;
  provider credentials and provider thread identifiers remain private.
- Conversations keep an explicit source-workspace selection. Later group membership changes
  do not expand it; changing sources is recorded and affects future turns.
- Source access is checked by Core on every turn and tool request. Analysis tools are
  read-only. An unavailable source pauses sending until an editor removes or replaces it.
- Retrieved evidence carries workspace and item attribution. Replies report unavailable or
  incomplete sources, and existing locked-content restrictions remain enforced.
- Save as chat note previews the retained private transcript, destination, source scope and
  sharing implications, then copies it into a live note. The original private history remains;
  trimmed messages and hidden provider context are not imported.
- Save insight as note previews editable assistant content and a destination before creating
  an ordinary note. Saving cross-workspace content to a shared destination requires explicit
  sharing confirmation.
- Long replies are stored in bounded message children and displayed as one logical message.

**APIs, archives and tooling**

- Conversation APIs and `nixctl`/MCP commands support creation, transcript import, inspection,
  paginated history, source changes, sending, watching and cancellation.
- The `chat` view kind is supported by Core validation, generated OpenAPI/client contracts,
  structure tools, view creation, rendering and archives.
- Native archive export/import preserves chat content and portable configuration, excluding
  active turns and private provider runtime state. Static HTML and SVG exports show transcripts
  without a composer.
- Proposed ADR-0062 records Core-owned chat history and the boundary between durable messages
  and private provider sessions. Existing architecture decision statuses are preserved.

**Sites**

- Attached MP4 and WebM videos play in a `<video controls>` player where a file block stands, with
  the download link and size beneath it. Videos are at most 50 MB, are checked by their file
  signature, and are published as stored, so metadata such as location is not stripped. The file
  server answers single-range requests so players can seek, and the site policy allows media from
  its own origin. Migration `SiteVideoFiles` widens the build-file size check.
- Approving first publishes is available in Settings (a **Site approvals** tab for approvers) with
  confirmation dialogs and an optional rejection note, as well as through `nixctl`.
- An **Administrators** tab manages tenant administrators (`GET /api/v1/tenant/roles`,
  `PUT`/`DELETE /api/v1/tenant/admins/{principalId}`; the last administrator cannot be removed)
  and site approvers (`GET`/`PUT`/`DELETE /api/v1/sites/operators`). Approvers named in
  `Nix:Sites:Operators` stay read-only; granted approvers live in the new `site_operator` table
  and cannot read instance-wide backup status. `GET /api/v1/me` gains `features.siteApprover`.
  Write routes need an admin-scope token. Grants and revocations are audited.
- A publish reports dated posts it withheld as scheduled, undated or invalid-dated.

**My Day, canvas CLI and habits**

- `GET /api/v1/workspaces/{id}/my-day`, `nixctl my-day` and a My Day workspace page show the
  caller's due, overdue and assigned tasks and the habits scheduled today, with explicit coverage
  when a limit or an unreadable item narrows the answer.
- `nixctl canvas` commands read and write canvases with guarded payload checks.
- Outline, timeline and calendar views use the shared item selection, and habit trackers gain the
  shared item actions.

### Changed

- Workspace-menu groups are collapsible, and the desktop search bar is wider.
- Graph labels appear on hover.
- Older workspace-scoped group URLs redirect to the canonical group page.
- Drive uses shared selection checkboxes, keyboard and range selection, selected-item dragging,
  and the floating bulk-action tray. Download remains available alongside shared Move and
  Delete actions. Alt-click opens the selected item beside the current view.
- Mermaid loads when a diagram first renders, reducing the production app entry bundle from
  1,044,315 to 875,536 gzip bytes in the measured build comparison.

### Fixed

- Sites no longer serve a stored file the live build does not list: assets live in one per-site
  store, so a file removed from the site stayed public until its old build was purged. Downloads
  and images now answer 404 once a publish drops them. Images already cached by a browser or CDN
  (a one-year lifetime) are not recalled; see issue 166.
- The worker encodes file item ids in its Core request path.
- Site builds containing a video no longer fail at upload (the storage key builder rejected MP4
  and WebM).
- Views keep focus and native selection gestures, reveal selection controls on hover, and keep
  habit selection beside titles. Deleting a selection that extends beyond the loaded sidebar page
  works.
- CI: the changed-path test used a file path in the wrong case (hidden on macOS), the video
  styles used a raw colour the design-token guard rejects, and the video range code had lint
  errors.
- [#46](https://github.com/sianachi/Nix/issues/46): changed-path validation checks formatting of
  changed TypeScript files, including paths with spaces, and skips deleted files.
- [#50](https://github.com/sianachi/Nix/issues/50): cancelling a broker publish clears its
  publisher and pending confirmations so the next publish cannot consume a stale acknowledgement.
- [#92](https://github.com/sianachi/Nix/issues/92): archive ZIP timestamps are reproducible across
  time zones, including daylight-saving gaps. Template catalog archives were regenerated with
  unchanged uncompressed content.
- [#51](https://github.com/sianachi/Nix/issues/51): ordinary code blocks no longer load Mermaid;
  diagram rendering retains its serial queue, security settings and theme handling.
- [#156](https://github.com/sianachi/Nix/issues/156): Drive selection and bulk actions follow the
  shared view behaviour, including visible checkboxes on hover or keyboard focus.

### Security

- The video, site-serving and approver/administrator changes were reviewed. No exploitable issue
  was found. Design follow-ups are tracked as issues 162 to 167: approvers can grant approver
  rights, grants made before operators are configured persist, the last-administrator guard counts
  administrators who cannot act and is not race-proof, withdrawn images can remain in caches, and
  two migrations were hand-written without a snapshot check.

### Validation and current limits

- Feature validation included backend unit tests, real PostgreSQL permission and integration
  tests, CLI and collaboration tests, package checks, and browser accessibility stories.
- Live local checks exercised cross-workspace analysis with citations, reopening saved chats,
  restart persistence, retry deduplication, cancellation, frozen source scope, insight saving
  and native archive round trips through supported tooling.
- The final issue-batch checks passed 4,106 frontend tests, 21 Chromium/accessibility stories,
  127 export tests, three template-catalog tests, Go checks and the production frontend build.
  Archive generation also produced identical bytes on macOS and ARM64 Linux.
- Existing private pet conversations remain compatible and are copied only on request.
- Worker interruption or trashing an ancestor can take up to the four-minute turn lease to
  mark a reply interrupted. Conversation watch currently polls fresh snapshots.
- SVG exports show up to 60 logical messages with a truncation indicator; HTML exports retain
  the full eligible transcript. Provider context uses a bounded recent history while saved
  conversation history remains durable.
- The video, approver and administrator work was verified with targeted backend unit and
  integration tests, API client tests, targeted web tests and lint, typecheck and design guards.
  The full web and backend suites ran only in CI, and the new settings tabs were not checked in a
  browser. The person picker offers only people in the current workspace, and the approvals table
  shows a shortened requester id.
- Two optional Versity object-storage integration tests were skipped. Broker cancellation was
  tested through the publisher interface, without a live RabbitMQ cancellation probe. The
  Mermaid measurement compares build sizes, not browser loading speed.

### Commits

- `51015f77`: dynamic field sources, workspace groups and durable chat notes.
- `d3a30248`: TypeScript formatting validation (#46).
- `26bb09f8`: broker confirmation cleanup after cancellation (#50).
- `b57faf8e`: reproducible archive timestamps and catalog generation (#92).
- `b80177aa`: lazy Mermaid loading (#51).
- `d7dc47d8`: shared Drive selection and bulk actions (#156).
- `5b1ca0c1`, `22aba668`: video player for attachments and its storage-key fix.
- `269f8e48`: serve only the assets the live build lists.
- `65578700`, `5c1fe65c`: approver and administrator management, API and Settings.
- `e9e1540f`, `8d7349e6`: My Day read and `nixctl canvas`.
- `895437f2`, `eb4ab14d`, `80ec8a27`: faster backend and frontend CI and the fixes it surfaced.

## 0.2.0 - 2026-10-15

### Added

**Views and items**

- New menu: every structured item type under headings, including a Chart recipe.
- Views: resizable columns in list and spreadsheet views, remembered per device.
- Views: a per-view "Open items" setting (Auto, Full page, Dialog, Beside, New tab, None) with a
  context-aware Auto policy. Graph nodes get their own open control (no Beside).
- Views: multi-select with Shift and checkboxes, one selection gesture model, a floating
  selection tray, bulk move and bulk delete with per-item refusals. Board cards and checklist
  lines draw the same checkbox as lists and galleries.
- Views: Rename, Move to and Delete are offered from every view that supports them; a caption
  says what a drop changes; list rows can be dragged onto each other to reparent them.
- Settings: tabs regrouped, with device-only settings marked; settings components reorganised
  into subfolders.
- Settings: interface settings sync across devices through a per-user store
  (`/api/v1/me` settings endpoints); retired keys stay repairable.
- Settings: "Keep notes on this device" toggle (off hides the sync footer) and a Publishing
  toggle for sites.
- Settings: operators see nightly backup status; the Compose and k3s backup jobs record each
  run in a capability-only table.
- Workspaces: personal groups and pins in the workspace menu, managed under Settings >
  Workspace, with clearer group and pin controls.

**Editor**

- Markdown editing mode over the collaborative note, with a losses dialog, a remote-change
  warning and one-step undo.
- `[[` note-link picker in Markdown mode, sharing the item search.

**Pets and chat**

- Providers: Claude (Anthropic) and OpenRouter, with per-person API keys; models that cannot use
  tools are labelled. A per-pet "Apply changes without asking by default" setting, also offered
  in note chats.
- Named, resumable chat threads: rename, search and continue past conversations; the companion
  conversation opens as a pane tab.
- Chat reads the open note (attached by id when unlocked), searches before answering and cites
  its sources. Several notes can be attached to one message.
- Regenerate the last reply and edit the last message, replacing only that turn.
- Code in replies is highlighted (accessible colours, lazy-loaded) with a copy button; a slash
  menu offers the suggestion actions; the pet shows its thinking pose while it works.
- `nixctl pet` gains rename and resume-history operations; `nixctl chat eval` adds context
  cases and citation scoring for the 6.8 baseline.

**MCP**

- Remote Streamable HTTP endpoint (`nixctl mcp --listen`), note and item tools, and a
  Settings > MCP tab for tokens and setup. Setup is documented for Claude Code, Codex and other
  clients.

**CLI and tooling**

- `nixctl stress run --scenario collab-edit`; a stress peer stops at its first failed edit and
  the run stays local.
- ADR-0063 (Nix Sites) and ADR-0064 (git sync, deferred) are tracked in `docs/adr/`.

### Changed

- Sites require `Nix:Sites:Enabled` in addition to a domain and are off everywhere but the
  designated production deployment; every sites route is refused while off.
- `GET /api/v1/me` carries deployment features (sites, MCP endpoint) as display hints.
- The instance operator check is synchronous.
- The Nix reference archive drops internal handovers, plans and runbooks; docs no longer
  describe speech or OpenSearch as current.

### Fixed

- Locks: items under a closed lock are withheld from trash and plugin metadata reads.
- Collab: recovery from a lost lock session, no refusal resync loop, bounded draft state.
- Sites: the serve process stays up when a stored body fails; redirect paths are encoded;
  preview cards drop XML-forbidden characters.
- Pets: provider failures are classified and truncated replies no longer pass as answers; setup
  and runtime follow the selected provider; threads stay valid; long item titles are clipped.
- Calendar workers: all-day switches sync to Google and duplicate pushes stop.
- Settings: one account's settings no longer leak into another's on a shared browser;
  suggestion settings are split from UI settings.
- Graph: labels keep a readable size at every zoom, name the focused node first, try the other
  side of a node before dropping a colliding label, and no longer skip labels that have room.
- Views: container views are told when an item moves; a view's open mode is validated like the
  backend; announcements for automatic column widths.
- Editor: the Markdown link picker sits in flow.
- Chat: the composer stays a plain textbox; the note list persists; copy failures are reported.
- Backup: a missing local status counts as failed; nightly recording is hardened; "off-site"
  shows as never when it has not run, per-step runs are counted and overdue refreshes on a timer.
- Release CI repaired and remote transports secured.

### Security

- Workspace arrangement, provider keys and MCP token management are interactive-only for
  personal access tokens; provider keys are stored protected and never returned.
- PR #160 (chat threads) was merged without a security review; one is owed before release.
