# MCP

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

Use a personal access token with only the scopes the agent needs. A `read` token cannot change anything; automations and other administrative changes need `admin`; a refused call says so, and the fix is a new token with that scope in Settings > Access tokens (or the change made from a signed-in session).

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

