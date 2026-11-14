# Plugins and MCP

## Plugins

Nix runs plugins as signed WebAssembly components. A plugin is registered on a workspace with a declared set of capabilities, and it reacts to workspace events.

- **Declared capabilities.** A plugin can only make the host calls its installation grants. Capabilities can be changed later, and a plugin can be disabled without being removed.
- **Bounded execution.** Each run is limited in module size, memory, time and the number of host calls. The defaults are an 8 MiB module, 64 MiB of memory, 250 milliseconds and 32 host calls. A run that exceeds a limit fails visibly.
- **No database access.** Plugins run in a dedicated worker that has no database credentials. Every action a plugin takes is checked by the server like any other request.
- **Safe retries.** Duplicate events and retries do not repeat a plugin's changes.

Plugins are managed through the workspace plugins API. There is no public marketplace.

## MCP server

`nixctl mcp` starts a Model Context Protocol server over stdio, so agent tools that speak MCP can work in your workspace. It runs as you, with your profile's token, and can never reach further than you can.

Add it to an MCP client's configuration like this:

```json
{
  "mcpServers": {
    "nix": {
      "command": "nixctl",
      "args": ["--profile", "default", "mcp"]
    }
  }
}
```

Use a personal access token with only the scopes the agent needs. A `read` token cannot change anything; automations and other administrative changes need `admin`.

The server offers tools for:

- workspaces, invitations and members;
- templates: browse, preflight, capture, apply, import and export;
- document import with preview, commit and cancel;
- files: upload, replace, list versions and download;
- structures and blueprints: read, validate, describe and build;
- finance: accounts, loans, transactions, schedules, statements and budgets;
- habits: definitions, status, check-ins and undo;
- notifications, reminders and automations;
- calendar links and sync logs;
- item protection;
- the companion pet.

General item reading and editing, note bodies and search stay as `nixctl` commands. Tool inputs are validated before they reach the server, and errors carry the server's explanation, including which token scope a refused call needed.

Tool results are data. Note contents and filenames that come back from a tool never grant an agent new authority.

## Properties

- title: Plugins and MCP

