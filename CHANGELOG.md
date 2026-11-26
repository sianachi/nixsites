# Changelog

All notable changes to Nix are recorded here. The format follows Keep a Changelog and the project
follows semantic versioning (`0.x` pre-1.0).

## Unreleased

### Added

- **Pet usage and a monthly spending limit.** Every finished pet turn (chat, note chat, inline
  writing, plans, task runs and routines) is recorded with its tokens, model, source and an
  estimated cost: a price table for the Claude models (a model not in it is charged at the dearest
  rate, so spend is never under-counted), and OpenRouter's own price when it reports one. The
  companion reports a turn with a ticket Core signed when it started it, which names the person,
  pet and source, so a report cannot be filed for someone else.
  Rows are private to the person who spent them and kept 13 months. Settings > Pets shows this
  month's total against the limit with a breakdown by model, source and pet, and a day-by-day list.
  `GET /api/v1/me/pets/usage` (Read scope; `month=yyyy-MM` for an earlier month) returns the same
  totals and the budget, so outside agents can see it.
- One optional monthly limit in USD per person, over all pets and sources, resetting on the 1st in
  the person's time zone (Settings > Pets). At 80% one notification arrives per month. At the limit
  new pet turns are refused with `pets.budget_exhausted` ("This month's pet budget is used up.
  Raise it in Settings > Pets."); a turn already running finishes. Each turn carries one line with
  the amount used and left, after the cached prompt, and the pet is told to keep work lean when
  little is left; it never changes model by itself.
  A task run, routine or plan stopped by the limit now says so (`pets.budget_exhausted`, same
  message) instead of "The pet could not continue this job". An OpenRouter turn cut off before its
  price arrived is counted from an estimate rather than as free.
- **Faster-feeling pet chat.** A message you send shows at once with the working line, before the
  server answers. When the model reports reasoning (Claude thinking summaries, OpenRouter reasoning),
  one muted line in the chat shows it until the reply text or a tool card replaces it; it is never
  saved, kept in the conversation or sent back to the model. Independent read-only tool calls in one
  round now run together (writes and `remember` stay in order, and results reach the model in its
  order). The turn log gains `first_visible_ms`, the first reasoning, tool or text.
- `nixctl health --check-session` checks anonymous browser-session availability in addition to
  process liveness. It fails when the session endpoint fails, reports no session data, and leaves
  the default health output unchanged.
- The pet message box says whether a message will start a job or go to chat before you send it,
  with a button to switch.
- **Install without Docker.** `deploy/bare/install.sh` installs or upgrades Nix on one Ubuntu 24.04 machine as systemd services, from the plain files on a release: Postgres, the object store, Caddy, Core and the Node service. The remote MCP server and sites are not part of it. See "Without Docker" in `docs/install.md`.
- `Nix:Sync:DeviceItemIds` (off by default). With it on, an item created offline keeps the
  identifier its device chose when the change reaches Core, so installs that exchange changes
  without a shared server agree on what each item is called. A create whose identifier is already
  in use is refused (`items.id_taken`). Only version 7 identifiers are kept; any other still gets
  one Core mints. It lets a writer learn whether an identifier is in use
  anywhere on the install, so turn it on only where everyone with write access is trusted with that.
- Each GitHub release carries the build as plain files, for running Nix without containers: the
  web app (`nix-web-<tag>.tar.gz`), Core and the migrator as self-contained programs for Linux
  (x64, arm64), macOS (arm64) and Windows (x64) (`nix-core-<tag>-<platform>.tar.gz`), the
  collaboration, companion and sites services (`nix-node-<tag>.tar.gz`), and the `@nix/sync-core`
  and `@nix/api-client` packages as npm tarballs. `scripts/release-artifacts.sh` builds the same
  files locally.
- Item protection, a container's views and an item's property schema can be edited offline in the
  native apps. Each change is sent with what the device saw before the edit (the protection flags,
  the views version, the schema), and Core refuses it, listing it among the changes that could not be
  applied, when someone changed that meanwhile, so a late offline edit never undoes another person's.
  A further views edit on the same item waits for the first to sync. Pet turns cannot change protection
  this way. Core's sync snapshot gains `viewsVersion` for this.
- Habit check-ins, undoing a check-in, and completing an occurrence of a repeating item can be done
  offline in the native apps. They are kept in the queue and sent when the connection returns, the
  habit and calendar views show them at once, and one Core refuses (a paused habit, a day that is not
  scheduled) appears in the list of changes that could not be applied. Core takes these only as
  those three requests, never an arbitrary one, and applies them as the signed-in person.
- The offline copy in the native apps keeps files up to 100 MB. A larger file stays online-only: it opens
  with a connection, and Settings > About counts how many are left out instead of reporting them as failed.
- The Android app keeps an offline copy of each server, as the iOS app does: notes, views and
  files sync to an on-device database that only that server's pages can read, and it is deleted
  when you sign out, are refused by the server, or remove the server.
- Passkey sign-in works in the Android app. Sign-in opens in a Custom Tab (a private one where the
  browser supports it) and hands a one-time code back to the app, as it does on iOS.
- The Android app asks an open server page to run one sync pass about every 15 minutes while it is on
  a network, as the iOS app does. It does nothing when no server page is open.
- Android release builds sign with a keystore named by the `NIX_ANDROID_KEYSTORE`,
  `NIX_ANDROID_KEYSTORE_PASSWORD`, `NIX_ANDROID_KEY_ALIAS` and `NIX_ANDROID_KEY_PASSWORD`
  environment variables or Gradle properties, and build unsigned without them.
- The iPhone and iPad app syncs in the background. When iOS gives the app time while it is off
  screen and still open, it sends waiting changes and fetches new ones.
- Shared links to the public pages show a preview card. The web app document carries Open Graph and
  Twitter card tags for the title, description, image, URL and site name, using
  `apps/web/public/nix-og.png` (1200 by 630).
- Send a work request in the pet conversation to start a job. Enabled workspaces can start with
  the current item and review or revise proposals in the conversation. Nix inbox notices link
  to pending decisions and keep job details inside the dialog. Jobs resume after a restart.
- Review a pet's fitted Canvas draft in the canvas area. Apply native shapes, strokes, groups,
  attached arrows, and linked Nix cards, or ask for changes. Undo preserves separate edits.
- Register a remote MCP tool as a scoped pet connection in Settings > Connections, or a peer with
  its own grant. Review each outbound call in the pet dialog.
- Browse public websites or use a saved session for an exact site. Review the destination and
  fields before a pet submits a supported form. Open the reviewed page from the pet dialog when a
  form needs you to finish it yourself.
- Withhold an item from pet access in its protection settings. A pet run checks the setting
  before sending selected sources to the model or handing them to another agent.
- Schedule a named pet routine from the pet dialog. Its owner can allow one exact, reversible task
  rename to apply automatically. Other proposed changes still ask for review.
- OAuth sign-in for remote MCP: hosted clients such as ChatGPT and claude.ai connect through discovery, dynamic
  client registration and an authorization-code flow with PKCE; the token they receive is an ordinary personal
  access token that expires after 90 days.
- Ten animated companion appearances in the pet gallery: Origami Crane, Jumping Spider, Lantern
  Spirit, Hermit Crab, Kirin Fawn, Gecko, Pocket Whale, Crystal Golem, Fruit Bat and Dust Bunny.
  Each supports all companion states and reduced motion.

- Nix can sign people in itself, so a self-host no longer needs a separate identity provider. The
  first account is created on the setup page with a setup code, and an administrator adds people
  from a new People page: it lists accounts, adds a person (they get a one-time link, valid for an
  hour, to choose a password or register a passkey), issues a reset link and disables or re-enables
  someone. Issuing a reset link asks for the administrator's own password, and nobody can issue one
  for themselves. Sign-in is by email and password, with an authenticator-app code as a second step, or by
  passkey alone. Ten wrong passwords in five minutes pause that account for five minutes.
- Settings > Security for everyone: change or remove your password (removal needs a passkey), add,
  rename and remove passkeys, add or remove an authenticator app, and sign out everywhere.
- `install.sh --migrate-local-auth` moves an install off the bundled Zitadel onto Nix's own sign-in,
  keeping accounts, password hashes, authenticator apps and passkeys, with `--dry-run` to see what
  would move first. The old Zitadel containers are stopped, not removed, and their volumes are kept
  until you delete them.
- `deploy/compose/import-zitadel.sh` does the same for a Compose install whose Zitadel runs as its own
  project, with `--dry-run`, and the web service now passes `/.well-known/webauthn` to Core.
- `deploy/k8s/deploy.sh` can move a Kubernetes install off the old Zitadel with
  `NIX_IMPORT_ZITADEL=dry-run` and then `run`, and managed template sync accepts a Core access token
  instead of a Zitadel machine key, so it works in local mode.
- Host commands for the locked-out administrator and for scripts: `account reset-link`,
  `account service-token` and `account import-zitadel`.
- The landing page has a 45-second video tour between the view gallery and the views section: the
  desktop and the phone video side by side on a desktop or tablet, the phone video alone on a phone.
  Neither downloads or plays until you press Play.

- The phone and desktop apps show how many offline changes are still waiting to sync, say in plain
  words why a change was not applied, and Settings > About shows when the offline copy last synced
  with a Sync now button.
- A pet has a chat model of its own (Settings > Pets > Chat model; empty uses the provider's
  default), and "Think harder" in the message box's menu sends one message on the larger model.
  For Claude the default chat model is the fast Haiku 5.5, and plans, task runs and "Think harder"
  use Sonnet 5.5; with OpenRouter you pick the model. `PetProfile` gains `model`, and a send gains
  `thinkHarder`.

### Changed

- A Compose release whose release check is not signed in prints a link to approve in a browser,
  in place of asking for an access token. A stored token still works.
- The installers print a setup link for the first account. Opening it does not ask for the setup
  code; the plain setup page still does.
- Companion workspace context defaults to on for a new pet and workspace. An explicit off choice
  stays off; Core access checks and provider-sharing decisions still apply.
- **Breaking:** Sharing Nix content with a companion now requires consent for the selected
  provider and sources. Open the companion and confirm the sharing question again after upgrading;
  the old device preference no longer grants access. Scripts using pet runtime or inline API
  endpoints must complete this browser sharing step before sending source content.
- Enabled companion workspaces review a whole prepared plan in labelled forms. Continue approves
  its exact steps once; changed values or scope require a fresh review. Progress and receipts show
  what applied, what stopped, and what needs checking. App-only steps wait for an open client.
- Companion chats use the current workspace as their starting context, with visible controls for
  selected sources. Read-only chats retain that limit when a conversation becomes a job.
- Website sessions use labelled cookie fields with concealed values and local Undo. Failed
  connection requests keep the entered details for correction and retry.
- Pet job and property previews show nested values in labelled review fields, with clear empty
  states and access to complete text values.
- Pet job statuses are shown as tags, with the ones that need you outlined in the accent colour. A job whose outcome is unknown reads "Check the outcome".
- While a pet job takes your answer, approval, decline or feedback, the button you pressed says so ("Sending answer…", "Working…").
- A message too long to start a pet job says how many characters over the limit it is.
- A pet job that fails while applying a change names the action that failed and where it was aimed.
- An approval for a registered tool call names the tool, the server and each input instead of showing raw JSON.
- Pet job statuses use the same words in the job list, the job card, the peer work list and the pet activity page
  ("Needs an answer", "Needs review", "Waiting for the other agent", "Needs attention").
- The Trash page and the workspace list's storage totals load faster in large workspaces. Upgrading
  adds two database indexes, built without blocking writes.
- Filtering attachments by review state is faster in workspaces with many files. Upgrading adds one
  database index, built without blocking writes.
- Offline sync in the apps checks for permission changes from an index instead of reading every
  recent change. Upgrading adds one database index, built without blocking writes.
- After a long quiet period, clearing old offline-sync records no longer blocks edits to that
  workspace: they are cleared in small batches over the next saves.
- The web app's first load is about 30% smaller: Settings, Trash, Attachments, the template screens,
  the creation studio, pet activity, the import dialog, the companion conversation and the less common
  view kinds (calendar, timeline, sheet, chart and others) load the first time they are opened.
- When a session ends on its own in the iOS or desktop app, changes that were not sent yet are no
  longer deleted. The offline copy stays on the device, closed, and the changes are sent when the
  same account signs in again. Signing out, signing in with another account, or the account being
  closed still removes it.
- The iOS and Android apps use the Nix icon and launch screen.
- A note opened from a board opens on its conversation, and notes under an item with a board view
  have comments on unless someone has switched them off. Existing board cards are switched on once
  when upgrading. A card with comments off offers a "Turn on comments" button in its Comments tab.
- The explorer shows progress while a dropped folder is read and while its files upload. Uploads
  start as files are found, not after the whole folder has been read.
- Attachments bulk actions and undo send a bounded number of requests at a time, and a slow answer
  for an earlier filter no longer replaces the current list.
- Saving an item as a template with its examples captures from the preview without reading
  every child first, so large trees save faster.
- The note footer, status bar and outline share one scan of the note per edit.
- Opening a deep link in the explorer loads the ancestor levels up to four at a time.
- Revisiting an EPUB chapter, or reusing its images and stylesheets, no longer rescans the book.
- Pet chat no longer reparses earlier replies for generated UI on every streaming update.
- The graph and template studio screens load on first visit, which shrinks the initial download.
- Site builds hash an unchanged published download once, and read each page's export bundle as
  a stream, which lowers peak memory on large sites.
- Companion history listing reads archives asynchronously, so a large history no longer blocks
  the Node host.
- The Node host stops every started role within 10 seconds after a partial startup or a failed
  stop, and serves role-aware `/readyz` and `/healthz` on port 8099 (`NIX_NODE_HOST_PORT`). The
  Kubernetes readiness probe uses it.
- The landing page's macOS, Windows and Linux buttons read "Early build, from source". iOS and
  Android still read "Coming soon".
- New installs no longer include Zitadel and need one hostname instead of two. `NIX_AUTH_MODE`
  (`local` or `oidc`) picks the mode; when unset it is `oidc` if an issuer is configured. An
  install in `local` mode refuses tokens from an outside identity provider.
- The development stack signs in with Nix's own sign-in and no longer starts Zitadel.
  `scripts/dev-stack-up.sh` seeds `dev@nix.localhost` with a development-only password, and people
  already in a development database keep their data.
- **Breaking:** the bundled Zitadel is gone. The installer and `deploy/k8s` no longer start,
  configure or upgrade it. An install that still uses it must migrate when it upgrades: the Docker
  installer stops until you run `--migrate-local-auth` (try `--dry-run` first), and `deploy.sh`
  refuses while the old `nix-zitadel` Deployment runs until you deploy with `NIX_AUTH_MODE=local`
  and `NIX_IMPORT_ZITADEL=run`. `NIX_AUTH_MODE=oidc` now needs a provider you run yourself, and on
  Kubernetes both `OIDC_ISSUER` and `OIDC_CLIENT_ID`. The old Zitadel objects, volumes and data are
  left for you to delete; docs/install.md has the commands.
- The self-host images take about 4 GB less disk space in total: Core went from 1.6 GB to
  0.5 GB, the Node services image from 1.9 GB to 0.9 GB, the sites image from 1.5 GB to 0.4 GB
  and the release tools image from 1.6 GB to 0.6 GB. The migration job image shrinks the same
  way as Core. They no longer carry development tools or the native libraries of other
  platforms.
- The one-line install asks for at least 1 GB of memory for Docker instead of 8 GB, and warns below
  0.75 GiB instead of 7 GiB. The running stack was measured at about 0.6 GB with one person using
  it; the README advises more by the number of active people.

- Core uses about 85 MiB less memory when nobody is searching or editing notes: the embedding model
  behind passage search loads on first use and is released after ten idle minutes, where it loaded
  at every start, and Core hands the memory it used back to the system when it lets the model go.
  A fresh one-machine install idles at about 300 MiB where it used about 390 MiB (Core about 55 MiB
  where it held about 125 MiB); ten minutes after light use Core holds about 170 MiB where it kept
  about 270 MiB.
- The MCP service idles at about 51 MiB where it held about 84 MiB: `nixctl mcp --listen` starts
  without loading the rest of the CLI, and loads the tools with the first request.

### Removed

- **Breaking:** pets no longer run on a linked ChatGPT account or an OpenAI API key; `anthropic`
  and `openrouter` remain, and a new pet uses `anthropic`. The Codex app-server and its binary are
  gone from the images, installers and release files, `GET /api/v1/me/pets/connection` and the
  `connect` and `disconnect` pet operations are removed, and the connection response no longer
  carries `verificationUrl` and `userCode`. Migration `RetireChatGptAndOpenAi` moves each pet on ChatGPT, OpenAI or no
  provider to the person's Claude key, else their OpenRouter key, else Claude (the pet then asks
  for a key and does nothing else), deletes stored OpenAI keys, and the companion deletes saved
  ChatGPT sign-ins at start. Add a Claude or OpenRouter key in Settings > Pets after upgrading.
