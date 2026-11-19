# What a site contains

A published site is a directory of static files. This page lists what goes into it, how each kind of content is turned into something safe to serve, and what never leaves your workspace.

## Pages

Every eligible item becomes a page at its path, as `<path>index.html`. A note's body is rendered as HTML: headings, lists, tables, callouts, columns, collapsible sections, code with highlighting, quotes and links. An item with children also lists them, drawn from its default view.

| In the workspace | On the site |
| --- | --- |
| A note body | The page's content |
| Properties | A facts block under the title (see Themes and layouts) |
| List and gallery views | Index pages of the children |
| A board view | A drawing of the board |
| A chart | An SVG chart above a table of its numbers, when every child it counts is published; otherwise the page says the chart is not published |
| Other view kinds | A list of the children's titles |
| A link to another published page | A link to that page's path |
| A link to a page that is not published | The page's name as plain text |
| A file item with no children | Not a page of its own. An image block shows it, and a file block or reference to it becomes a download link, on the pages that use it |

Anything a static page cannot show is reported in the build instead of being published silently. The build report lists, for example: sheet and canvas bodies, text colour, links whose address cannot be published, and images stored outside Nix, which are published as links. Comments always stay in the workspace.

## Images

PNG, JPEG and WebP images up to 10 MiB, and SVG images up to 2 MiB, are copied into the site. Where a page has no cover image, the build draws a 1200 by 630 link-preview card from the page title and the site's accent colour (up to 500 pages per build; the rest share the home page's card). Raster images have their metadata removed without being re-encoded, so their quality is unchanged:

- **JPEG:** EXIF, XMP, comments and other application segments are removed. Colour profiles are kept, and if the image relied on an EXIF orientation, a minimal orientation-only record is written back so it still displays the right way up.
- **PNG:** text chunks, EXIF and timestamps are removed.
- **WebP:** EXIF and XMP are removed.

Each image is stored once under its content hash, so an image used on many pages, or in many builds, is uploaded once.

## Mermaid diagrams

A Mermaid diagram is published as a picture, not as code that runs in the reader's browser. When you write or change a diagram in the editor, your browser draws it about two seconds after you stop typing and saves the drawing as an SVG file under the page, stamped with a hash of the source it was drawn from.

The SVG is sanitised twice, once when it is captured and again by the build worker. A strict parser rebuilds the document from an allowlist of elements and attributes. It rejects document type declarations and entities outright, and drops scripts, `foreignObject`, embedded images, event handlers, external references, `url()` values and `@import`. If the saved drawing does not match the diagram's current source, the build publishes the source as a code block instead of a stale picture.

## Videos

MP4 and WebM files up to 50 MiB play in a video player where a file block stands, with a download link and the size beneath it. They are checked by their file signature and published as stored, so metadata such as location is not removed. The file server answers range requests, so players can seek.

## Downloads

PDF, TXT and CSV files up to 20 MiB can be published as downloads. A PDF must really be a PDF, and text and CSV files must be valid UTF-8. Downloads are served with `Content-Disposition: attachment`, so they are saved rather than opened in the page, and a PDF is additionally sent with a sandboxing security policy.

A PDF's own document metadata, such as its author, producer, dates and embedded XMP, is not removed. Check a PDF's properties before you publish it.

## Feeds, sitemap and search

| File | Contents |
| --- | --- |
| \<collection>/feed.xml | An Atom feed for each dated collection, newest first, with tags as categories |
| sitemap.xml | Every indexable page, with its last-modified date |
| robots.txt | Allows all crawlers and points at the sitemap, or disallows everything when the site is hidden from search engines |
| 404.html | The site's not-found page, marked noindex |
| \_nix/search.json | A search index built from the rendered pages, used by the search box in the docs layout. If it would exceed 2 MiB, it falls back to titles only |
| \_nix/redirects.json | Old paths and where they now point; answered with 308 |
| \_nix/build.json | The build's identifier and an index of its files |

Each page also carries a canonical link, Open Graph and Twitter card metadata, using the page's cover image or its generated card, and links to the site's feeds.

## What a site never contains

- **Cookies.** The serving process never sets one.
- **Scripts other than the theme's.** The only script is the theme's own file, which runs the light and dark switch and the search box. Pages contain no inline scripts or styles, and the reader's theme choice is kept in the browser's local storage, not a cookie. Pages work without JavaScript. A site with the custom layout publishes its own scripts and stylesheets instead, in a sandbox; see [Security model](nix://item/01a13137-b4fc-7c7f-a661-d6f8280f80ab).
- **Third-party requests.** Fonts, styles, images and the search index all come from the site itself. There is no analytics, tracking or embedded third-party content.
- **Links back into your workspace.** References to items become links between published pages, or plain text when the target is not published.
- **Anything withheld.** Locked, trashed, excluded, template and future-dated items, and their files, are never in a build.

Every page is sent with this Content Security Policy:

```text
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
media-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'
```

together with `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: strict-origin-when-cross-origin`. SVG files get a stricter policy of their own.

## Properties

- title: What a site contains

