# Sites

Sites turn any page tree in Nix into a public website. You write in Nix as usual, with notes, child pages, properties, images and views, and publish the tree as static pages. This documentation is a Nix site.

A site is a snapshot. Nothing you write is public until you publish, and edits, locks and exclusions reach readers only at the next build.

## The parts of a site

**The root item.** A site is attached to one item, and publishes that item and the pages beneath it. Each item can be the root of at most one site. By default an organisation can have up to 20 sites; whoever runs the instance can change that.

**The slug.** A short name that becomes the site's default address, `<slug>.<sites-domain>`. It is 2 to 40 lowercase letters and digits, with single hyphens between them. Infrastructure names such as `www`, `api`, `auth`, `admin`, `docs`, `mail`, `status` and `sites` are reserved, and an operator can reserve further slugs for particular workspaces.

**The layout.** `docs` gives pages with a sidebar, for documentation and handbooks. `blog` puts dated posts first, for a blog or a portfolio. `custom` renders the site from your own Liquid templates, CSS and JavaScript. You can change it later. See [Themes and layouts](nix://item/01a13137-b971-73b8-aee7-e08d3be44996).

**Settings.** A name (up to 120 characters, defaulting to the root's title), a one-line description, an accent colour, a typeface, a heading mark and spacing, up to 20 top navigation links, footer text, an author name, whether to hide the site from search engines, and whether to show a "Built with Nix" link.

**Dated collections.** A container whose children are posts, such as a blog or a changelog. You choose the collection and the property that holds each post's date, and optionally the properties for tags, a cover image and a summary. Nix does not guess which containers are collections. A post with an empty, unreadable or future date is held back until its date arrives and the site is built again. Each dated collection gets an index grouped by year, tag pages and an Atom feed.

**Exclusions.** Items you leave out, together with everything under them. The root cannot be left out.

**Page paths.** Every page gets a path from its parent's path and its title, such as `/guides/install/`. The root is always `/`. Once a page has a path it keeps it, even if you rename or move the page, so links to it keep working. To give pages fresh paths from their current titles and places, publish with "refresh paths"; each old path then becomes a permanent redirect. You can also set and pin a path by hand, and a pinned path is never changed for you.

**Builds.** Each publish produces a complete, numbered build. The most recent builds are kept so you can roll back to one.

## Who can do what

Creating, changing, publishing and unpublishing a site are workspace manager actions, and the managers are the workspace owners. Readers of the workspace can see a site's settings and status. **Publish as a site** is in the menu of every item, for owners, and the **Show publishing on pages** switch in **Settings > General** is on by default; turn it off to hide the entry. A personal access token needs the admin scope to change a site.

On an instance that requires it, the first publish of a site, and the first publish after it has been unpublished, waits for an operator to approve it. See [Publishing](nix://item/01a13137-ae48-7c3e-89e7-b5aa5c945d6f).

## Properties

- title: Sites