- Eye of Ra and Demiurge are no longer companion appearances. Existing profiles use Owl instead,
  preserving their identity, custom name, instructions and conversation history.

### Fixed

- **Saved chats no longer save the model's reasoning as the reply.** Core now skips the companion's transient reasoning line when it reads the running turn text.
- Companion chat asks for sharing consent on the sources the message really sends. With workspace
  context on and a page open, it asked about the page alone and then refused every message with
  "Review the selected sources and provider before sharing content".
- Ordinary requests and event streams no longer initialize companion plan-dispatch services;
  requests carrying plan credentials still enforce the exact dispatch checks.

- Companion owner-client plan mutations use the standard writes rate limit, and the internal
  sharing validator stays out of the public API contract.

- Solution-wide .NET validation no longer browses frontend dependency trees or Android build
  output through the frontend source-listing project.
- The local web server refuses an occupied configured port instead of silently starting on a
  different port from Core’s browser origin.
- Enabling companion workspace context no longer automatically attaches withheld or password-locked
  pages, including temporarily unlocked pages that Core refuses as conversation sources.
- Companion job options and scheduled routines have consistent inset padding, touch-sized
  disclosure rows, and space around routine empty states.
- OpenAI API-key tool conversations use the Responses API for supported GPT 6 models that require
  it, preserve ordered tool and reasoning history, and discard incompatible replay after a model
  or provider connection changes. Incomplete responses keep a clear recovery path.
