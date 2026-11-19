# November 2026

# November 2026

## Since 0.7.0

These changes are on `main` and will be in the next version. An install made from the 0.7.0 release does not have them yet.

### Sign-in

- Nix signs people in itself, so a self-host no longer needs a separate identity provider. The first account is created on the setup page with a setup code. Sign-in is by email and password, with an authenticator-app code as an optional second step, or by passkey alone.
- Administrators have a People page: add a person (they get a one-time link, valid for an hour), issue a reset link, and disable or re-enable an account.
- Everyone has Settings > Security: change or remove your password, manage passkeys, add or remove an authenticator app, and sign out everywhere.
- **Breaking:** the bundled Zitadel is gone. An install that still uses it must migrate when it upgrades, and accounts, passwords, authenticator apps and passkeys are carried over. See [Upgrades](nix://item/01a130b0-16c2-776e-89d2-b80f0e28db40).

### Agents and MCP

- Hosted clients such as ChatGPT and claude.ai connect to remote MCP by signing in with OAuth. The token they receive is an ordinary access token that expires after 90 days.
- Send a work request in the companion conversation to start a job. Enabled workspaces can review and revise each proposal in the conversation, and jobs resume after a restart.
- The companion can draft on a canvas for you to apply, run named routines on a schedule, watch a mail label or folder, and use scoped connections to mail, drive, messaging, calendar, issue and code services. Outbound changes are reviewed first.
- Withhold any item from the companion in its protection settings.
- Ten new companion appearances. Eye of Ra and Demiurge are retired; profiles that used them become Owl and keep their name, instructions and history.

### Apps and offline

- The phone and desktop apps show how many offline changes are waiting, say in plain words why a change was not applied, and have a Sync now button under Settings > About.
- Offline sync is faster and more forgiving: it waits out rate limits, reruns an interrupted pass, sends a long queue without pauses, and no longer discards the offline copy when a proxy in front of the server answers instead of Nix.

### Sharing

- Links to the public pages show a preview card when shared.

### Self-hosting

- The one-line install asks for at least 1 GB of memory instead of 8 GB. A fresh install idles at about 300 MiB.
- The images take about 4 GB less disk space in total.
- New installs need one hostname instead of two.

## Version 0.7.0

Released 14 November. This version also carries everything that was listed under 0.6.0, which was never tagged.

### Item settings

- Every item has a Settings pane for comments, suggesting, file review states, full width and the default view. The server enforces them, so they apply in the web app, `nixctl`, MCP and the mobile apps.
- Comments, suggesting and file review states are now off until you switch them on for an item. Notes that already have comment threads keep comments on, and existing files keep review states on.
- Workspace owners choose what new items start with under Workspace settings > New items.

### Sites and sharing

- Publish as a site is in the menu of every item, of any type, for workspace owners. The publishing switch in Settings is on by default.
- Notes and files can have a public link, and tenant administrators can switch public links and MCP on or off.
- A custom site layout renders a site from your own Liquid templates, CSS and JavaScript.

### Access tokens

- Rotate a token in Settings > Access tokens or with `nixctl token rotate`. The token keeps its name and scopes, the new secret is shown once, and the old secret and its sessions stop at once.

### Views and writing

- Twelve personal templates, and built-in templates in every workspace's template library.
- Open records from List, Spreadsheet and Smart list views, review Gallery assets and Form submissions, and link Timeline prerequisites.
- Six colour palettes, three Zen layouts and a choice of sidebar destinations under Preferences.
- CSV and TSV files open in the sheet grid, and text in notes can be justified.

### Companion

- Companion chat opens in a right-side drawer and streams replies. Six new animated appearances.
- Each account now saves one companion.

### Apps

- An iOS app with a full offline copy of your workspaces and a desktop app for macOS, Windows and Linux. None is in a store yet; the landing page lists each with a download button that reads "Coming soon" until it has a link.
- On phones the web app has a new layout with a floating top row and bottom bar, and tablets pick a layout from the window's shape.

### Self-hosting

- One `nix-node` service replaces the collaboration, companion and sites worker services. Imports, exports, calendar sync and push delivery run inside Core.
- **Breaking:** RabbitMQ and the Go workers are gone. Remove the `NIX_RABBITMQ_*` settings before upgrading.
- **Breaking:** the finance feature and WebAssembly plugins are removed.
- Signing in keeps you signed in for 30 days.

The full list is in the [changelog on GitHub](https://github.com/sianachi/nixsites/releases/tag/v0.7.0).

## Version 0.5.1

### Administrators

- Tenant administrators no longer see or open workspaces they are not a member of. They keep managing administrators, site approvals and handing a departed person's personal workspace to a new owner. To work in a workspace, an administrator is invited like anyone else.

### Settings > About

- Settings has an About page that lists the exact release each part of the deployment runs: the web app, Core, collaboration, every worker and the sites worker, each with its version and commit. A service on a different commit from Core is flagged.

### Self-hosting

- Compose installs can turn on the landing page and the demo with `NIX_WEB_LANDING` and `NIX_WEB_DEMO`.
- A Kubernetes deploy re-creates the database seed job, so a release that changes the seed image no longer stops at that step.

## Properties

- date: 2026-11-01
- tags: deploy
- title: November 2026

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

