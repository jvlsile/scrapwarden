# Third-party notices

This project includes or depends on the following third-party software. Each keeps its own license.

## Bundled in this repository

| Component | Location | License |
|---|---|---|
| Barlow / Barlow Condensed (fonts) | `public/fonts/` | SIL Open Font License 1.1 — see `public/fonts/OFL-Barlow.txt` |
| JetBrains Mono (font) | `public/fonts/` | SIL Open Font License 1.1 — see `public/fonts/OFL-JetBrainsMono.txt` |
| Same fonts for the website | `docs/assets/fonts/` | SIL Open Font License 1.1 — see the `OFL-*.txt` files there |

## npm dependencies (installed with `npm install`)

| Package | License |
|---|---|
| express | MIT |
| ws | MIT |
| adm-zip | MIT |
| qrcode | MIT |
| basic-ftp | MIT |
| ssh2-sftp-client | Apache-2.0 |
| ssh2 (via ssh2-sftp-client) | MIT |

Transitive dependencies use MIT, ISC, BSD-3-Clause (`qs`, `bcrypt-pbkdf`) and Unlicense (`tweetnacl`), all compatible with this project's MIT license. The full list is in `package-lock.json`; run `npx license-checker --production --summary` to review it.

## Services and assets used at runtime (not included)

- **SteamCMD** and the **Rust Dedicated Server** are downloaded from Valve/Facepunch by the user and are subject to their own terms.
- **Oxide (uMod)** and **Carbon** are downloaded from their official sources and keep their own licenses.
- **Item icons** shown in the inventory viewer are loaded from external websites (by default Facepunch's official item images, with rustlabs.com as a fallback). They are not distributed with this project and remain the property of their owners.

## Trademarks

Rust is a trademark of Facepunch Studios Ltd. This project is an independent, community-made tool and is not affiliated with, endorsed or sponsored by Facepunch Studios, Valve, uMod or Carbon.