- Pet requests include valid recursive tool definitions, preserving every existing operation and
  argument rule.
- API-key conversations use the newly selected model when resuming, including after a restart.
  OpenAI model and request failures show a specific recovery message instead of an account/usage
  message.
- Provider-key settings keep the key field readable on narrow screens, show progress without moving
  the action buttons, and keep pending saves visible until confirmed. Failed settings requests no
  longer claim they were saved.
- Conversation history shows saving, deleting and continuing progress, and restores keyboard focus
  to a remaining control after editing or removing a conversation.
- Drawing approval cards identify which refresh or decline request is waiting for confirmation.
- The companion shows when it is preparing the first message, preserves newer drafts after a send,
  and keeps an explicit chat or job choice when that route becomes unavailable.
- A remark that begins with a work verb, such as "Sort of, yes" or "Plan B sounds better", stays in pet chat and no longer starts a job. A command after a filler word, such as "Thanks, make it shorter", now starts one.
- An upload aimed at a file item that has no version yet becomes its first version. It was refused
  before, which left a file item created without bytes unusable.
- A note edited offline in the native apps no longer replays the same edits when reopened after they have synced: the
  device clears its draft journal entries once the server has them.
- The desktop app signs in when the server adds a parameter to the sign-in callback, as the iOS app
  already did. The callback still has to name the server you signed in on, and carry one code.
- The one-line install works again when the latest release is older than the installer on `main`:
  it stopped at "set NIX_OIDC_ISSUER" on a new machine. A release is now installed by the copy of
  the installer that shipped in it.

- Collaboration restarts refuse reconnects during document draining and give active HTTP requests
  up to the existing 60-second shutdown grace period before closing unfinished connections.
- Failed pet jobs show Core’s safe failure reason for planning, preparing a draft, or applying a
  change, alongside the existing retry action.
- A pet job asks for source consent when it needs unshared note text. It can append text you
  supply without sending the existing note text to the model.
- Pet chat explains how enabled jobs handle browsing and reviewed workspace changes from a
  message in the item dialog.
- Closed, idle pet dialogs release their live connection. When too many conversations are open,
  the pet asks you to close another conversation.
- Saved Canvas drawings fit the initial viewport while preserving zoom and movement after you
  start using the editor.
- Pet web research distinguishes a page's title from the text visible on the page.

- Pet job search shows only sources that are available to the pet. When a source becomes
  unavailable after selection, the dialog explains the refusal and lets you choose again.

- A pet job pauses when a note has Comments turned off. Enable Comments in the note's settings,
  then reply to continue the job with its earlier edits still recorded.
- Pet jobs follow your draft revisions through later steps, including after the revised edit is applied.
- Pet chat can send again after a worker restart leaves its provider thread unavailable. Your
  visible messages stay in the conversation.
- Pet chat answers general questions without probing the open item and checks the item type
  before reading its contents. A failed read appears in tool activity.
- Pet drawing previews keep their labels readable in dark mode and leave space around wide
  diagrams.
- Pet sheet reviews show the exact before and after values or formulas. Note reviews show the
  text to add and link to the target note.
- Direct requests to browse a website or set a value start a pet job. Website approvals show
  the destination and whether the visit uses a connected session.

- The phone and desktop apps no longer delete a workspace's offline copy, queued edits included,
  when a proxy or bot check in front of the server answers a sync request with 403 or 404. Only a
  refusal from Nix itself removes the copy.
- Offline sync is faster: a pass no longer rewrites every item it already holds unchanged, and a
  first sync stores each page of items in one step.
- Offline sync waits out a rate limit and tries again instead of failing the workspace, and says so
  when a whole pass fails.
- A queued offline change the server will never accept no longer blocks every change behind it: it
  is listed with the changes that need attention and the rest are sent.
- Returning to the phone app mid-sync no longer shows "could not be synced": an interrupted pass
  is run again. A long queue of offline changes is sent in consecutive passes, not one every five
  minutes.
- Changes made while connected reach the offline copy within about a minute, not at the next
  five-minute pass, so going offline soon afterwards no longer shows the older state.
- Downloaded files are kept when a workspace's sync is cut short, where they were deleted and
  downloaded again.
- Typing in a note offline is queued in bursts, not one entry per keystroke, so long offline
  writing stays responsive and syncs in fewer passes.
- An answer that is not from Nix (a sign-in portal, a proxy page) during a session check no longer
  wipes the offline copy.
- The iOS app no longer closes when you choose to take a photo or video for an upload: it now asks
  for the camera and microphone.
- First-run setup started from the phone or desktop app returns to the app when it finishes.
- A title or property edited several times offline is sent as one change, and a file too large to
  open offline says so and no longer ends the app.
