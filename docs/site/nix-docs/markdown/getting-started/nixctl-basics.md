# nixctl basics

`nixctl` is the scriptable way into a Nix workspace. It covers items, notes, canvases, properties, views, queries, search, templates, history, imports and exports, files, calendar sync, habits, reminders, automations, sites and the companion. It also runs an [MCP server](nix://item/01a130b0-0e54-747b-b923-fd3b58a5891c).

Output is compact JSON when piped and a readable table or pretty JSON on a terminal. `--json` forces the machine-readable shape everywhere. Errors go to stderr with an exit code a script can branch on.

## Run it

`nixctl` is part of the Nix repository and runs on Node 22 or later. From a checkout:

```sh
pnpm --filter @nix/cli exec node --experimental-strip-types src/index.ts --help
```

An alias keeps the examples below short:

```sh
alias nixctl='pnpm --dir /path/to/Nix --filter @nix/cli exec node --experimental-strip-types src/index.ts'
```

## Sign in

The default sign-in opens your browser, where you approve a renewable CLI session:

```sh
nixctl auth login --api-url https://<your-domain>
nixctl auth status
nixctl auth logout
```

`auth logout` revokes a browser-approved session and removes its local profile.

Use `--no-browser` to print the approval link instead of opening it. For scripts and servers, sign in with a personal access token:

```sh
nixctl auth login --api-url https://<your-domain> --token "$NIX_TOKEN"
```

Create tokens in the web app under **Settings > Access tokens**. Each token has independent `read`, `write` and `admin` scopes and a required expiry between 1 and 365 days. Use the narrowest scopes that do the job.

To replace a token's secret without making a new token, rotate it in the same list or run `nixctl token rotate <token-id>`. The old secret stops working at once, and local profiles that used it are updated. Rotating needs a browser sign-in, not a token.

Profiles live in `~/.config/nixctl/config.json` (or under `$XDG_CONFIG_HOME`) with restrictive file permissions. `--profile <name>` selects one of several saved profiles.

## Find your way around

```sh
nixctl ws list
nixctl item ls --workspace <workspace-id>
nixctl item ls --workspace <workspace-id> --parent <item-id>
nixctl item get <item-id>
nixctl search "quarterly review" --limit 10
```

## Create and edit

```sh
nixctl item create --workspace <workspace-id> --title "Reading list" --parent <item-id>
nixctl item edit <item-id> --workspace <workspace-id> --title "Books to read"
nixctl item mv <item-id> --workspace <workspace-id> --parent <new-parent-id>
nixctl item rm <item-id> --workspace <workspace-id>
nixctl item restore <item-id> --workspace <workspace-id>
```

Note bodies read and write as Markdown:

```sh
nixctl note read <item-id> --raw > note.md
nixctl note write <item-id> --file note.md
```

Conversion reports anything Markdown cannot represent rather than dropping it silently.

## Properties, views and queries

```sh
nixctl schema get <container-id>
nixctl props set <item-id> status=Active budget=1200
nixctl views get <container-id>
nixctl query <container-id> --view <view-id> --today 2026-10-11
```

Values are read as JSON when they parse and as text otherwise. `--today` gives relative filters such as "this week" your own day.

## History

```sh
nixctl history list <item-id>
nixctl history show <item-id> <seq> --markdown
nixctl history name <item-id> <seq> "Before the rewrite"
nixctl history restore <item-id> <seq> --yes
```

A restore adds a new revision; it never deletes history.

## Import and export

```sh
nixctl import ./notes --workspace <workspace-id> --dry-run
nixctl import ./notes --workspace <workspace-id> --parent <item-id>
nixctl export <item-id> --format nix --scope subtree -o backup.nix
```

Exports are downloaded through a short-lived link and checked against their length and SHA-256 before the file is written.

## Reminders and automations

```sh
nixctl remind set <item-id> +2h
nixctl remind set <item-id> "2026-11-01 09:00" --zone Europe/London
nixctl automations list --workspace <workspace-id>
nixctl automations test <rule-id>
```

## MCP

`nixctl mcp` serves Nix as an MCP server. On its own it speaks over stdio and acts as your current profile. With `--listen <host:port>` it serves Streamable HTTP instead, and every request carries its own personal access token. The tools it offers are described under [MCP](nix://item/01a130b0-0e54-747b-b923-fd3b58a5891c).

Run `nixctl <command> --help` for the full set of options.

## Properties

- title: nixctl basics

