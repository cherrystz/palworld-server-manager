# 👾 Palworld Web Dashboard

A sleek, lightweight, self-hosted web control panel to monitor and administer your Palworld Dedicated Server. Built using a fast Node.js Express backend and a responsive, premium slate-purple glassmorphic frontend (Vanilla HTML5/CSS3/JS). Zero database dependencies, fully portable.

---

## ✨ Features

- 📊 **Real-time Monitoring:** View server status (Online/Offline/Starting), active process CPU, RAM usage, server uptime, and host machine performance metrics.
- 👥 **Active Player Management:** Real-time online players list table showing Player Name, Steam ID, Player ID, and Ping. Perform instant in-game kicks and bans with custom reasons.
- 📢 **Broadcasting System:** Send system-wide announcements or custom notification text directly onto active players' screens.
- 💾 **Robust Backup Manager:** 
  - Create manual timestamped backups of `SaveGames` in one click.
  - Automated background backups (every 30 minutes) when the server is active, automatically retaining the last 20 archives to save space.
  - Seamless restore: automatically stops the server, restores saves (supports both folders and `.zip` files via native Windows PowerShell extraction), and restarts the server.
- 💻 **RCON Console Bridge:** Run admin commands (`Save`, `Broadcast`, `Kick`, `Ban`, `Shutdown`) directly from an interactive developer terminal.
- 📜 **Line-Buffered Log Streamer:** Real-time streaming of server console output (logs player join/leave, minidump alerts, and script outputs) with persistent historical file logging.
- 📥 **SteamCMD Updater:** Run automated SteamCMD server updates directly from the dashboard panel.
- 🔒 **Security First:** Simple cookie-based dashboard access authentication.

---

## 🛠️ Prerequisites

- **Node.js** (v18.x or newer recommended)
- **SteamCMD** (optional, required if you want to run updates via the dashboard)

---

## 🚀 Quick Start Guide

### 1. Installation

Clone this repository or download the ZIP to your server host machine:
```bash
git clone https://github.com/yourusername/palworld-web-dashboard.git
cd palworld-web-dashboard
```

### 2. Configuration

Open `config.json` in the root folder and verify the port and file paths:
```json
{
  "port": 31742,
  "adminPassword": "admin",
  "serverPath": "./server/PalServer.exe",
  "settingsPath": "./server/Pal/Saved/Config/WindowsServer/PalWorldSettings.ini"
}
```
- `port`: The port the dashboard website will run on (Default: `31742`).
- `adminPassword`: The password required to unlock and access the dashboard.
- `serverPath`: The path to your `PalServer.exe` (can be relative e.g., `./server/PalServer.exe` or absolute).
- `settingsPath`: The path to your `PalWorldSettings.ini` config.

### 3. REST API Configuration (Required for Players, Broadcast, & RCON)

For the advanced administration features (Kicks, Bans, Announcements, RCON console) to work, you must enable the official Palworld REST API inside your **`PalWorldSettings.ini`**:

1. Open the dashboard Settings panel or edit the `.ini` file directly.
2. Ensure the following variables are set:
   - `AdminPassword="your_admin_password"` *(Cannot be empty!)*
   - `RESTAPIEnabled=True`
   - `RESTAPIPort=8212` *(Default port is 8212)*
3. Save settings and restart the Palworld Server.

### 4. Running the Dashboard

Double-click the **`run.bat`** launcher file. It will automatically check for Node dependencies, download missing modules, and start the dashboard server.

Alternatively, you can start it via terminal:
```bash
npm install
npm start
```
Once started, open your browser and go to:
- **Local Access:** `http://localhost:31742`
- **External Access:** `http://<your-server-ip>:31742`

Log in using the `adminPassword` specified in your `config.json`.

---

## 🛡️ Port Forwarding & Firewall

To allow other administrators to access this dashboard remotely:
1. **Windows Firewall:** Create a new Inbound Rule allowing TCP traffic on port `31742`.
2. **Router Port Forwarding:** Forward TCP port `31742` to your host computer's local IP address.
3. Open your game port (Default: `8211` UDP) so players can join.

---

## 🤝 Credits & Acknowledgements

- This project is a customized extension and fork of the original [palworld-ds-gui by diogomartino](https://github.com/diogomartino/palworld-ds-gui).
- Major enhancements added in this version:
  - Responsive slate-purple glassmorphic dashboard UI with Toast Notifications and Page loading indicators.
  - Advanced 4-Tab Control Console (Game Settings, Live Players, Backup Manager, RCON Console).
  - Robust Backup Manager supporting manual/periodic auto backups and native Windows ZIP extraction.
  - Optimized Line-buffered server logging, resolving delay issues on shipping cmd builds.
  - Secured dashboard security configurations, hiding host path configs from the frontend client.