- The Android app is excluded from device backup and transfer, which carried its signed-in session.
- In Settings > Access tokens the Rotate and Revoke buttons no longer run into each other when a
  token has a long name. They read Rotate and Revoke; the token's name stays in the row.

### Security

- The iOS and desktop apps refuse a database function that a server's page could use to read or
  call raw memory addresses in the app.
- The iOS app refuses database settings that switch off its journal. With the journal off, a
  server's page could write its own bytes into the search index's internal storage.
- Updated hono and @hono/node-server in the CLI's MCP dependency tree to patched releases.
- Pet search keeps excerpts from marked or locked notes out of workspace and folder results.
- Pet job briefs and observations are screened for recognizable credentials before they reach
  the planning model.

## 0.7.0 - 2026-11-14

### Added

- Publish any item as a site: Publish as a site is in the item menu and the sidebar row menu for every
  item type, for workspace owners, and the publishing switch in Settings is now on by default.
- Items have their own settings: comments, suggesting, file review states and full width, plus the
  default view, in a new Settings pane of the item panel. Core stores and enforces them, so they
  apply in the web app, `nixctl item settings`, MCP and the mobile apps. Workspace owners set what
  new items start with under Workspace settings > New items.
- The landing page shows every view kind (now including smart lists, the drive, guided forms and
  custom views), in light and dark, with phone screenshots on narrow screens, and has an Apps
  section for the iOS, Android, macOS, Windows and Linux downloads (each shows "Coming soon" until
  it has a link). `pnpm --filter @nix/web capture:landing` retakes the screenshots.
- Access tokens can be rotated. Rotate in Settings > Access tokens (or `nixctl token rotate <id>`) keeps
  the token's name and scopes, shows a new secret once, ends the old secret and its sessions immediately and restarts
  the expiry with the original lifetime. `nixctl` also updates local profiles that used the old
  token. Revoked or expired tokens cannot be rotated, and a token cannot rotate tokens.
- The built-in templates are offered in the template library of every workspace on every install,
  with no setup step. Using one adds it to that workspace first. People who cannot manage a
  workspace's templates do not see them.
- Twelve personal templates in the template library: Habit tracker, Priority matrix, Goals, Trip
  plan, Reading list, People, Daily journal, Document vault, Inbox, Job hunt, Meal plan and Personal
  dashboard. Each opens with sample rows and several views, and its library card previews the
  first one.
- Template files and exports now carry Matrix, Chart, Checklist, Outline, Drive, Habit tracker and
  Custom views, and exported documents draw them instead of falling back to a list.
- Open companion chat in a right-side drawer from the device’s Chat opens setting.
- Drag a document tab to a pane edge, or hover over that tab for its dock and pin controls.
- Drag across calendar days or hours to prepare a new entry. Move entries from the All day row
  into an hour slot when their calendar accepts dates and times.
- Open List, Spreadsheet and Smart list records to edit the view's fields and step through its
  results in place.
- Open calendar entries for an event brief with the schedule, meeting link, prep fields and
  rescheduling.
- Link Timeline prerequisites and preview how a proposed date affects dependent items.
- Review Gallery assets at full size, compare two assets, and save a selection or request changes.
- Review Form submissions by status, assign a reviewer, and turn a response into a follow-up task.
- Hide or show the mobile navigation bar from the top row. The demo notice can also be dismissed.
- Tap Home beside Explorer on phones and portrait tablets to return to the workspace's Homebase.
- Board card dialogs start on Comments, with Document available in the view switcher. Open Comments
  beside a note from its Settings panel on desktop.
- Add views from the view switcher, including on a note with no saved views. Hover or focus a view
  for its options, or use the options beside the phone picker. Hide tabs in this browser, restore
  them from the view menu, or remove a saved view with Undo. Open a hidden Document from Item actions.
- Browse the built-in pets in a gallery with an animated preview when adding a pet or changing its
  appearance.
- Use Add view → Suggest views to ask your connected companion for views based on the note’s fields
  and saved views. Preview a suggestion with your items before adding it. This uses the existing
  inline AI opt-in.
- Use the circled plus in the desktop Explorer or the add control on mobile to name a note or open the
  structured item picker. The picker is also available from a new tab. Pick Chat, Upload or another
  built-in option, or describe what to create and ask your workspace companion. The name entered in
  the new-note dialog carries into structured creation.
- Justify text in notes from More tools (More on phones), under Text alignment.
- Open Preferences in the account menu to preview your layout, sidebar and one of six palettes in
  Light or Dark. Nix follows your device's appearance until you choose a mode. Accounts that have
  not already chosen a layout see Preferences on their first visit after updating.
- Choose which optional sidebar destinations to show in Workspace or Full toolkit. Homebase, Trash,
  and Settings stay visible. Workspace starts with fewer destinations and hides the status bar.

- Added Octopus, Axolotl, Moth, Pangolin, Phoenix Chick and Mushroom Sprite as animated appearances in companion settings.

- Workspace passwords. An owner can close a workspace behind one password in its settings. Until a member enters it, they see only the workspace's name and that it is locked: no items, titles, search, graph, views, files, comments, members, settings, agents, MCP or offline sync. An unlock lasts 15 minutes, belongs to the browser session or access token that entered it, and ends when the owner changes or removes the password or the member locks the workspace again. The same password lets anyone in the organization who signs in and opens the workspace's join link join as a viewer; every failed join answers alike, so links cannot be used to find workspaces. A forgotten password cannot be recovered. New routes: `PUT /api/v1/workspaces/{id}/password`, `POST .../password/remove`, `POST` and `DELETE .../unlock`, `POST .../join`; workspace responses gain `passwordProtected` and `unlockedUntil`, and a closed workspace's response carries only its name and kind. A member's device sync of a closed workspace answers 423 `workspaces.locked`, so an offline copy keeps its unsynced edits instead of being wiped as revoked access. `nixctl ws password|unlock|relock|join` read passwords from stdin; the pet and MCP catalog refuses all of them.

- Pet chat streams. Replies, tool cards and approvals arrive over one open connection instead of repeated polling; the app falls back to polling when a stream cannot open. New routes: `POST /api/v1/me/pets/runtime/stream` and `.../runtime/note/stream`.
- Server-side pet tools, off by default. With `Nix:Pets:ServerTools` (Core) and `NIX_COMPANION_SERVER_TOOLS` (companion) set to `reads`, a pet's read tools run on the server when the owner has "read without asking" on, so a turn no longer waits on the open tab; with `all`, an approved change is applied by the server after the owner approves the same card. The companion then also needs `NIX_COMPANION_COLLAB_URL`. Reading files (PDFs, images) stays in the app.
- The licence texts of the third-party software Nix includes are in `THIRD-PARTY-NOTICES.txt`,
  shipped in every image and the desktop app and served by the web app at
  `/THIRD-PARTY-NOTICES.txt`. Outside contributions now need the contributor licence agreement
  (`CLA.md`), signed once by comment on the pull request.
- Account → Preferences previews and applies three Zen layouts across the workspace and collection views. Essentials simplifies navigation and view controls, Workspace restores planning and insertion tools, and Full toolkit adds the advanced note tools. Nix remembers your applied layout and overrides across devices. Undo restores the previous layout across devices too.

