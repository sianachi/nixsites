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

## Contributing

Outside contributions will need a contributor licence agreement before they are merged, so that
Nix can continue to offer the commercial licence. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## The name

The licence covers the code, not the name. Modified versions should use their own name.
