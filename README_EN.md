# dsh-update-check

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">Version visibility for DeepSeek Harness</b><br /><br />
  <code>dsh_check_updates</code> model tool · Settings page · periodic re-check<br /><br />
  <b>Report only, never upgrade</b>——upgrade decisions stay in the user's hands.
</div>

<div align="center">
  🌏 <a href="./README.md"><b>中文</b></a> · <a href="./README_EN.md">English</a>
</div>

## ✨ Features

- **🔍 Version check**: compares installed versions against npm registry dist-tags for the DSH core (`@deepseek-ai/dsh`) and profile plugins (e.g. `@anionex/dsh-vision-toolkit`)
- **🤖 Model tool** `dsh_check_updates`: agents can query version status in any session (optional extra package names)
- **🖥️ Settings page**: a new "Update Check" section with a version table (name / current / latest / status), last-checked time, and a "Check now" button
- **⏰ Periodic re-check**: configurable interval (30s / 1m / 30m / 1h / 12h / 24h / off), default 1 hour; first check runs 30s after startup
- **🛡️ Failure protection**: keeps the last successful snapshot on registry outages; per-package failures are isolated as unknown entries
- **🎨 Native look**: all colors reference DSH theme tokens (`--dsw-alias-*`), light/dark adaptive

## 📦 Install

```bash
dsh plugin --profile web add <this repo / npm package>
# restart dsh web
```

## 🧠 Design notes

- Local version lookup: profile node_modules → npm global root (`npm prefix -g`), no hardcoded paths
- Registry query: native Node fetch (15s timeout)
- Browser endpoints: `/_dsh/update-check/snapshot` (GET), `/_dsh/update-check/refresh` (GET), `/_dsh/update-check/set-interval` (POST)

## 🧩 Ecosystem

Tag your own plugins with <a href="https://github.com/topics/dsh-update-check"><code>dsh-update-check</code></a> to join the ecosystem. PRs welcome.

## 📄 License

[MIT](./LICENSE)

## 📝 Changelog

### v0.2.0

**Bug fixes**

- **Version comparison**: fixed prerelease (`-rc.1`) handling — the whole version string used to be split on `.` and parsed numerically, so `0.1.5-rc.1` and `0.1.2-rc.1` compared equal and DSH was perpetually reported as up to date
- **GitHub tag parsing**: fixed prefixed release tags such as `dsh-v0.1.5-rc.1` — previously only the `v` prefix was stripped, so the leftover prefix parsed as segment 0 and the `upstream-new` state could never trigger
- **Self-skip**: auto-discovery now matches the npm package name (`dsh_check_updates`) as well as the directory name, so the plugin no longer lists itself
- **UI false positive**: the Settings page no longer reports success when the endpoint returns an error

**Robustness & security**

- Added npm package-name validation, closing path traversal and URL injection through the `packages` tool argument
- Concurrent refresh is deduplicated: timer, HTTP endpoint and model tool share a single in-flight check
- Multi-package checks now run in parallel instead of sequentially
- `intervalMinutes` is validated against the whitelist and falls back to 60 minutes
- Oversized request bodies no longer destroy the socket, so the browser receives a proper 400
- Resolving the npm global root is now asynchronous and no longer blocks the host event loop

**Tests**

- Added 17 behavioural tests (13 host + 4 client) covering version comparison, input validation, concurrency deduplication, HTTP endpoints and plugin teardown