- Tenant administrators can switch MCP and public links on or off in Settings > Administrators, taking effect at once (`GET`/`PUT /api/v1/tenant/settings`, `nixctl tenant settings`). The deployment setting stays the ceiling. Turning public links off stops existing links from serving without revoking them, and turning them back on restores them. With MCP off, the remote MCP endpoint refuses requests for that organisation.
- "Share public link" on a note's menu in the sidebar creates, copies and revokes the note's public link, and lists attachments held back for lack of an approved version.
- File versions now have a state: draft, in review, approved or revoked, with who changed it and when. Approving and revoking need an Editor or Owner; each workspace has a switch, off by default, that lets access tokens do it too. `PUT /api/v1/items/{id}/file/versions/{versionId}/state`, `set_file_version_state`, `nixctl file state`.
- Export a note to a file item: `POST /api/v1/exports` with `toFile`, `export_note_to_file`, `nixctl note export --to-file`. The output is a new draft version that records its source note and exact revision, and that revision is named so history pruning keeps it. PDF, DOCX and Markdown.
- Items can reference other items, and pin an exact approved file version, with `/api/v1/items/{id}/references` and `/referenced-by`, `add_item_reference` and friends, `nixctl ref`. A pinned file, or a folder holding one, cannot be trashed or permanently deleted until it is unpinned, so a record keeps the same bytes after newer versions are uploaded.
- Items can expire: set the built-in `expiry` property, `set_item_expiry` or `nixctl item expire`. Whoever set it is notified 7 days before and at expiry, and the item moves to the trash. Anything protected or pinned leaves a folder and everything below it untouched, with a notice naming what blocked it, and it is retried daily. Restoring clears the date.
- Public links for notes and files: `/api/v1/items/{id}/public-link`, `create_public_link`, `nixctl link`, and a read-only page at `/links/{token}`. Off until the install sets `NIX_PUBLIC_LINKS_ENABLED=true` (Compose and Kubernetes; `Nix:PublicLinks:Enabled` in Core), and agents need a second workspace switch. A file link stays on one fixed version. A note link is live; its attachments serve only from an approved version, and its inline images from the current one. Trashing an item ends its links for good. After a revoke, no new download can start more than 60 seconds later.
- Unique fields and record upsert: a collection can mark a text or address field `unique` across its direct children, and `POST /api/v1/items/{parentId}/records/upsert`, `upsert_record` and `nixctl record upsert` create or update by that value atomically, with optional idempotency keys. Retries and concurrent requests cannot make duplicates.
- Exact lookup by property (`POST /api/v1/workspaces/{id}/lookup`, `find_items_by_property`, `nixctl item find`) and filtered queries on MCP and the CLI (`query_items`, `nixctl query --filter`).
- Bulk writes: `POST /api/v1/workspaces/{id}/records/batch`, `batch_records`, `nixctl record batch`, up to 100 rows with a result per row. Good rows persist when others fail, and retrying is safe.
- A `strict` option on item create and property writes refuses undeclared keys and enforces required fields. `create_item` on MCP and `nixctl item create` now take properties and an idempotency key, and are strict by default. Property errors now list `violations` per field.
- An Attachments page lists a workspace's files with state, expiry, source note, pins and public link, and acts on them. `GET /api/v1/workspaces/{id}/attachments`, `list_attachments`, `nixctl file list`.
- MCP tools for uploading and downloading through short-lived URLs, on both the local and the remote transport, and `list_backlinks` and `set_item_schema`.
- A desktop app for macOS, Windows and Linux (`apps/desktop`, built with Electron): pick a Nix server and the app opens that server's own web app, with the same full offline copy as the iOS app (offline launch, reading, queued edits, files, conflicts). Sign-in runs in your browser, so passkeys and federated providers work. It needs a server from this version or newer, whose sign-in callback names its issuer; the iOS app needs rebuilding for the same reason. Builds are not code signed yet and do not update themselves.
- A sign-in handoff for native apps: `/auth/login?native=<challenge>` finishes in the system sign-in
  sheet and returns a one-time code (valid for 60 seconds) and the server's own `iss` to the app,
  which checks the issuer and redeems the code with its verifier at `/auth/native/redeem` to receive
  the session cookie. This lets passkeys work in the
  iOS app. The browser sign-in is unchanged.
- On phones, the app takes an Obsidian-like shape: a floating top row (Explorer, details, your
  profile menu) and a floating bottom bar (back, forward, find, new note, open tabs, menu); the
  Explorer and an item's details slide in from the screen edges; open tabs show as cards; search
  docks above the keyboard; menus and settings open as grouped sheets. Calendar, Inbox, your pet,
  Settings, Import and Zen mode are in the bottom bar's menu.
- In the iOS app, smart lists, charts, the Calendar page, habit trackers and finance pages work
  offline: they are recalculated from the offline copy, so property edits made offline show in
  them straight away. A view the app cannot recalculate exactly says it needs a connection.
  Habit check-ins and finance entries still need a connection.
- The iOS app: haptic feedback on habit check-ins and board drops, Share in an item's menu, no
  link previews on long press and no white flash in dark mode.
- The iOS app keeps a full offline copy of every workspace you can reach: the tree, properties,
  note bodies and files. It opens and reads everything with no connection, shows a small "Offline"
  notice, and removes the copy when you sign out. Settings > About shows how much space it takes.
  Creating, renaming, moving, trashing and editing properties work offline too, and so does
  editing note text, including in notes created offline: it syncs when the app reconnects. Queued
  changes replay when the connection returns, and a change the server refuses is listed with a way
  to dismiss it (a refused new note also keeps its text for copying). Other changes still need a
  connection.
- The iOS app keeps syncing for a short while after you leave it, so a sync that has started
  finishes, and file downloads carry on while the app is in the background. When syncing fails
  (not when you are simply offline) the app says what could not be synced, with a Retry button,
  and sends a notification if it is not on screen.
- A custom site layout: the site is rendered from your own Liquid templates, CSS and JS stored as
  files on a theme page in the workspace, and served in a sandbox. Choose it, and the theme page,
  in the site settings or with `nixctl site update --layout custom --theme <itemId>`.
- PDF exports can be set to Letter instead of A4 from the export dialog.
- Workspace sync endpoints for offline clients: a paged snapshot of everything you can read in a
  workspace, a change feed that resumes from a cursor, and a reconcile call that tells a device
  which of the copies it holds are gone, without revealing anything it never had. Locked notes
  stay out of the feed, and a replay call applies queued creates, renames, moves, trashes and
  property edits with the same permission checks as an online edit. Note bodies sync in batches
  through the collaboration service, which checks each note's access and lock afresh.
- An iOS app (`apps/mobile`, built with Capacitor and Xcode): pick a Nix server, and the app opens
  that server's web app with its own sign-in. Inside the app the profile menu and sign-in screen
  offer Switch server, the keyboard's form bar is hidden and the status bar follows the theme.
  Listing servers as app-bound domains lets the app start offline.

- On iPads and other touch tablets the app picks a layout from the window's shape and switches as
  you rotate or resize: held upright it uses the phone layout with a tab strip along the top and
  boards with their columns side by side; held sideways it uses the desktop layout with
  touch-sized controls and the details sliding in over the page. A narrow Split View window gets
  the phone layout.
- A status bar under the page on desktop and iPad held sideways shows backlinks, word or item
  count and whether the note is synced. Turn it off in Settings > General > Appearance.
- A Workspaces page lists every workspace with search, pins, groups and New workspace, from the
  left strip and from Homebase. Hidden items are in the profile menu.
- Settings > General > Appearance can hide the left strip of destinations.
- The details sidebar has an Outline tab listing the note's headings (click one to jump to it),
  and Backlinks shows the last list it fetched, with a note, when there is no connection.
- The tab bar's "+" opens a search box: pick a note to open it in a new tab, or create a new
  note from what you typed. Ctrl- or Cmd-click on an item in the Explorer opens it in a new tab.

### Changed

- Comments, suggesting and file review states (Draft, In review, Approved, Approve,
  Revoke) are now off until switched on for each item. Notes that already have comment threads keep
  comments on, and existing files keep review states on. Turning comments off keeps the threads and refuses new ones (`comments.disabled`);
  suggestions already in a note stay with Accept and Reject. With review states off, a file's public
  link serves its newest version that is not revoked, and the web app asks before you turn them off
  on a file that has a public link. An access token can turn review states off only where the
  workspace lets agents approve.
