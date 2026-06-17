# Plugin Registration

The persona-agents plugin can be registered with OpenCode in two ways.

## Method A: Auto-Discovery (Recommended)

OpenCode automatically scans `~/.config/opencode/plugins/` for `.ts` and `.js` files and loads them as plugins.

```bash
# Create the plugins directory if it doesn't exist
mkdir -p ~/.config/opencode/plugins

# Symlink the compiled plugin
ln -sf /home/dev/persona-agents/dist/index.js ~/.config/opencode/plugins/persona-agents.js
```

After symlinking, restart OpenCode. The plugin will be loaded automatically — no config file changes needed.

To uninstall, simply remove the symlink:
```bash
rm ~/.config/opencode/plugins/persona-agents.js
```

## Method B: Explicit Registration via opencode.json

Add the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/persona-agents"]
}
```

OpenCode resolves the directory path by reading `package.json`'s `main` field → `./dist/index.js`. You can also point directly to the compiled file:

```json
{
  "plugin": ["/absolute/path/to/persona-agents/dist/index.js"]
}
```

## Verification

To verify the plugin is loaded:

1. Start OpenCode
2. Open the command palette and look for any persona-agents related entries
3. Or check OpenCode's logs for plugin loading messages

## Requirements

- Node.js 18+ (for ESM `import()` support)
- The plugin must be built (`npm run build` in the repo root) before registration
- The plugin exports a named `server` export (NOT a default export)
