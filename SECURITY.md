# Security policy

Scrapwarden controls game servers and stores credentials (RCON password, Discord token, Tebex and Steam keys), so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting instead (**Security → Report a vulnerability** in this repository).

Include what you found, how to reproduce it and the version you tested. You'll get an answer as soon as possible, and credit in the changelog if you want it.

## Supported versions

Only the latest release receives security fixes.

## Hardening tips

- Don't expose the panel directly to the Internet over plain HTTP. Use a reverse proxy with HTTPS, a VPN or an SSH tunnel.
- Enable two-factor authentication for every admin.
- Don't open the RCON port (28016) to the Internet; the panel connects to it locally.
- Only install plugins you trust: they are C# code running on your server.