- Subitem previews open an item's saved default view when one is set. From the preview you can
  switch views, add one, or set a new default. When no child view is set as default, previews
  start in the contextual view, such as Record detail for a list item.
- Change a companion’s appearance by clicking its avatar, or click its name to rename it. Personal
  instructions are always visible, and the approval preference is under Behaviour.
- Companion chat defaults to the right-side drawer on devices without a saved choice. Avatar
  animation follows the system’s reduced-motion setting.
- **Breaking:** Pet settings no longer return `personality`, `responseLength` or `motion`. Update
  clients of `/api/v1/me/pets/settings` to stop using those fields. Core gives companions the same default
  response-length guidance, with personal instructions available for individual preferences.
- Create lists, boards and trackers with the suggested fields, and open Customize when you want to
  change the setup. The workspace Calendar keeps the agenda visible and opens event details when
  requested. Daily notes label the date and schedule control.
- Use workspace search, view search and Settings search with clearer labels. Find theme and layout
  preferences from Settings, and return to the same work after closing Settings.
- Use Document and Companion labels across device layouts. Companion chats show their scope before
  you send, and artifact previews show the values that will be shared.
- See board column counts and matrix sections on phones, discover more spreadsheet columns and
  editing controls, and get clearer guidance when using forms, smart lists, habits and canvas.
- Choose a source for a new template, see when a built-in template will be added to the workspace,
  and get clearer file import, workspace grouping, Trash and public-link recovery controls.

- **Breaking:** Accounts can save one companion. Clients saving pet settings must send zero or
  one profile. Existing accounts keep their active companion and its conversation identity.

- Homebase's Explore button opens the workspace Explorer, which now has its own item search.
- Bookmarked items appear at the top of the Explorer list with a pin icon.
- The desktop Explorer shows a circled plus for creating notes.
- The desktop Explorer has a visible divider along its right edge.
- Workspace Quick previews show pinned and most-used workspaces. Pin, unpin, or hide a workspace
  directly from Quick previews. Hiding applies to this browser. Restore a hidden workspace with
  Undo or from Workspace actions in Settings.
- Explorer tree rows group item commands in one Actions menu beside the drag grip.
- Pinned document tabs appear once, at the start of their pane’s tab strip. Tab controls appear on
  hover and keyboard focus, and horizontal strips have a bottom divider.
- Note details and Comments open beside the note on wide screens. Bookmarking and tree visibility
  live in Explorer, and Item actions groups commands that open a dialog.
- Chat notes center the transcript and composer, show who sent each message and when, and offer
  Copy reply and a shortcut back to the latest reply.
- The Chat about this note button opens a right-side drawer and keeps the note in place.
- The writing toolbar keeps Markdown and Suggesting under Writing mode and Text width under More tools.
- The phone and tablet Explorer shows only item browsing and actions. Workspace pages are
  available from the main navigation menu. Bottom navigation actions close the Explorer.

- Explorer uses the default view's icon for structured items and the body type's icon for other
  items. A custom icon still takes precedence.
- Mobile view controls have labelled Search and Filter buttons aligned with the view picker.
- The notice that offers Undo after an action now closes after 5 seconds instead of 8, and has a
  Dismiss button. Ctrl/Cmd+Z still undoes after it has gone.
- Manage automations and custom programs by asking your companion. Existing custom views and
  artifacts still open and run.
- The phone and portrait tablet note dock keeps Insert and Undo visible without sideways scrolling.
  More groups tools by task. Undoing an inserted block restores the caret and keeps nearby typing.
- CSV and TSV files open in the sheet grid instead of a read-only table. Edit cells and press Save
  to write the grid back as a new version of the file; files past the sheet's limits keep the
  read-only table.
- **Breaking:** a revoked file version no longer gets a download or thumbnail link. Naming one answers 410 `files.version_revoked`, and a plain download never serves a revoked version (404 `files.no_servable_version` when nothing else is left). A workspace Owner can still fetch one for diagnosis with `includeRevoked=true` from a browser session or an admin-scope access token, and each such link is recorded in the audit log. Links issued before the revocation stay valid until they expire (`Nix:ObjectStorage:CapabilitySeconds`, 300 seconds by default). Download responses gain `storedMediaType` and `revoked`; `mediaType` stays the type the link is served as.
- A file download with no version named now returns the latest approved version, or the latest upload when none is approved, and says which it served. Renaming a file only renames a draft version, so an approved file name stays exact.
- One `nix-node` service runs collaboration, the pet companion and the sites worker, replacing `nix-collab`, `nix-companion` and `nix-sites-worker` (Compose) and the `nix-collab`, `nix-worker` and `nix-sites-worker` Deployments (Kubernetes). The companion is now Node (`NIX_COMPANION_IDLE_SECONDS`, default 300) and the `worker` image is no longer published. `deploy.sh` removes the old services; the companion data volume carries over. See Upgrading in the docs.
- The sites worker no longer uses RabbitMQ: it leases `site.build`, `site.activate` and `site.purge` jobs from Core every few seconds (`NIX_SITES_POLL_SECONDS`, default 5) and completes them over the internal dispatch route. `NIX_SITES_RABBITMQ_URL` is no longer read.
- Imports run inside Core: the `import` worker role and its container are gone. Document imports (`.nix`, Markdown, text, Word, PDF), template imports, file publication with thumbnails, template file copies and object cleanup run as Core background jobs. Import plans for `.nix`, Markdown, text, Word and template archives are byte-identical to the worker's (recorded scenarios replay); PDF text is extracted in process instead of by `pdftotext`, so PDF imports split lines differently. An import commit interrupted by a restart is failed and its staged items removed, so a retry imports once. The pet companion now runs in the `nix-plugin-worker` container (Compose: `Nix__Pets__WorkerUrl` points at it).
- Exports run inside Core: the `export` worker role and its container are gone. Markdown, Word and `.nix` exports are byte-identical to the worker's; PDF exports carry the same text on the same pages but are written by a different library, so the bytes differ and Mermaid diagrams are rasterised by a different engine. An export interrupted by a restart is marked failed and can be retried.
- Calendar sync runs inside Core: the `calendar` worker role and its container are gone. Google Calendar and Microsoft Graph are called from Core with the same requests the worker sent (nine recorded scenarios replay identically). The provider API origins are `Nix:Calendar:Google:ApiOrigin` and `Nix:Calendar:Microsoft:ApiOrigin`; `NIX_CALENDAR_*_ORIGIN` on the worker is no longer read. A sync interrupted by a restart is marked failed and the next five-minute slot re-runs it; cursors are stored only after a full round, so nothing is left half-applied.
- Web Push delivery runs inside Core: the `notify` worker role and its container are gone, and Core now needs `Nix:Push:VapidPrivateKey` and `Nix:Push:VapidSubject` (Compose: `NIX_PUSH_VAPID_PRIVATE_KEY` and `NIX_PUSH_VAPID_SUBJECT`, already in the env file; Kubernetes: the `nix-push-vapid` secret, already present). A notification's push is handed to the worker once, so a restart mid-delivery can never push the same notification twice. Jobs Core was running when it restarted are marked `failed` with `interrupted_by_restart` and can be retried.
- Signing in keeps you signed in for 30 days instead of 8 hours, in the browser and the apps.
  `Nix:BrowserAuth:SessionHours` can shorten it (at most 720 hours).
- Your workspaces are listed in the profile menu and in the workspace switcher at the top, with
  All workspaces and New workspace.
