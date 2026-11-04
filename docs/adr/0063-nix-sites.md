# ADR-0063: Nix sites as static publications of an item subtree

## Status

Proposed, 11 October 2026. On that date, the owner made these decisions:

- Sites are a product feature that any workspace can use.
- Publishing produces static output.
- The theme is a new Nix theme with a docs layout and a blog and portfolio layout.
- The first site is Nix Docs. It is the Nix homepage, made up of a landing page, a feature tour, the docs, a Changelog collection and a Self-hosting section.
- The second site is the owner's portfolio and blog, served at the `nwagboso.com` apex.
- Every site gets an automatic default hostname on a dedicated sites domain, and custom domains can be attached.
- Nix Docs lives on a Nix product domain that the owner will buy.
- DNS is automated through an operator-configured Cloudflare API token, and alias hostnames redirect.
- Sites are served from the owner's host behind the Cloudflare cache. An optional Cloudflare push target becomes the primary public origin when it is enabled.
- Each site chooses a republish mode: manual, automatic on edit, or on release.
- Publishing is a workspace manager action.
- A "Built with Nix" footer is shown by default.
- The site builder is a TypeScript worker role.
- Mermaid diagrams are published as SVG captured in the browser.
- Feature screenshots are regenerated at release in a later phase.

The owner also made two documentation decisions:

- Documentation reused from the repository is published only after the sensitive-information audit.
- The security gaps disclosed in ADR-0047, ADR-0048 and ADR-0058 must be fixed before Nix Docs launches.

Later the same day, the owner made these deployment decisions, which amend some of the bullets above:

- There are two productions:
  - `nixsites.com`: a full Nix app at the apex host, on a VPS deployed with Kubernetes (`deploy/k8s`). It serves sites at `<slug>.nixsites.com`.
  - The owner's local production: stays on Docker Compose.
  - Both run the same CI-published images.
- The `nixsites.com` app shares its registrable domain with the sites it serves. This is an explicit amendment to the separate-domain rule, with the mitigations in "Hostnames, DNS and aliases".
- Signups on `nixsites.com` are invite-only, and the operator approves each site's first publish.
- Nix Docs and the Nix homepage live at `nix.nixsites.com`, and the app's sign-in page links to it. No separate Nix product domain is needed.
- The portfolio is served at both `osinachi.nwagboso.com` and `osinachi.nixsites.com`. Both answer 200, and every page declares `osinachi.nwagboso.com` as canonical. This replaces the `nwagboso.com` apex decision.
- The local production also publishes sites, at `*.home.nixsites.com`, through a wildcard hostname on the home Cloudflare tunnel. The operator creates that `*.home.nixsites.com` tunnel wildcard once, by hand. Cloudflare tokens are scoped to zones, not to records, so the home token has no access to the `nixsites.com` zone at all: it needs only Cloudflare Tunnel edit and DNS edit on the zones used for custom hostnames.
- The Cloudflare R2 push target is not needed for the owner's sites, because `nixsites.com` hosts them. It stays a deferred option.

The 11 October security review of the Core milestone recommends approving three decisions, which await the owner's sign-off:

- the `site.build` job may use an item-scoped, read-only worker token for collaboration body reads;
- access tokens need Admin scope for every site mutation, and Read scope for site reads;
- the OIDC login cookie is renamed from `__Secure-nix_oidc` to `__Host-nix_oidc`.

Keeping docs in sync between the repository and Nix is a separate decision, ADR-0064.

This reverses one entry in the 2 August 2026 cut list in `todo.md`: "public sharing, Nix sites and custom domains". That list also cut public form submission, Outlook sync, an MCP server and a plugin sandbox, and all of those have since shipped. The cut was justified by team size, which does not apply to a feature whose readers are anonymous. This record does not reopen public sharing of single items or anonymous editing.

## Context

Nothing in Nix serves content to an unauthenticated reader today. The only anonymous surface is public forms. Each form link creates a service principal that is an Editor member of the workspace, and each anonymous request runs in a row-level security transaction as that principal. That suits a write endpoint that lands in one view. A website has different needs:

- its traffic is mostly reads;
- it should be cacheable by a CDN;
- it needs to be indexable by search engines;
- it must keep working under load that Core should not absorb.

Several parts already exist:

- Bodies are Yjs state, and collaboration snapshots hold derived ProseMirror JSON.
- `@nix/export` provides a ProseMirror visitor that the shared Markdown projection uses.
- `packages/view-render` draws list, board, gallery, calendar, timeline and sheet views as SVG strings without a browser.
- Chart drawing is hand-written SVG inside the web app.
- Mermaid renders only in a browser DOM.
- Items, child collections, typed properties and views can already model pages and a blog.
- File bytes are reached only through short-lived capability URLs.

The single-page app has no server rendering. It runs on an origin that carries the BFF session cookie.

## Decision

### Not a separate application

Sites are a feature of Nix. Authors write content as ordinary items. A web panel backed by Core endpoints configures and publishes a site, and a worker role builds it. The only new deployable is the anonymous serving process. It is separate so that site content written by users runs on an origin other than the app's, and it has no accounts, authoring or data of its own.

