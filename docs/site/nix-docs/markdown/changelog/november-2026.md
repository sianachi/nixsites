# November 2026

# November 2026

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

