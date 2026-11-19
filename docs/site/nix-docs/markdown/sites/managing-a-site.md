# Managing a site

You can run a site from the Site panel in the web app or from `nixctl`. Both use the same API and the same rules.

## The Site panel

Open any item and choose the **Site** tab in its panel, or choose **Publish as a site…** in the item's menu or its row menu in the sidebar. These entries are shown to workspace owners while **Show publishing on pages** in **Settings > General** is on, which it is by default.

**Making a site.** On an item that is not yet a site, **Make this a site** asks for an address (the slug) and a layout: "Docs: pages with a sidebar" or "Blog: dated posts first". The site starts as a draft. Nothing is public yet.

**Status.** The site's name, whether it is a draft, published or unpublished, its addresses, when the live build went live and how many pages it has. If the last build could not publish everything as written, the panel lists what was left out or changed, under "Not everything could be published as written".

**Publishing.** **Publish**, **Publish changes** or **Publish again**, depending on the site's state. The first publish opens a dialog that asks you to confirm "I understand this site will be public and may be copied." On an instance that requires approval, **Ask for approval** sends the request to the operator, and the panel shows "Waiting for approval" until it is decided. **Unpublish** takes the site down; a site that is not live can be deleted.

**Previous builds.** Each retained build with a **Roll back** button.

**Pages.** **Show paths** lists every page with its path, and lets you change a path. A path you set is pinned, and the old one becomes a redirect.

**Left out.** **Choose what to leave out** picks items to exclude, with everything under them.

**Settings.** Site name, description, layout (Docs, Blog or Custom; Custom also asks for the id of the theme page), accent colour, typeface (rounded Nunito Sans, book serif Literata or Atkinson Hyperlegible Next), heading mark (square, diamond or none), spacing (compact, comfortable or airy), top navigation (one link per line, a label then a path such as `/guide/`), footer text, author, whether to hide the site from search engines, and whether to show a "Built with Nix" link. **Publish changes** sets the republish mode: "Only when I publish", "Automatically after edits" or "With each Nix release", and, for automatic mode, how long to wait after the last edit: 1 minute, 5 minutes, 15 minutes or 1 hour.

**Dated collections.** For each collection, the container and the properties that hold the date, and optionally tags, a cover image and a summary.

**Hostnames.** **Add a hostname**, then the records to create at your DNS provider, each hostname's status ("Waiting for DNS records", "Verified", or "Verified, but the last check failed"), which one is primary, and, for each alias, whether to "Serve the same pages" or "Redirect to the primary". Hostnames whose records Nix created carry a "Managed by Nix" badge.

People who can read the workspace but not manage it see the panel without its controls, with a note that only a workspace owner can change or publish the site.

## nixctl

`nixctl site` drives the same operations from a terminal. Every command accepts `--json`.

```sh
# Make an item a draft site, and read it back
nixctl site create <root-item-id> --slug handbook --layout docs
nixctl site get <site-id>
nixctl site get --item <root-item-id>

# Settings
nixctl site update <site-id> --name "Team handbook" \
  --description "How we work" --accent "#2f5fd0" \
  --typeface serif --heading-mark diamond --spacing airy \
  --nav "Guides=/guides/" --nav "Changelog=/changelog/" \
  --footer "Written in Nix." --no-built-with-nix

# A custom layout: render from templates, CSS and JS attached to a theme page
nixctl site update <site-id> --layout custom --theme <theme-page-id>

# A dated collection: <item>:<date>[:<tags>[:<cover>[:<summary>]]]
nixctl site update <site-id> --dated <collection-id>:date:tags:cover:summary

# Leave items out (replaces the list)
nixctl site update <site-id> --exclude <item-id> --exclude <other-item-id>

# Republish automatically ten minutes after the last edit
nixctl site update <site-id> --mode auto --debounce 600 --yes

# Publish and wait for it to go live
nixctl site publish <site-id> --yes --wait

# Re-derive paths from current titles, keeping redirects from the old ones
nixctl site publish <site-id> --refresh-paths --wait

# Builds, one build's report, pages and a pinned path
nixctl site builds <site-id>
nixctl site build <site-id> <build-id>
nixctl site pages <site-id>
nixctl site path <site-id> <item-id> /guides/install/

# Take it out of search engines, or let them back in
nixctl site update <site-id> --noindex

# Roll back, take down, delete
nixctl site rollback <site-id> <build-id> --yes
nixctl site unpublish <site-id> --yes
nixctl site delete <site-id> --yes
```

`publish --wait` waits up to 600 seconds by default; change it with `--timeout`.

### Hostnames

```sh
nixctl site hostnames add <site-id> docs.<your-domain> --mode serve
nixctl site hostnames list <site-id>      # status, and the records still to create
nixctl site hostnames verify <site-id> docs.<your-domain>
nixctl site hostnames primary <site-id> docs.<your-domain>
nixctl site hostnames add <site-id> www.<your-domain> --mode redirect
nixctl site hostnames mode <site-id> www.<your-domain> redirect   # how an alias answers
nixctl site hostnames remove <site-id> docs.<your-domain> --yes
```

### Approvals

Operators can also decide in **Settings > Site approvals**, which only approvers see.

```sh
# A manager asks for the first publish to be approved
nixctl site approvals request <site-id> --yes

# An operator reviews and decides
nixctl site approvals list
nixctl site approvals approve <site-id>
nixctl site approvals reject <site-id> --note "Please remove the draft pages first"
```

Changing a site with a personal access token needs a token with the admin scope.

## Properties

- title: Managing a site