- On desktop, tabs sit in the top row beside back, forward and the workspace switcher, starting
  where the page starts, with "+" after the last tab; Zen mode is in a note's "…" menu. Light mode
  uses the phone's colours at every width (published sites and print too) and dark mode keeps its
  greys; preview tabs are no longer in italics.
- The Explorer offers Chat, Upload files, New view and New note as icons; New view holds every
  other kind (canvas, sheet, each view type and your templates) in one dialog.
- Vim and Emacs keyboard modes apply only on the desktop layout; phones and tablets always edit
  as standard, and the setting is not shown there.
- In the demo, smart lists apply their filters.
- Ctrl- or Cmd-click on an item in the Explorer no longer adds it to the selection; Shift-click
  and Space still do.
- Browser sign-in (`/auth/login` and `/auth/callback`) is limited per address,
  `Nix:RateLimits:BrowserLoginsPerMinute` (default 30 a minute).
- Settings > Site approvals shows the requester's name where the approver can read the
  requester's workspace members, and the short id otherwise.
- Deleting several selected items runs up to four deletes at a time instead of one after another.
- A Drive view opens with its saved sort, and Kind, Size and Modified can be saved as its sort.
- Markdown mode highlights Markdown syntax as you type.
- Mermaid diagrams follow dark mode, and a diagram that takes over ten seconds, or is larger than
  50,000 characters or 500 edges, shows an error instead of rendering.
- Uploaded DOCX, XLSX and PPTX files are recognised as such instead of as ZIP archives.
- A refused call that lacks a token scope now says which scope it needs and how to get one.

### Removed

- **Breaking:** the finance feature. The `finance` view kind, its `/api/v1/items/{itemId}/finance*`
  routes, the `nixctl finance` commands and the finance MCP tools are gone; keep money records in
  plain CSV files, which open in the sheet grid. Existing finance records stay as ordinary items
  and any saved `finance` view becomes a `sheet` view on upgrade, but nothing converts the records
  to CSV. Scripts that call the removed routes, commands or tools must stop.
- **Breaking:** WebAssembly plugins. The workspace plugin routes (`/api/v1/workspaces/{workspaceId}/plugins*`), the seven `plugin_*` tables and the `plugin-events` worker role are gone; nothing was installable outside seed data and no installation existed. Objects under `plugins/components/` in storage can be purged. The `worker` image now hosts only the pet companion (`nix-companion` in Compose; the `nix-worker` Deployment in Kubernetes), which needs no broker or storage credentials.
- The Go worker binary, the `go-workers` sources and its Dockerfile. Every role now runs in Core or in `nix-node` (ADR-0067); the Go toolchain is no longer needed to build or develop Nix.
- **Breaking:** RabbitMQ. The broker and its `NIX_RABBITMQ_*` settings are gone from Core, Compose and Kubernetes; it only carried wake-up hints and every job is a `worker_job` row. Before upgrading, wait until no export or import is running: queued jobs are leased by Core on first start, but running exports and imports are marked failed with "try again". Remove the `rabbitmq` service and volume, the `NIX_RABBITMQ_*` variables and the retired worker services afterwards (Compose `deploy.sh` removes the containers; Kubernetes `deploy.sh` deletes the StatefulSet and keeps the volume).
- `GET /api/v1/items/{itemId}/permissions`, `PUT …/permissions/entries` and
  `DELETE …/permissions/entries/{aclEntryId}`. They were never built and always answered 501. The
  item routes no longer declare a 501 response either.

### Fixed

- PDF exports draw Chinese, Japanese and Korean text instead of replacing it with "?". Arabic,
  Hebrew, Indic scripts and emoji are still replaced, and the export still reports it. Self-hosted
  builds outside the images run `scripts/fetch-pdf-fonts.sh` once.
- Keep the companion launcher clear of Calendar Add and creation buttons on phones and tablets.
  Give compact Settings controls 44 px touch targets and make inline API help links distinguishable.
- Restore a moved graph item to its former sibling position with Undo when that position is known.
  Keep graph item opening controls consistent with the current layout.
- Keep Outline toolbar labels and the attachment State filter legible at phone widths, and announce
  administrator loading and empty states outside the list. Retry a failed artifact load.
- Workspace calendar events can be dragged between days in Month view, including across weeks.

- Calendar Agenda shows each date below its day heading, keeping dates and Add buttons readable
  on tablet and desktop.
- The mobile writing toolbar no longer covers the note and can be hidden or shown while editing.
- The Comments view puts a text field and a visible Post button above the discussion, so adding
  the first comment is easy. The demo supports posting comments.
- Tablet header controls align with the Home icon.
- Tablet document tabs align with the workspace controls and keep the active tab in view.
- When a note begins with a heading identical to its title, the header shows a Rename control and
  the document shows its heading once.
- Tablets keep a direct Homebase link when the navigation rail is hidden. View tabs use their
  compact spacing and expand to reveal options on hover or keyboard focus. On touch, options
  appear beside the selected view.

- Pressing a result as the command palette refreshes opens the item shown on screen.
- The undo notice now goes away on its own after a few seconds instead of staying on screen. Undo
  history is kept, so Ctrl/Cmd+Z still works and the next action or undo shows the notice again.
- Text a pet writes into a note converts properly: `- [ ]` checklists become task lists (and survive a pet edit), `> [!note]` callouts work in their usual spelling, bold next to punctuation is bold, plain web addresses become links, `<br>` is a line break, and a reply wrapped in a Markdown code fence is unwrapped. The pet is told when any Markdown stayed as plain text. Markdown import gains the same task lists, callouts, links and line breaks.
- Form entries can be undone even when the collection has not finished refreshing.

- Public forms were not reachable behind the bundled reverse proxy configurations: `/public/v1/forms/*` fell through to the web app.
- Creating an item with invalid properties answered 404; it now answers 422 with the reason.
- The iOS app's offline copy could never be created, so the app had nothing to open offline and
  showed "Nix is offline". The on-device store refused the search index's own setup. It now opens,
  syncs, and a copy that cannot be opened is reported instead of failing silently.
- `nixctl search --limit` rejects a value that is not a positive integer instead of sending it.
- Creating or deleting a site in the item's site pane relabels the item menu straight away.
- The site pane's page pickers load more children on request instead of stopping at 500.
- Nightly backup sizes are recorded in exact bytes instead of rounded-up KiB.
- Signing out of the iOS app without a connection now ends the server session at the next launch,
  instead of signing you straight back in.

### Security

- Vulnerable transitive copies of `nanoid` 3, `lodash-es` and `source-map-js` are overridden to
  fixed patch releases.

## 0.5.1 - 2026-11-01

### Added

- Settings > About lists the exact release each service runs: the web app, Core, collaboration,
  every worker and the sites worker, each with its version and image commit, flagging one that
  differs from Core. Deployments set it from the release checkout; a service shows up once it has
  called Core since Core last started. `GET /api/v1/system/versions` returns the same list, and
  Core's status endpoint now reports the release version instead of `1.0.0`.
- Compose installs serve `/web-config.json`, so `NIX_WEB_LANDING` and `NIX_WEB_DEMO` work there as
  they do on Kubernetes.

### Fixed

- A Kubernetes deploy re-creates the database seed Job, so a release that changes the seed image
  (as the 0.5.0 digest pins did) no longer stops at the seed step.

### Security

- **Breaking:** tenant administrators no longer see or open workspaces they are not a member of.
  Being an administrator now means managing the tenant: administrators, site approvals and handing
  a departed person's personal workspace to a new owner. To work in a workspace, an administrator
  is invited to it like anyone else. Rename, sharing, member, invitation, archive, restore and
  daily-note settings follow the same rule.

## 0.5.0 - 2026-10-30

### Added

