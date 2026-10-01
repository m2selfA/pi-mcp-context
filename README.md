# pi-mcp-context

A Pi-native context extension for Pi's builtin MCP runtime.

Pi's builtin `mcp`, `codemode`, and `tool_search` extensions own MCP connections, authentication, discovery, and tool calls. This package only provides:

- `#server` mention expansion;
- `#` and `/mcp:` autocomplete;
- `/mcp:<server>` and `/mcp:select` commands;
- short or explicit Pi-native MCP context hints.

It does **not** create an MCP client, maintain a metadata cache, report adapter-style server status, or provide an `mcp({ ... })` proxy.

## Install

Install this extension alongside Pi. Do not install `pi-mcp-adapter` for this package:

```powershell
pi install git:github.com/m2selfA/pi-mcp-context
```

For local development:

```powershell
cd .\pi-mcp-context
npm install --no-package-lock
pi install .\pi-mcp-context
```

For a project-local installation, use `-l`:

```powershell
pi install -l .\pi-mcp-context
```

Pi 0.99+ provides the runtime dependencies through the builtin extensions. The package has no runtime MCP dependency and does not bundle another MCP implementation.

## Configure builtin MCP

Configure servers in Pi's `~/.pi/agent/mcp.json` or a trusted project `.pi/mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://example.com/mcp",
      "exposure": "deferred",
      "timeout": 90
    },
    "docs": {
      "command": "npx",
      "args": ["-y", "docs-mcp"],
      "exposure": "codemode"
    }
  }
}
```

Use `exposure: "deferred"` when `tool_search` should load matching tools for the next model call. Use `exposure: "codemode"` when the model should discover and call tools from JavaScript through `searchTools()` and `tools.<qualified_name>()`. Use `direct` only for a small set of tools that should always be declared.

Pi's builtin MCP extension automatically activates `codemode` for `codemode` servers and `tool_search` for `deferred` servers. They can also be enabled explicitly:

```json
{
  "defaultTools": ["+codemode", "+tool_search"]
}
```

Use `/mcp` for builtin connection, OAuth, and configuration diagnostics.

## Usage

With a visible builtin MCP namespace named `github`:

```text
Use #github to find the issue related to this error.
```

The default expansion is intentionally short:

```text
<use-mcp server="github" namespace="mcp__github" exposure="deferred">
Use the Pi-native MCP namespace "mcp__github" for this task.
Inside codemode, discover matching tools with searchTools("...", { namespace: "mcp__github" })
or inspect the namespace with describeNamespace("mcp__github").
Call a selected tool with tools.mcp__server__tool(args), replacing it with the qualified name; for example tools.mcp__github__search_code({...}).
This namespace uses deferred exposure; tool_search can load matching tools for the next model call.
</use-mcp>
```

The context extension deliberately does not claim that a server is connected, authenticated, cached, or disabled. When no tool metadata is currently registered, use `/mcp` and then retry discovery.

### Mention forms

| Form | Expansion | Use when |
|------|-----------|----------|
| `#server` | Short discovery hint | Cheapest default; points at builtin discovery APIs |
| `#server -t` / `#server --tools` | Short hint plus qualified tool names | Target tools without injecting descriptions or schemas |
| `#server -f` / `#server --full` | Full current namespace metadata | Explicitly request descriptions and instructions |
| `#server --schemas` | Full metadata plus input schemas | Explicitly request schemas |

`--full`/`-f` wins over `-t`/`--tools`. Schemas are never injected by default.

### Slash commands

```text
/mcp:github
/mcp:github find open authentication issues
/mcp:github --schemas
/mcp:select
```

`/mcp:<server>` prepares the current namespace context in the editor for review. `/mcp:select` opens a selector when a TUI is available. These commands do not create connections or silently call MCP tools.

The editor provides `#` and `/mcp:` completion. Pi's existing `@` file/path completion remains untouched.

## Native inventory model

The extension builds its index from two Pi-native sources:

1. `pi.getAllTools()` for registered MCP tool names, descriptions, schemas, exposures, and namespaces;
2. the structured `mcp_servers` section supplied to `before_agent_start` for namespaces that Pi knows about before their tools are registered.

A namespace without registered tools is retained as a discovery hint, not reported as a connection failure or success. Tool names are kept fully qualified (`mcp__server__tool`) so equal short names from different servers remain distinct.

## Development

```powershell
npm install --no-package-lock
npm run check
```

## Repository layout

- `src/index.ts` - Pi extension lifecycle, native inventory refresh, commands, and autocomplete.
- `src/context.ts` - native snapshot parsing, mention expansion, aliases, and rendering.
- `src/context.test.ts` - unit tests for disconnected/auth-unknown namespaces, collisions, exposure modes, and prompt-size behavior.
- `package.json` - Pi package manifest and builtin-Pi peer/dev dependencies.

## Scope and limitations

- This package does not read `mcp-cache.json`.
- This package does not subscribe to `pi-mcp-adapter` events.
- This package does not parse or own MCP credentials.
- It cannot infer live connection/authentication status from the public Pi extension APIs; `/mcp` remains the diagnostic surface.
- Resource bodies and prompt results are not fetched by a mention. Use Pi's builtin MCP resource/prompt tools when available.
