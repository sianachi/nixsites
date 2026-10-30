# Additional permissions under GNU AGPL version 3, section 7

Nix is licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`), in [LICENSE](LICENSE). As the copyright holder, Osinachi Nwagboso Samuel grants
the additional permissions below, as section 7 of that licence allows. Anyone who conveys a
modified version of Nix may remove these permissions from their version, as section 7 also allows.

## 1. Plugins

You may create, use and distribute a plugin for Nix under terms of your choice. A plugin here is a
separate WebAssembly component that Nix's plugin runtime loads and that interacts with Nix only
through the documented plugin host interface. This permission does not cover modified versions of
Nix itself, or code copied from Nix into a plugin.

## 2. Output

Content made with Nix is not a work based on Nix. This includes notes, documents, spreadsheets,
canvases, exports, `.nix` archives and published sites, and you may use and distribute it under
terms of your choice. Where such output contains parts of Nix that Nix includes automatically,
such as the scripts, styles, fonts and other assets of a published site or an exported file, you
may distribute those parts as part of that output under terms of your choice.

## 3. Programs that use Nix

For the avoidance of doubt: a separate program that talks to Nix only through its HTTP API, its
command-line tool `nixctl`, or its MCP server is not a work based on Nix and is not covered by
AGPL-3.0-only.

## Commercial licence

The copyright holder also offers Nix under a separate commercial licence, for those who cannot
accept the terms of AGPL-3.0-only.