### What a site is

A site is a record attached to one root item. It includes every active descendant of that root that the publisher can read, except:

- trashed items;
- items covered by a password lock (ADR-0056);
- items listed as excluded;
- items in a dated collection whose publish date is empty or in the future.

Body kind never decides structure. A note renders as a page. An item with children also renders an index of them from its default view: list and gallery views produce index pages, and other view kinds produce a list of titles.

The site record holds:

- the slug;
- the theme layout and settings: name, description, accent, navigation, footer, and the "Built with Nix" link (on by default);
- the exclusion list;
- the republish mode;
- its hostnames.

Each page has a stable path, stored in a page table keyed by item. Once a path is published it never changes. Renames and moves keep the old path as a permanent redirect. Paths can be set by hand, so an existing site can keep URLs such as `/blog/<slug>` and `/blog/tag/<tag>`.

### Who can publish

These are workspace manager actions:

- publishing and unpublishing;
- rolling back;
- changing the republish mode;
- changing hostnames.

A site discloses everything under its root, so this authority matches the authority to manage the workspace. Core alone decides it, and each of these actions is written to the audit log.

### Static output, built by a TypeScript worker

The public gets no read path into Postgres. When a build starts, Core:

1. enumerates the eligible subtree in the publisher's row-level security context;
2. records an immutable build manifest listing item ids, content snapshot ids, file version ids, paths, and the rows that each rendered view and chart may show;
3. queues a build job.

View and chart rows come from the same eligibility query, so a rendered image never shows an excluded item.

A new `sites` worker role, written in TypeScript, consumes the job (from RabbitMQ at first; since November 2026 it leases the job from Core over the internal dispatch route). It reads bodies and files through the service-authenticated `/internal` API and renders with a shared `@nix/site-render` package:

- **HTML:** an HTML projection built on the `@nix/export` visitor, with the same loss reporting as the other projections.
- **Views:** list, board and gallery views use `view-render`.
- **Charts:** chart views use chart drawing extracted from the web app into a package with no React dependency.
- **Mermaid:** diagrams use an SVG captured in the author's browser whenever the diagram is edited, stored as a file version alongside the block. A block without a captured SVG falls back to a code block, and the build reports it. The SVG is stamped with the SHA-256 of the source it was drawn from, and a stamp that does not match the block's source also falls back to code. The stamp detects stale pictures only; it is not an integrity guarantee, because any editor of the page can upload a picture with any stamp. Safety rests on sanitising the SVG at build.

The builder never uses a headless browser (ADR-0038). The Go worker roles do not change.

Images are copied into the output as content-addressed files with their metadata stripped. Published pages never contain capability URLs, revoking a file never breaks a page, and unpublishing deletes the copies. Nodes that a static page cannot represent are reported in the build result and rendered as a notice or a link. These are live embeds, plugin blocks, canvas and sheet bodies, and query views.

A build goes live only after all its files are written. It goes live by writing a host manifest that maps each hostname to the build. Publishing is therefore atomic, rollback means pointing at a previous build, and Core keeps the last few builds.

### Republish modes

Each site has one mode:

- **Manual**, the default: rebuilds only when a manager publishes.
- **Automatic on edit:** confirmed changes inside the subtree trigger a debounced rebuild.
- **On release:** the production release procedure runs `nixctl site publish`, so the docs never describe features that have not been deployed.

Automatic rebuilds run as the principal who enabled the mode. If that principal loses manager rights or is deactivated, automatic rebuilds stop and the site stays at its last build.

### Hostnames, DNS and aliases

By default, sites are never served from the app's registrable domain. Every site immediately gets `<slug>.<sites-domain>`. Managers can attach custom domains, including apex domains. They can also attach alias hostnames, which either redirect to the primary hostname with the path kept or serve the same build under a single canonical URL.

**Amendment for a shared app domain.** An operator may run the app at the apex of its sites domain, as `nixsites.com` does, only by setting `Nix:Sites:SharedAppDomain=true`. In that mode these mitigations apply:

- the bare apex and every reserved slug (for example `www`, `app`, `api`, `auth`, `login`, `admin`, `home`, `nix`) are never served as sites;
- the app's session and login cookies use the `__Host-` prefix, so no subdomain can set or overwrite them;
- sites never set cookies and never run user-authored scripts, because the builder escapes all content and passes no raw HTML;
- `/auth/token` accepts only the app's exact origin;
- signups are invite-only, and the operator approves each site's first publish.

Without that setting, startup refuses a sites domain that equals or overlaps the app host. A second instance can use a delegated namespace of the same sites domain, such as `*.home.nixsites.com`, whose wildcard the operator creates by hand; that instance's token never covers the sites domain's zone.

The operator can configure a Cloudflare API token scoped to editing DNS records and tunnel configuration. When a hostname's zone belongs to that account, Nix does the setup itself:

- it creates the verification TXT record and a proxied CNAME;
- it adds the tunnel public hostname;
- it verifies the result.

