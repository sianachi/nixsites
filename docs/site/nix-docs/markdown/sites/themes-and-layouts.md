# Themes and layouts

The built-in Nix theme has two layouts, Docs and Blog, and you choose an accent colour and a few style options; the theme does the rest. A third layout, Custom, lets you replace the theme with your own. Built-in pages are plain HTML and CSS, readable without JavaScript, and set in a typeface served from the site itself.

## Shared by both layouts

- **A header** with the site name, your top navigation links and a light and dark switch. The switch follows the reader's system setting until they choose, and remembers the choice in the browser. It appears only once the theme script has loaded.
- **A footer** with your footer text, links to the site's feeds, and a "Built with Nix" link unless you turn it off.
- **A facts block** under each page title. A page's properties are shown as a short list of labelled values, using the labels and types from the schema that applies to the page. Some things are never shown: the title, system properties, people, reminders, formulas and rollups, images, the date, tags, cover and summary a dated collection already uses, and empty values. A `subtitle` property is shown as the page's lead paragraph instead.
- **Dated collections:** an index grouped by year, a page for each tag, and an Atom feed.
- **Code blocks** with syntax highlighting.
- **A 404 page**, canonical links and social preview metadata.

## Docs

For documentation, handbooks and knowledge bases.

- The home page opens with the site name, the description and a map of the whole site, followed by the root page's own content.
- Every page has a sidebar with the full page tree. On a phone, the tree folds into a "Browse" menu at the top of the page.
- Breadcrumbs above the title, and an "On this page" table of contents from the page's headings, each of which has an anchor link.
- A page with children ends with "In this section" cards for them.
- Previous and next links follow the order of the tree.
- A search box in the header searches every published page, entirely in the reader's browser, from an index built with the site. Press `/` to focus it.

## Blog

For a personal site, a portfolio or a blog.

- The home page introduces the site, then gives each top-level page that has children a section of its own: the latest five entries of a dated collection, or cards for the page's children.
- Posts show their date, an estimated reading time, tags and cover image, with older and newer links.
- Everything else is a plain page.
- The blog layout has no search box.

## Custom

For a site that should not look like either built-in layout. The site is rendered from files attached to a theme page: a page inside the site, not its root, that is never published itself. Attach the files to that page, with these names (letters, digits, `.`, `_` and `-`, up to 80 characters):

- `layout.liquid` wraps every page. It receives `nix.body` and either `nix.head` (page metadata, your own CSS and JS, and the built-in stylesheet and script) or `nix.seo` (the same without the built-in ones, for a theme that styles everything itself).
- `home.liquid`, `page.liquid`, `post.liquid`, `collection.liquid`, `tag.liquid` and `404.liquid` replace the body of that kind of page. A template you leave out falls back to the built-in body, so a theme can start with a home page alone.
- **Any other **`.liquid` file is a partial, used with `{% render "name" %}`.
- `.css` and `.js` files are published with the site and linked from the page head. Images attached to the theme page are published as ordinary images.

Templates are Liquid. Output is escaped unless you write `| raw`. Templates read `site` (name, description, accent, navigation, footer, home and every page) and `page` (title, path, properties, date, summary, tags, content, children and, for a collection, its entries). Filters include `file_url` for a file property, `theme_url` for one of the theme's own files and `date_label`. A template error fails the build and names the line, so nothing half-rendered goes live.

To use it, set the layout to Custom in the site settings and give the theme page, or run `nixctl site update <site-id> --layout custom --theme <page-id>`. Custom sites are served in a sandbox so their scripts cannot reach the app; see [Security model](nix://item/01a13137-b4fc-7c7f-a661-d6f8280f80ab).

## Accent colour and style

The accent colour, given as `#rrggbb`, is used for links and highlights in both light and dark mode. Three more choices apply to the built-in layouts:

- **Typeface:** rounded (Nunito Sans), book serif (Literata) or hyperlegible (Atkinson Hyperlegible Next). All are served from the site itself.
- **Heading mark:** the shape before section headings, cards and the site name: square, diamond or none.
- **Spacing:** compact, comfortable or airy. The site name, description, navigation and footer text are all site settings; see [Managing a site](nix://item/01a13137-b778-7f7e-9a3a-bd1413c167bf).

## Properties

- title: Themes and layouts

