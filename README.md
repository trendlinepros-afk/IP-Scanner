# IP Scanner — Network Toolkit

**A complete, open network testing suite** — speed tests, WiFi analysis,
latency monitoring, LAN throughput, DNS benchmarking, device discovery and more,
behind a card-based home page. Ships as a Windows **installer *and* a portable
executable**, and the installed version can **check for, download and install
its own updates**.

> Built with Electron. Cross-platform code (Windows / macOS / Linux); the
> primary distributable target is Windows.

---

## Tools

A launcher home page opens first; each card opens a full tool:

| Tool | What it does | Modeled on |
|---|---|---|
| **⚡ Speed Test** | Internet **download / upload / ping / jitter / loss** on a live gauge, measured against Cloudflare's global network. Labels whether you're on WiFi or Ethernet so you can compare. | Ookla / Cloudflare speed test |
| **🩺 Connection Quality** | **Bufferbloat** (latency-under-load, graded A+–F) and a **VoIP MOS** call-quality score from latency/jitter/loss — explains "fast speedtest but laggy calls". | Waveform / DSLReports bufferbloat |
| **🚀 LAN Speed Test** | iPerf-style TCP **throughput between two machines** (multi-stream). Run the built-in server on one PC, the client on another — compare WiFi vs Ethernet on your own LAN. | iPerf3 |
| **📶 WiFi Analyzer** | Nearby APs with **SSID, BSSID, signal (dBm), band, channel, security, PHY**, current-link quality, band breakdown and a **channel-congestion graph** with a best-channel recommendation. | inSSIDer / NetSpot |
| **📶 WiFi Signal Meter** | Big live dBm readout + graph you watch while walking a site to find dead spots; records min/max/avg. | WiFi signal apps |
| **ℹ️ Network Info** | Adapters, default gateway, DNS servers, and **public IP / ISP / geo**. | — |
| **🖧 IP Scanner** | Multithreaded LAN discovery: status, name, **IP, MAC, manufacturer (OUI)**, shared resources; right-click **RDP / SSH / Telnet / WoL / shares**; CSV/HTML/XML/JSON export. | Advanced IP Scanner |
| **📡 Ping Monitor** | Continuous latency with a **live graph**, min/avg/max, **jitter and packet loss**. | PingPlotter / MTR |
| **🧭 Traceroute** | Live **hop-by-hop path** with per-hop latency and loss. | traceroute / WinMTR |
| **🧩 DNS Benchmark** | Ranks public resolvers (Cloudflare, Google, Quad9, …) **and your system DNS** by response time. | DNS Benchmark / namebench |
| **🔓 Port Scanner** | Scan TCP ports on a host and identify running services. | nmap (connect scan) |

All engines are pure Node (no native modules) and stream results live. Some
OS-integration bits (WiFi scan, RDP, `net view` shares, remote shutdown,
NetBIOS names) are platform-specific and degrade gracefully where unavailable.

**Auto-update:** Built-in **Check for Updates** → downloads in the background →
**Restart & Install / Later** prompt (installed build only).

---

## Clients & PDF reports

The app opens to a **Clients** screen — create and manage a client for each
site or customer. Pick a client and every diagnostic you run is **saved to that
client**, timestamped, under your Documents folder:

```
<Documents>/IP Scanner/Clients/<Client Name>/
    client.json      # client details
    history.json     # every saved test, with the date/time it ran
    reports/         # generated PDF reports
```

From a client's dashboard:

- **▶ Auto Run All Tools** — runs every diagnostic once, back-to-back, saving a
  timestamped result for each, then builds and opens a PDF report. Continuous
  tools are time-boxed: the ping monitor pings `8.8.8.8` for 10 seconds and
  records **best / worst / average** latency and loss; the network scan is
  bounded too. Great for a one-click site health check.
- **🕑 History** — every recorded test with its date/time; delete individual
  runs or clear all.
- **📄 Generate PDF Report** — a clean, **printable PDF** grouping all tests by
  type, each run stamped with when it ran. Speed tests (and LAN, ping, DNS,
  traceroute, WiFi, port and network scans) are laid out in tables so you can
  see trends over time. The PDF is saved under the client's `reports/` folder
  and opened automatically (print from your PDF viewer). Reports are rendered
  with Electron's built-in `printToPDF` — no external tools required.
  - A **health summary** at the top grades key metrics green / amber / red and
    shows **change-since-last-visit** deltas. Speed is graded against the
    client's **expected plan speed** (set it in the client's details).
- **📁** opens the client's folder; **✎** edits client details.

---

## Two ways to run it

electron-builder produces both from one codebase:

1. **Installer** — `IP Scanner-Setup-<version>.exe` (NSIS). Lets the user pick the
   install folder, adds Start-menu / desktop shortcuts and an uninstaller. The
   installed app has **auto-update enabled**.
2. **Portable** — `IP Scanner-Portable-<version>.exe`. A single file you can run
   from anywhere (a USB stick, say) with no installation. Auto-update is
   intentionally disabled here; the app shows a note directing you to the
   installed version.

---

## How the "Check for Updates" flow works

The installed application updates itself from **GitHub Releases** via
[`electron-updater`](https://www.electron.build/auto-update):

1. Click the **⭯ Check for updates** button (toolbar) or **Tools → Check for
   Updates…**.
2. IP Scanner queries the latest GitHub Release for this repo.
3. If a newer version exists it downloads in the background with a live
   progress bar.
4. When the download finishes you get a dialog:
   **"Restart & Install"** or **"Later"**.
   - *Restart & Install* quits, runs the update and relaunches.
   - *Later* keeps the downloaded update; it installs on the next quit.

There's also an optional silent check at startup (toggle in **Settings**).

To ship an update you just publish a new release (see below) — every installed
client picks it up.

---

## Development

```bash
npm install          # install dependencies
npm run dev          # launch IP Scanner with dev tools
npm run lint         # byte-compile all JS + validate JSON assets
```

The scanning engine is plain Node (no native modules), so it also runs in dev
on Linux/macOS — handy for hacking on the UI. Some OS-integration tools
(RDP via `mstsc`, `net view` share enumeration, remote shutdown, NetBIOS names)
are Windows-only and degrade gracefully elsewhere.

### Project layout

```
src/
  main/         Electron main process + scanning engine
    main.js       window, menu, IPC wiring, lifecycle
    scanner.js    scan orchestrator (events: start/progress/host/done)
    network.js    interface discovery + IPv4 range/CIDR math
    ping.js       ICMP + TCP host liveness
    arp.js        ARP cache → MAC addresses
    oui.js        MAC → manufacturer lookup
    resolve.js    reverse-DNS / NetBIOS host names
    ports.js      TCP port scan + share/service detection
    wol.js        Wake-on-LAN magic packets
    tools.js      RDP/SSH/Telnet/ping/tracert/browser launchers
    export.js     CSV / HTML / XML / JSON exporters
    store.js      settings, favorites, last range (persisted)
    updater.js    electron-updater integration + install dialog
  preload/
    preload.js    secure contextBridge API (no Node in the renderer)
  renderer/
    index.html    UI markup
    styles.css    theme-aware styling
    renderer.js   UI logic (grid, context menu, drawer, modals)
data/oui.json     curated MAC vendor prefixes
build/            app icons (generated by scripts/generate-icons.js)
scripts/          icon generator + syntax checker
```

---

## Building installers

Icons are generated on the fly, then electron-builder packages the app.

```bash
node scripts/generate-icons.js   # (re)create build/icon.* — already committed

# Build for the current OS:
npm run dist

# Windows installer + portable explicitly:
npm run dist:win     # → release/IP Scanner-Setup-<v>.exe  and  -Portable-<v>.exe

# macOS / Linux:
npm run dist:mac
npm run dist:linux
```

Output lands in `release/`. Build each OS's artifacts on that OS (or via the
included GitHub Actions workflow) — electron-builder does not cross-compile
Windows installers from Linux reliably.

---

## Publishing a release (enables auto-update)

Auto-update reads from GitHub Releases, so publishing is how clients get
updates.

**Automated (recommended)** — the workflow in
[`.github/workflows/release.yml`](.github/workflows/release.yml) builds on
Windows, macOS and Linux and publishes to the matching Release whenever you
push a version tag:

```bash
npm version patch        # bumps package.json + creates a git tag
git push --follow-tags   # triggers the release workflow
```

**Manual** — set a GitHub token and run the publish script locally:

```bash
export GH_TOKEN=<a token with repo scope>
npm run release          # electron-builder builds and uploads to the Release
```

Either way, bump the version in `package.json` for each release — clients
compare against it.

---

## MAC vendor database

A curated prefix list is bundled. For exhaustive coverage, drop the full IEEE
registry into `resources/` — see [`resources/README.md`](resources/README.md).
It's loaded automatically when present.

---

## Security notes

- The renderer runs with `contextIsolation` on and **no Node integration**; all
  privileged actions go through a whitelisted IPC bridge.
- A strict Content-Security-Policy is applied to the UI.
- Only scan networks you are authorized to scan.

---

## License

[MIT](LICENSE) © 2026 TrendlinePros. Not affiliated with Advanced IP Scanner.