Automation is configured per zone, and each zone is handed to exactly one workspace (`Nix:Sites:Cloudflare:ManagedZones`). Mapping a zone delegates every unused name in it to all managers of that workspace: any of them can point a free name in the zone at a site. Startup refuses a managed zone that equals, contains or lies under the sites domain or the app's registrable domain. Nix never automates the zone apex, never overwrites or deletes a record it did not create, and treats an existing routing record at the name, or a wildcard covering it, as taken.

For any other zone, Nix shows the CNAME and TXT records to create and checks them live. TLS terminates at Cloudflare. The token is an operator secret held by Core and is never exposed to workspaces.

### Serving

A small Node serving process (`apps/sites`), run locally under `*.localhost`, does the following:

- maps the Host header through the host manifest;
- answers alias redirects;
- streams files from the object store, with long cache lifetimes on content-addressed files;
- serves the theme's 404 page.

It reads only the object store. It holds no database credentials and never calls Core while serving a request. Unpublishing deletes the host manifest and the builds, then purges the CDN.

Pages work without JavaScript, apart from optional same-origin scripts for search and the theme toggle. The site content security policy allows only same-origin scripts, styles and images, and no frames.

### Cloudflare push target (deferred)

This target is not needed for the owner's sites, because `nixsites.com` hosts them. It remains an option for operators without a public host. In that design, a site would also push each build to Cloudflare R2. A small Cloudflare Worker uses the same host manifest format to serve it. While push is enabled:

- the cloud copy is the site's primary public origin, so the site stays up when the operator's host is down;
- the operator's host serves only a preview hostname.

Push credentials are operator configuration.

### Theme

There is one built-in theme, the Nix default, designed as a Nix showcase. It has two layouts:

- **Docs:** a sidebar tree, a table of contents for each page, heading anchors, previous and next links, code highlighting at build time, and client-side search over an index built with the site.
- **Blog and portfolio:** home, page, collection index, post and tag pages.

Both layouts produce a 404 page, an Atom feed for each dated collection, `sitemap.xml`, `robots.txt`, canonical links, and Open Graph metadata with a generated preview image.

Themes written by users, custom CSS and a theme marketplace are out of scope.

## Consequences

A published site is a snapshot. Edits, locks, trash and exclusions take effect publicly only at the next build. Unpublishing is the immediate withdrawal, subject to CDN purge latency. Search engines and archives may keep withdrawn content, and the first-publish dialog must say so.

There is no anonymous principal and no anonymous database transaction. Disclosure risk lies entirely at publish time, so the eligibility query, the build manifest and the view-row selection are the security-critical code. Tests must prove that the following never appear in a manifest or a rendered image:

- locked items;
- trashed items;
- excluded items;
- future-dated items;
- items the publisher cannot read.

Tests must also prove that only referenced files are copied.

The deployment gains:

- a Node worker role;
- the serving process;
- a sites domain for each production (`nixsites.com` and `home.nixsites.com`);
- a Kubernetes production for `nixsites.com` next to the Docker Compose production;
- a Cloudflare token for each production, each scoped to the zones it automates (Cloudflare tokens cannot be narrowed to records).

On `nixsites.com`, the app and every user's site share one registrable domain. The mitigations in "Hostnames, DNS and aliases" cover cookies and scripts. The larger remaining risk is abuse: a phishing site on any subdomain could get the whole domain flagged by browsers, and that would take the app down with it. Invite-only signups and operator approval of each site's first publish are the controls until proper abuse tooling exists.

The DNS token can edit every zone in its account, so it is held only by Core and used only for verified hostname changes.

Rendered views and charts show the data as it was at build time. A Mermaid diagram looks exactly as it did in the editor when it was last edited. Diagrams edited outside the browser fall back to code until they are opened and edited in the web app again.

The search index is public and is built only from published pages.

Documentation reused for Nix Docs must pass the sensitive-information audit. Nix Docs must not launch until the gaps disclosed in ADR-0047, ADR-0048 and ADR-0058 are closed.

## Verification required before release

- Build a fixture site that contains:
  - nested pages and a dated blog with tags and covers;
  - a future-dated post;
  - locked, trashed and excluded children;
  - an image with location metadata;
  - an unsupported embed;
  - list, gallery and chart views whose rows include an excluded item;
  - Mermaid blocks with and without a captured SVG.
- Build it in both layouts.
- Fetch the site anonymously and confirm:
  - only eligible pages, view rows and chart points appear;
  - images carry no metadata and no capability URL;
  - the feeds, sitemap and search index list exactly the published pages;
  - notices and fallbacks appear where expected.
- Rename and move an item, then confirm the redirect.
- Confirm that alias hostnames redirect with the path kept, and that shared-canonical aliases serve 200 with the canonical link.
- With `Nix:Sites:SharedAppDomain=true`, confirm that:
  - the bare apex and reserved slugs never resolve to a site;
  - no site response sets a cookie;
  - a site origin cannot obtain a token from `/auth/token`.
- Check failure and withdrawal:
  - an interrupted build never goes live;
  - rollback serves the prior build;
  - unpublishing removes the files and the host manifest;
  - automatic rebuilds stop when their principal loses manager rights.
- Confirm DNS automation against a test zone, and the manual fallback against an external zone.
- Confirm that the site origin cannot read the app's cookies and that the app's content security policy is unchanged.
