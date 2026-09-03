# Optional: full MAC vendor (OUI) database

IP Scanner ships with a curated set of common vendor prefixes in
[`../data/oui.json`](../data/oui.json), which covers most consumer and
enterprise hardware you'll meet on a LAN. For exhaustive coverage you can drop
the full IEEE registry here and IP Scanner will load it automatically on top of
the curated set.

Either format works:

- **`resources/oui-full.txt`** — the raw IEEE registry. Download from
  <https://standards-oui.ieee.org/oui/oui.txt> and save it here as-is.
- **`resources/oui-full.json`** — a `{ "AABBCC": "Vendor name" }` map, if you
  prefer to preprocess it.

These files are git-ignored (they are several MB). When present they are
bundled into the packaged app via the `extraResources` entry in
`package.json` and picked up by `src/main/oui.js` at runtime.
