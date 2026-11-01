# November 2026

# November 2026

## Version 0.5.1

### Administrators

- Tenant administrators no longer see or open workspaces they are not a member of. They keep managing administrators, site approvals and handing a departed person's personal workspace to a new owner. To work in a workspace, an administrator is invited like anyone else.

### Settings > About

- Settings has an About page that lists the exact release each part of the deployment runs: the web app, Core, collaboration, every worker and the sites worker, each with its version and commit. A service on a different commit from Core is flagged.

### Self-hosting

- Compose installs can turn on the landing page and the demo with `NIX_WEB_LANDING` and `NIX_WEB_DEMO`.
- A Kubernetes deploy re-creates the database seed job, so a release that changes the seed image no longer stops at that step.

## Properties

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

