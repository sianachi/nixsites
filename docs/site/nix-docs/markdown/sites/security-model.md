# Security model

Publishing a website from a private workspace means putting a public, anonymous surface next to private data. Sites is built so that the public side cannot reach the private side at all, and so that a site's content cannot be turned against the app or its readers.

## Static output, built ahead of time

A site is a set of files produced once, at publish time. A reader's request never runs a query, never reaches Core and never touches the database. There is no anonymous path from the internet into workspace data: the only thing a reader can fetch is a file that a manager chose to publish.

What goes into a build is decided by Core, inside the publisher's own session, with the same row-level security and permission checks as any other read. Locked, trashed, excluded and template items are filtered out while the pages are selected, not afterwards.

## Separate processes with separate powers

| Process | Can | Cannot |
| --- | --- | --- |
| Core | Decide what is eligible, freeze the build manifest, sign each upload and each host manifest | Serve sites |
| Sites worker | Read the manifest and bodies for its one job, upload to the exact keys Core signed | Choose a storage key, read files outside the manifest, or reach the database |
| Sites serve | Read the sites bucket and answer GET and HEAD requests | Call Core, read the database, or hold any Core secret |

The worker's credential for a build is tied to that build's job, and every upload is a create-only signed request bound to the file's size and checksum, so the worker can only write the files Core signed for that build, and cannot replace a file that already exists. On Kubernetes, the storage job gives the serving process its own read-only account on the sites bucket, and its network policy lets it reach only the object store, HTTPS and DNS. Use a key that can only read the sites bucket on any deployment where your object store supports one.

## No cookies, no third-party scripts

The serving process never sets a cookie. Pages load scripts, styles, fonts and images only from the site itself, under a strict Content Security Policy that also forbids framing, forms and `<base>` changes. The only script is the theme's own. (A site with the custom layout is the exception, described below.) Uploaded SVG is rebuilt from an allowlist, so a diagram cannot carry script. See [What a site contains](nix://item/01a13137-b0dd-7495-a74f-26da5fa62cc3).

## Keeping sites away from the app

User content must never share an origin with the app, or a page could read the app's cookies or act as the signed-in user. By default, Core refuses to start if the sites domain is the app's host, a subdomain of it, a parent of it, or shares its registrable domain.

An operator can choose to serve sites one label below the app's own host, as `<slug>.<your-domain>`, by setting `Nix:Sites:SharedAppDomain`. The Kubernetes manifests do this. Only that exact arrangement is accepted, and it comes with these protections:

- the app's session and sign-in cookies use the `__Host-` prefix, so the browser keeps them on the app's exact host and never sends them to a site;
- the sites server refuses to answer for the app's own host;
- infrastructure names such as `www`, `api`, `auth`, `admin`, `mail`, `status` and `sites` can never be claimed as slugs.

## The custom layout

A site with the `custom` layout runs JavaScript its owner wrote, so its pages are served differently. Each page carries a Content Security Policy `sandbox` directive that allows scripts, popups and downloads but not `allow-same-origin`. The page runs in an opaque origin: its script cannot read the cookies, storage or credentials of any other site on the same domain, including the app. Scripts, styles and fonts still load only from the site itself, forms and framing stay forbidden, and inline styles and `data:` images and fonts are allowed. Because the opaque origin makes the browser ask for the site's own files with CORS, those responses carry `Access-Control-Allow-Origin: *`. A site's files are public anyway, so this exposes nothing new.

## Reserved slugs and hostnames

Slugs that look like infrastructure are reserved everywhere. An operator can reserve further slugs for named workspaces, so a project's own name cannot be taken by someone else. A custom hostname is served only after its TXT record proves control of the name, is re-checked every six hours, and stops being served after repeated failures.

## Operator approval

An instance can require an operator to approve each site's first publish, and the first publish after an unpublish. The Kubernetes manifests turn this on by default. Operators are the people the instance names as site operators, plus any approvers an administrator grants in Settings; when none are named or granted, they are the instance's administrators. Approving runs the publish as the manager who asked, after checking again that they are still a manager. After that, the managers publish changes themselves.

## Accountability

Creating, changing, publishing, rolling back, unpublishing and deleting a site, approval decisions, and hostname and path changes are all written to the audit log. The first publish asks the manager to confirm that the content will be public and may be copied. Unpublishing takes the site down and deletes its builds, but cannot recall copies others have made.

## Properties

- title: Security model

