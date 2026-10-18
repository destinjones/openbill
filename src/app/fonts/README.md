# Fonts

OpenBill's page uses IBM Plex Sans (400 and 600) and IBM Plex Mono (400), latin subset, as
WOFF2. `build.js` inlines them as `data:` URIs, so the page loads nothing at runtime. They are
committed here so a build never touches the network.

Licence: SIL Open Font License 1.1 ([OFL.txt](OFL.txt)). The licence text is the `LICENSE` file
of the same @fontsource packages, version 5.3.0, whose `package.json` gives `"license": "OFL-1.1"`.
The two packages' licence files differ only in their copyright line; `OFL.txt` keeps both
copyright lines above the shared licence text.

Downloaded on 2026-10-17 from the @fontsource packages on jsDelivr, pinned to version 5.3.0
(published 2026-07-19, per `npm view @fontsource/ibm-plex-sans time`):

| file | source URL | sha256 | bytes |
|---|---|---|---|
| `ibm-plex-sans-latin-400-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans@5.3.0/files/ibm-plex-sans-latin-400-normal.woff2 | `3b646991d30055a93a4ecc499713d4347953a74a947ecab435ab72070cbdab0e` | 22,588 |
| `ibm-plex-sans-latin-600-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans@5.3.0/files/ibm-plex-sans-latin-600-normal.woff2 | `8960851d691c054ed38e259bdcf1a6190d157b4203ed5bb32c632a863fb8ec2f` | 24,252 |
| `ibm-plex-mono-latin-400-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.3.0/files/ibm-plex-mono-latin-400-normal.woff2 | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` | 14,708 |

Licence files read from the same packages:

| file | sha256 |
|---|---|
| https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-sans@5.3.0/LICENSE | `d0283623ef57e722fd0eb688a8041589670c608ab780cd3612d06ba6f153d3fd` |
| https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.3.0/LICENSE | `23b0a9d0c6d3f140a0b77e483c5cfa6bba574325ef5cb189ed9f2fec4884533f` |

To check a file: `sha256sum src/app/fonts/*.woff2`. To update, download the same paths at a
newer pinned version, check the licence is still OFL-1.1, and update this table.
