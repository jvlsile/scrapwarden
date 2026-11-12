# Contributing to Scrapwarden

Thanks for helping! Bug reports, translations, ideas and pull requests are all welcome.

## Reporting bugs

Open an issue with the **Bug report** template. Include your OS, framework (vanilla / Oxide / Carbon), Scrapwarden version and the relevant log lines. **Remove passwords, tokens, IPs and SteamIDs** before pasting anything.

For security problems, do **not** open a public issue: see [SECURITY.md](SECURITY.md).

## Development setup

```bash
npm install
npm start          # http://localhost:8080
```

There is no build step: the backend is plain Node.js (Express + ws) and the frontend is plain HTML/CSS/JS in `public/`.

Project layout:

- `server.js`: REST API, WebSocket and the permission table (`ACL`)
- `lib/`: one module per feature (`rcon.js`, `watch.js`, `tickets.js`, `store.js`…)
- `lib/bridge/ScrapwardenBridge.cs`: the Oxide/Carbon companion plugin (bump its `[Info]` version when you change it; the panel auto-updates installed copies)
- `public/`: the panel UI, the public page (`server.html`) and translations (`i18n/`)

## Guidelines

- **Every user-facing text goes through i18n.** The backend sends codes (`E('code')`, `L('key')`) and the UI translates them. Add new keys to **every** file in `public/i18n/` and run `node tools/check-i18n.js`.
- **New API routes need an entry in the `ACL` table** in `server.js`, with the right permission and an audit action name. Specific `GET` rules must go before the catch-all.
- **Never send secrets to the browser** (tokens, API keys, RCON password). Return a hint like `••••1234` instead.
- **The public page must never expose** player positions, IPs, SteamIDs or moderation data.
- Keep dependencies to a minimum. The panel should keep working offline (fonts are bundled).
- Update the wiki section (`wiki` array in the i18n files) when a feature changes.

## Translations

Copy `public/i18n/en.json` to `public/i18n/<code>.json`, set `meta.code` and `meta.name`, translate `strings` and `wiki`, and run `node tools/check-i18n.js`. Messages shown in the Rust chat use Unity rich text (`<color=#…>`); keep those tags.

## Pull requests

Keep them focused on one change, describe how you tested it, and make sure `node tools/check-i18n.js` passes. By contributing you agree that your contribution is licensed under the MIT License.

## Releasing (maintainers)

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. If `lib/bridge/ScrapwardenBridge.cs` changed, bump its `[Info]` version too.
3. Create a GitHub release tagged `vX.Y.Z` (or `vX.Y.Z-beta.N` with **Set as a pre-release** ticked) and attach a zip without `node_modules`, `data`, `server`, `steamcmd` or `backups`. Running panels will show the update notice within 6 hours. Stable versions are only notified about stable releases; beta versions are notified about both.
