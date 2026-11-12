# Changelog

## 1.0.0-beta.1

First public beta.

- OxidianBridge 1.6.2: fixes a compile error on current Rust builds (`PlayerMetabolism.SendChangesToClient` was removed). The panel updates the plugin automatically.

- Installer for SteamCMD, Rust, Oxide and Carbon (Windows and Linux) with progress.
- Import an existing server on the same machine (reads its start script and `server.cfg`) and attach to it if it's already running.
- Remote mode: manage a rented server over RCON, with optional FTP/FTPS/SFTP access to manage plugins and upload the companion plugin automatically.
- Dashboard, live console, chat history and messaging, players, teams and inventories.
- Live map with roads, rails, rivers, power lines, monuments, events and a legend.
- Moderation: notes, warnings with automatic sanctions, timed mutes and temp bans, word filter.
- Watch: cheat alerts, Steam profile checks (including recent game bans), ban evasion and shared IP detection.
- Shared bans: Oxidian serves Rust's official Centralized Banning API (works on vanilla), with a secret key per server and optional external lists in alert or block mode.
- VPN, proxy, hosting-IP and country detection (proxycheck.io or ip-api.com) with alert or kick.
- F7 report tickets, in-game staff menu (`/staff`) and VIP with expiry and queue priority.
- Tebex store delivery without the Tebex plugin.
- Rates, PvP/PvE, time, weather and events.
- Scheduled restarts, backups and a wipe planner aware of the Facepunch forced wipe.
- Statistics, startup diagnostics and performance alerts.
- Two-way Discord bot and a public server page.
- Multiple admins with roles, two-factor authentication and an activity log.
- English, Spanish, Portuguese and French, with a built-in wiki.
- Update notifications from GitHub releases (can be turned off).
- Project website (GitHub Pages) in English and Spanish.
- **Report a bug** button that opens a GitHub issue with the technical details pre-filled.
