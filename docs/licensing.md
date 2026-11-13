# Licensing

From v0.5, Nix is licensed under the [GNU Affero General Public License, version 3
only](../LICENSE) (`AGPL-3.0-only`), with the [additional
permissions](../LICENSE-ADDITIONAL-PERMISSIONS.md) for plugins, output and programs that use Nix.
Releases up to v0.4.x stay under the [MIT licence](../LICENSE-MIT-before-v0.5).

Nix is still open source. This page explains what that means for you in plain words. It is not
legal advice, and the licence text is what applies.

## Do I need to do anything?

| What you do | What AGPL asks of you |
| --- | --- |
| Use Nix for yourself, your family or your company, unmodified | Nothing |
| Self-host Nix for other people, unmodified | Nothing beyond keeping the licence notices |
| Use Nix at work, or for paid client work | Nothing: commercial use is allowed |
| Write notes, publish a site or export documents | Nothing: your content is yours, under any terms (additional permission 2) |
| Write a plugin | Nothing: plugins may use any licence (additional permission 1) |
| Script Nix through the API, `nixctl` or MCP | Nothing: those programs are separate (additional permission 3) |
| Modify Nix and let other people use it over a network | Offer those users the source of your modified version, under AGPL-3.0-only |
| Distribute a modified Nix | Ship or offer its source under AGPL-3.0-only |

## Why AGPL

AGPL keeps Nix open source while making sure that anyone who runs an improved version for others
shares those improvements. MIT allowed a hosted copy to keep its changes private.

## Commercial licence

If your organisation cannot use AGPL software, or wants to ship a modified Nix without sharing the
changes, a commercial licence is available from the copyright holder. Ask through the
[issue tracker](https://github.com/sianachi/nixsites/issues/new/choose) until a dedicated contact
is published.

## Third-party software

Nix is built on open-source libraries, fonts and models under permissive licences such as MIT, BSD,
Apache-2.0, ISC, PostgreSQL, SIL OFL and MS-PL, with one MPL-2.0 library used unmodified. Their
licence texts are in [THIRD-PARTY-NOTICES.txt](../THIRD-PARTY-NOTICES.txt), which every Nix image
and the desktop app ship, and which the web app serves at `/THIRD-PARTY-NOTICES.txt`.
`scripts/third-party-notices.mjs` generates it.

The services Nix talks to over the network are separate programs under their own licences. The
quickstart's identity provider, Zitadel, is under AGPL-3.0; Nix signs people in through OpenID
Connect and contains none of its code.

## Contributing

Outside contributions need the [contributor licence agreement](../CLA.md) before they are merged,
so that Nix can continue to offer the commercial licence. You keep your copyright. The CLA check on
your first pull request tells you how to sign, once, by comment.

## The name

The licence covers the code, not the name. Modified versions should use their own name.