- Charts can group by a priority, checkbox or completion property: priorities read P1 Urgent to
  P4 Low in order, and checkboxes read Checked and Not checked. A line, area or period chart without
  a date to group by now says that it needs one. (#266)
- PDF and DOCX exports draw Mermaid diagrams as pictures instead of printing their code. Markdown
  exports keep the code block. A diagram that has not been captured yet, or cannot be drawn, is
  still exported as code.
- On desktop, a chevron beside the item menu slides out Chat, Import, Export and History as
  one-click buttons and collapses them again.
- Pets can do anything you can do in Nix. For actions without their own tool, a pet finds the
  action and asks before running it, and the approval card shows the exact request. Permanent
  deletes, access changes and publishing carry a warning. Pets never touch access tokens, AI keys,
  pet settings, push subscriptions or calendar accounts. Pets can also move an item to another
  workspace.
- `nixctl api list` and `nixctl api call` reach every Core operation by id.
- MCP tools `find_nix_action` and `run_nix_action` reach every operation except the
  credential ones. New typed MCP tools: `move_item` (also to another workspace), `rename_item`,
  `trash_item`, `restore_item`, `list_trash` and `set_item_properties`. There are also note history
  tools: `list_note_history`, `restore_note_version` and `name_note_version`.
- Homebase, the screen a workspace opens to when no note is open: a greeting with today's date
  and week, one-press New note, Structured note, Today's note, Calendar, Templates, Import,
  Automations and Settings beside the notes you opened last on this browser. It replaces Notes as the first entry in the side rail.
- Owners can close a workspace to new members in its settings. While it is closed, nobody can be
  invited and pending invitations cannot be accepted.
- Live collaboration can be switched off for a workspace (owners) or for one file (anyone who can
  edit it, from the item menu). With it off, one person edits at a time. Everyone else reads
  until that person leaves, and the next one can then edit.
- An invitation arrives as a notification in the inbox, and opening it shows the workspace's
  Accept and Decline.
- `nixctl ws sharing` and `nixctl item protect --collaboration`, and the MCP tool
  `set_workspace_sharing`.
- The companion can search a note and every note under it: it finds the passages that answer a
  question, by wording and by meaning, so a note far too long to read in one go (a 200-page
  document) and its children can be asked about. Passages are matched by a small embedding model
  that runs inside the server, with no API key or cost; locked, trashed and template content is
  never searched. Notes are indexed as they are next saved, and existing notes in the background.
  The API image is about 35 MB larger, the API uses 100-250 MB more memory, and its memory limit
  in the Compose and Kubernetes files rises from 512 MB to 768 MB.
- The companion's search finds passages by meaning across the workspace, not only titles and exact
  words, so a note that says "holiday" answers a question about a trip. It answers from those
  passages and links the notes they came from.
- The companion remembers lasting facts and preferences you tell it about yourself, or ask it to
  remember, and uses them in later conversations. Settings > Pets > Memory lists every fact to
  edit, forget or add to, and chooses whether pets don't remember, ask before remembering (the
  default) or remember automatically, each saved fact then offering Undo in the chat. It never
  saves what notes or other people say, nor anything from a conversation that has read locked
  content.
- Drag files and folders from your computer onto the Explorer. Dropping on an item puts them
  inside it, between items puts them beside it, and on empty space at the top of the workspace.
  A folder becomes a note holding its files and subfolders.
- An embedded note shows its views as well as its text, with tabs to switch between them. The view
  you pick is saved with the embed, so everyone opening the page sees the same one.
- Comments on notes: select text and choose Comment, or leave a comment on the whole page.
  Threads take replies, can be resolved and reopened, and update live. @mentions and replies
  notify the people in the thread. People can be invited as Commenters, who read and comment
  but cannot edit. Exports can include comments, and `.nix` archives carry them. The MCP tools `list_comments`, `add_comment`,
  `reply_comment` and `resolve_comment` read and write them.
- Suggesting mode: turn it on to propose edits instead of making them. Typing, deleting,
  formatting and block changes (new paragraphs, lists, indents) show as suggestions that others
  accept or reject one by one, from the Comments pane, or all at once. Published sites and exports
  show the document as it was before the suggestions.
- A word count, reading time and heading outline under every note.

### Changed

- The landing page presents Nix as a free, open-source workspace where people and their AI agents
  work together, with a section on what the companion and your own agents can do, and screenshots
  retaken from the current interface. The gallery adds Homebase, graph, artifact and search shots,
  and the habit tracker now comes from the demo. Every screenshot follows the light or dark theme
  chosen in the page header.
- The `/demo` includes the companion: a sample chat shows it answering from the workspace,
  building a table, making an approved change and remembering a preference. Replies to new
  messages are scripted, since the demo has no model.
- Breaking: Nix is now licensed under AGPL-3.0-only, with additional permissions for plugins,
  content made with Nix and programs that use it through the API, `nixctl` or MCP. Using or
  self-hosting Nix, including commercially, is unaffected; running a modified Nix for other people
  now means offering them its source. Releases up to v0.4.x stay MIT. A commercial licence is also
  offered. See `docs/licensing.md`.
- PDF, DOCX and Markdown exports and DOCX imports go through a presentation tree (`nix-render`)
  that the collaboration server produces from the document. The export worker no longer reads the
  editor's document format, so a new block type cannot silently degrade an export; a tree the worker
  cannot read fails the export instead. Headings below level three now import from DOCX as
  headings. (#273)
- With an Anthropic or OpenRouter key, the companion keeps the last 12 turns of a conversation
  instead of the last 32 messages, so one request that runs many tools no longer makes it forget
  everything before it, and its prompt is cached, so later steps and replies cost less and start
  sooner.
- The companion understands views better: which views apply a saved sort and filters, how smart
  list filters and presets work, and what a view read left out.
- The note tree is now called the Explorer, so "workspace" only means a workspace you belong to.
- **Breaking:** an invitation grants nothing until it is accepted. Invitees no longer get
  provisional access, and signing in no longer accepts a pending invitation. Updating removes the
  provisional access existing pending invitations gave.
- People editing a document appear as small, quiet profiles: their initials in a circle outlined
  in their cursor colour, with their name on hover. A profile disappears as soon as that
  person's tab is hidden or closed.
- Another person's cursor in a note is a thin line in their colour with a small initials circle
  above it, instead of a name block that pushed the text onto the next line.
- The Explorer has a New note button, which makes an untitled note in one press, and a New view
  menu for every other kind of item.
- The companion pet stands on the page without a card behind it.
- Workspace settings take far less room: the name is renamed in place, Leave and Archive sit in
  a menu beside it, the three switches are one Options group, members and pending invitations
  are one People list with a single invite row, and save messages are toasts. New workspace and
  Arrange workspaces moved to the workspace switcher.
- The workspace switcher has a search box: type to filter workspaces by name, Enter opens the
  first match.
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

### Fixed

- Creating an item with an empty title through MCP `create_item`, or as a blueprint child, keeps
  the title empty instead of refusing it. (#265)

### Security

- **Breaking:** browser upload links now fix the uploaded object's type, so an uploader can no
  longer store a file under a type of their choosing. Tabs and installed apps opened before the
  update, and older `nixctl import`, get "upload failed (403)" until they reload or update. (#211)
- The last-administrator guard counts only administrators who can act: suspended, deprovisioned
  and service accounts, and groups with no active member, no longer let the last real
  administrator be removed, and two administrators revoking each other at once can no longer
  both succeed. (#164)
- The Compose edge now forbids framing the app, as the Kubernetes edge already did. (#212)
- Shipped dependencies with published advisories are updated (Fastify, Axios, Tiptap,
  ProseMirror, the MCP SDK and others), and the Go workers build with Go 1.26.10. (#207)
- CI actions are pinned to commit SHAs and third-party images to digests, with Dependabot keeping
  them current. (#208)


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
