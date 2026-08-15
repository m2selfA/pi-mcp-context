# pi-mcp-context

A companion Pi extension package for [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter).
It injects cached MCP server metadata into the current prompt without opening a second MCP connection or duplicating OAuth handling.

This repository uses Pi's supported multi-file extension layout: the TypeScript entrypoint lives at `src/index.ts`, and `package.json` declares it under `pi.extensions`. Pi loads the TypeScript source directly, so there is no build directory to commit.

## Install

For a published GitHub repository, install the package from its Git ref and keep the adapter installed separately:

```powershell
pi install npm:pi-mcp-adapter
pi install git:github.com/<owner>/pi-mcp-context
```

For local development, install the two Pi packages separately. The adapter is the MCP runtime; this package is only its context-injection companion:

```powershell
pi install npm:pi-mcp-adapter
cd .\\pi-mcp-context
npm install --no-package-lock
cd ..
pi install .\\pi-mcp-context
```

For a project-local installation, use `-l` on the last command:

```powershell
pi install -l .\\pi-mcp-context
```

`pi install` records a local path but does not make dependencies from another Pi package root visible to Node. The `npm install --no-package-lock` step inside `pi-mcp-context` is required; it creates `pi-mcp-context/node_modules/pi-mcp-adapter`.

The package bundles the adapter module for its own imports, but only `./src/index.ts` is registered in this package's `pi.extensions`. The adapter extension itself must still be installed separately as shown above.

The adapter remains responsible for MCP configuration, connections, authentication, lazy lifecycle, and actual tool calls.

## Usage

With a server named `github` already managed by `pi-mcp-adapter`:

```text
Use #github to find the issue related to this error.
```

`#github` is expanded in the submitted user message. The expansion contains a bounded `<mcp-context>` block with:

- the server name and adapter status;
- cached server instructions;
- tool names and descriptions;
- cached resources and prompts;
- a reminder to use the existing `mcp` proxy for live discovery and calls.

The editor also provides `#` completion for known server names. Pi's existing `@` file/path completion remains untouched.

The slash form is useful when the whole prompt should be prepared from a server context:

```text
/mcp:github
/mcp:github find the open authentication issues
/mcp:github --schemas
/mcp:select
```

Typing `/mcp:` provides server-name completion. `/mcp:select` opens a server picker when a TUI is available. Slash commands put the generated context into the editor so it can be reviewed and submitted; they do not silently send a new prompt.

Schemas are intentionally omitted by default to preserve the context savings of the adapter's proxy mode. Use `--schemas` only when the complete cached input shapes are useful.

## Cache behavior

The extension reads the metadata cache written by `pi-mcp-adapter` (`mcp-cache.json`) and subscribes to its public `pi-mcp-adapter/status/v1` event. It never creates an MCP client and never calls a server directly.

If a server has no local cache entry, the injected block tells the model to use one of these adapter operations:

```text
mcp({ server: "github" })
mcp({ search: "...", server: "github" })
```

The cache can be overridden for unusual Pi distributions with:

```text
PI_MCP_CONTEXT_CACHE_PATH=/path/to/mcp-cache.json
```

Cached instructions and tool descriptions are treated as metadata and XML-escaped before insertion. The generated block is capped at 12,000 characters; the `mcp` proxy remains the source of truth for current data.

## Development

```bash
npm install --no-package-lock
npm run check
```

## Repository layout

- `src/index.ts` - Pi extension entrypoint and lifecycle wiring.
- `src/context.ts` - cache loading, server aliases, mention expansion, and context rendering.
- `src/context.test.ts` - focused unit tests for the pure context helpers.
- `package.json` - Pi package manifest, runtime dependency declarations, and checks.
- `.gitignore` - keeps local dependencies, `package-lock.json`, and generated output out of Git.
- `.github/workflows/check.yml` - runs the same checks on pushes and pull requests.

The repository intentionally does not track `node_modules/` or `package-lock.json`. Use `npm install --no-package-lock` for local setup; Pi installs the declared runtime dependencies when the package is installed from npm or Git.

## Scope

This extension injects server context and metadata. It does not inject an arbitrary MCP tool result or read a resource body from a `#mention`, because those operations are not exposed as public direct APIs by `pi-mcp-adapter`. The model still performs live MCP calls through the adapter's existing proxy or direct tools.
