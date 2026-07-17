// Toast Notification Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';
  
  toast.innerHTML = `<span style="font-size: 1.1rem;">${icon}</span> <div style="flex-grow: 1; line-height: 1.4;">${message}</div>`;
  container.appendChild(toast);
  
  // Trigger transition
  setTimeout(() => toast.classList.add('show'), 15);
  
  // Auto remove
  setTimeout(() => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => {
      toast.remove();
    });
  }, 4000);
}

// Global State
let pollingInterval = null;
let currentSettings = {};
let isConnected = false;

// DOM Elements
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const adminPasswordInput = document.getElementById('admin-password');
const loginError = document.getElementById('login-error');

const dashboardContainer = document.getElementById('dashboard-container');
const logoutBtn = document.getElementById('logout-btn');
const connectionBadge = document.getElementById('connection-badge');

const serverStatusText = document.getElementById('server-status-text');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const restartBtn = document.getElementById('restart-btn');
const updateBtn = document.getElementById('update-btn');

const metricCpu = document.getElementById('metric-cpu');
const metricRam = document.getElementById('metric-ram');
const metricUptime = document.getElementById('metric-uptime');
const metricPid = document.getElementById('metric-pid');

const sysCpuText = document.getElementById('sys-cpu-text');
const sysCpuBar = document.getElementById('sys-cpu-bar');
const sysRamText = document.getElementById('sys-ram-text');
const sysRamBar = document.getElementById('sys-ram-bar');

const configForm = document.getElementById('config-form');
const configServerPath = document.getElementById('config-server-path');
const configSettingsPath = document.getElementById('config-settings-path');
const configNewPassword = document.getElementById('config-new-password');

const settingsLoader = document.getElementById('settings-loader');
const settingsEditorContainer = document.getElementById('settings-editor-container');
const saveSettingsBtn = document.getElementById('save-settings-btn');

const consoleLogs = document.getElementById('console-logs');
const clearConsoleBtn = document.getElementById('clear-console-btn');

// --- Helper Functions ---

// Console logging
function addLog(text, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry log-${type}`;
  logEntry.innerHTML = `<span class="log-time">[${time}]</span> ${text}`;
  consoleLogs.appendChild(logEntry);
  consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

// Convert seconds to HH:MM:SS
function formatUptime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00:00';
  const hrs = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const mins = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${hrs}:${mins}:${secs}`;
}

// Handle unauthorized responses
function handleUnauthorized() {
  addLog('Session expired or unauthorized. Please log in.', 'danger');
  stopPolling();
  loginOverlay.classList.add('active');
  dashboardContainer.classList.remove('active');
}

// Show/Hide connection status badge
function setDashboardConnected(connected) {
  if (connected) {
    connectionBadge.className = 'badge badge-online';
    connectionBadge.querySelector('.badge-text').innerText = 'Connected';
    if (!isConnected) {
      addLog('Dashboard connected to backend API', 'success');
      isConnected = true;
    }
  } else {
    connectionBadge.className = 'badge badge-offline';
    connectionBadge.querySelector('.badge-text').innerText = 'Connection Lost';
    if (isConnected) {
      addLog('Lost connection to backend API', 'danger');
      isConnected = false;
    }
  }
}

// --- API Calls ---

// Log in
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = adminPasswordInput.value;
  loginError.innerText = '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    if (res.ok) {
      addLog('Access unlocked successfully', 'success');
      adminPasswordInput.value = '';
      loginOverlay.classList.remove('active');
      dashboardContainer.classList.add('active');
      startPolling();
      loadSettings();
      loadConfig();
    } else {
      const data = await res.json();
      loginError.innerText = data.error || 'Login failed';
      addLog('Failed unlock attempt', 'danger');
    }
  } catch (err) {
    loginError.innerText = 'Could not connect to server';
    addLog('API network error during login', 'danger');
  }
});

// Log out
logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
    addLog('Session terminated', 'info');
    handleUnauthorized();
  } catch (e) {}
});

// Load settings from server config path
async function loadSettings() {
  settingsLoader.classList.remove('hidden');
  settingsEditorContainer.classList.add('hidden');

  try {
    const res = await fetch('/api/settings');
    if (res.status === 401) return handleUnauthorized();
    
    const data = await res.json();
    if (data.settings) {
      currentSettings = data.settings;
      populateSettingsForm(data.settings);
      settingsLoader.classList.add('hidden');
      settingsEditorContainer.classList.remove('hidden');
      addLog('PalWorldSettings.ini loaded successfully', 'info');
    } else {
      addLog('Settings file is empty or missing.', 'warning');
    }
  } catch (err) {
    addLog(`Failed to fetch settings: ${err.message}`, 'danger');
  }
}

// Populate UI form inputs using the settings object keys
function populateSettingsForm(settings) {
  const inputs = settingsEditorContainer.querySelectorAll('[data-key]');
  inputs.forEach(input => {
    const key = input.getAttribute('data-key');
    if (settings[key] !== undefined) {
      if (input.type === 'checkbox') {
        input.checked = settings[key] === true || String(settings[key]).toLowerCase() === 'true';
      } else {
        input.value = settings[key];
      }
    }
  });
}

// Collect form inputs and save settings back to backend
saveSettingsBtn.addEventListener('click', async () => {
  const inputs = settingsEditorContainer.querySelectorAll('[data-key]');
  const updatedSettings = { ...currentSettings };

  inputs.forEach(input => {
    const key = input.getAttribute('data-key');
    if (input.type === 'checkbox') {
      updatedSettings[key] = input.checked;
    } else if (input.type === 'number') {
      updatedSettings[key] = parseFloat(input.value);
    } else {
      updatedSettings[key] = input.value;
    }
  });

  try {
    addLog('Saving game settings to PalWorldSettings.ini...', 'info');
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: updatedSettings })
    });

    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (res.ok) {
      currentSettings = updatedSettings;
      addLog('PalWorldSettings.ini saved successfully!', 'success');
      showToast('Settings saved successfully!', 'success');
    } else {
      addLog(`Failed to save settings: ${data.error}`, 'danger');
      showToast(`Error saving settings: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`Network error saving settings: ${err.message}`, 'danger');
  }
});

// Load dashboard config
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (data) {
      configServerPath.value = data.serverPath || '';
      configSettingsPath.value = data.settingsPath || '';
    }
  } catch (err) {
    addLog('Failed to load dashboard configuration', 'danger');
  }
}

// Save dashboard config
configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const serverPath = configServerPath.value;
  const settingsPath = configSettingsPath.value;
  const newPassword = configNewPassword.value;

  try {
    addLog('Updating dashboard configuration...', 'info');
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverPath, settingsPath, newPassword })
    });

    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (res.ok) {
      addLog('Dashboard configuration updated successfully!', 'success');
      configNewPassword.value = '';
      showToast('Dashboard config saved!', 'success');
      // Reload settings in case settings path changed
      loadSettings();
    } else {
      addLog(`Config update failed: ${data.error}`, 'danger');
      showToast(`Error saving config: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`Network error saving configuration: ${err.message}`, 'danger');
  }
});

// Start Server command
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  addLog('Issuing command to start server...', 'info');
  try {
    const res = await fetch('/api/start', { method: 'POST' });
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (res.ok) {
      addLog('Start server request issued successfully', 'success');
    } else {
      addLog(`Failed to start: ${data.error}`, 'danger');
      showToast(data.error, 'error');
      startBtn.disabled = false;
    }
  } catch (err) {
    addLog('Network error starting server', 'danger');
    startBtn.disabled = false;
  }
});

// Stop Server command
stopBtn.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to STOP the Palworld Server? This will disconnect all players.')) return;
  stopBtn.disabled = true;
  addLog('Issuing force shutdown to PalServer-Win64-Shipping.exe...', 'warning');
  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (res.ok) {
      addLog('Server shutdown command executed successfully', 'success');
    } else {
      addLog(`Failed to stop: ${data.error}`, 'danger');
    }
  } catch (err) {
    addLog('Network error stopping server', 'danger');
  }
});

// Restart Server command
restartBtn.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to RESTART the Palworld Server?')) return;
  restartBtn.disabled = true;
  addLog('Issuing restart sequence. Killing processes...', 'warning');
  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (res.ok) {
      addLog('Server restart sequence complete', 'success');
    } else {
      addLog(`Restart failure: ${data.error}`, 'danger');
      showToast(`Restart failed: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog('Network error restarting server', 'danger');
  }
});

// Update Server command
let updateInterval = null;
let lastLogLength = 0;

function startUpdatePolling() {
  if (updateInterval) return;
  
  startBtn.disabled = true;
  stopBtn.disabled = true;
  restartBtn.disabled = true;
  updateBtn.disabled = true;
  updateBtn.innerText = '⚙️ Updating Server...';
  
  lastLogLength = 0;

  updateInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/update-status');
      if (res.status === 401) {
        clearInterval(updateInterval);
        updateInterval = null;
        return handleUnauthorized();
      }
      
      const data = await res.json();
      
      if (data.log && data.log.length > lastLogLength) {
        const newText = data.log.substring(lastLogLength);
        lastLogLength = data.log.length;
        
        const lines = newText.split('\n');
        lines.forEach(line => {
          if (line.trim()) {
            let logType = 'info';
            if (line.includes('[Error]')) logType = 'danger';
            else if (line.includes('[Update]')) logType = 'warning';
            addLog(line, logType);
          }
        });
      }
      
      if (!data.running) {
        clearInterval(updateInterval);
        updateInterval = null;
        updateBtn.disabled = false;
        updateBtn.innerText = '📥 Update Server (SteamCMD)';
        addLog('Server update sequence complete.', 'success');
        updateMetrics();
      }
    } catch (err) {
      console.error('Error polling update status:', err);
    }
  }, 1000);
}

updateBtn.addEventListener('click', async () => {
  if (!confirm('Warning: Make sure the server is STOPPED before updating. Do you want to run the SteamCMD update now?')) return;
  
  try {
    const res = await fetch('/api/update', { method: 'POST' });
    if (res.status === 401) return handleUnauthorized();
    
    const data = await res.json();
    if (res.ok) {
      addLog('Update sequence initiated.', 'success');
      startUpdatePolling();
    } else {
      addLog(`Failed to initiate update: ${data.error}`, 'danger');
      showToast(`Cannot update: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`Network error during update trigger: ${err.message}`, 'danger');
  }
});

// Poll server and system metrics
async function updateMetrics() {
  try {
    const res = await fetch('/api/status');
    if (res.status === 401) {
      return handleUnauthorized();
    }
    
    setDashboardConnected(true);
    const data = await res.json();
    
    // Update Palworld process status
    if (data.running) {
      serverStatusText.innerText = 'Running';
      serverStatusText.className = 'status-val text-online';
      startBtn.disabled = true;
      stopBtn.disabled = false;
      restartBtn.disabled = false;
      
      if (data.process) {
        metricCpu.innerText = `${data.process.cpuPercent}%`;
        metricRam.innerText = `${data.process.memoryMb} MB`;
        metricPid.innerText = data.process.pid;
        metricUptime.innerText = formatUptime(data.process.uptimeSeconds);
      }
    } else {
      serverStatusText.innerText = 'Stopped';
      serverStatusText.className = 'status-val text-offline';
      startBtn.disabled = false;
      stopBtn.disabled = true;
      restartBtn.disabled = true;
      
      metricCpu.innerText = '0%';
      metricRam.innerText = '0 MB';
      metricPid.innerText = '-';
      metricUptime.innerText = '--:--:--';
    }

    // Update system host metrics
    if (data.system) {
      sysCpuText.innerText = `${data.system.cpuPercent}%`;
      sysCpuBar.style.width = `${data.system.cpuPercent}%`;

      if (data.system.memory) {
        const usedGb = (data.system.memory.usedMb / 1024).toFixed(1);
        const totalGb = (data.system.memory.totalMb / 1024).toFixed(1);
        sysRamText.innerText = `${usedGb} / ${totalGb} GB (${data.system.memory.percentUsed}%)`;
        sysRamBar.style.width = `${data.system.memory.percentUsed}%`;
      }
    }

  } catch (err) {
    setDashboardConnected(false);
    serverStatusText.innerText = 'Unknown';
    serverStatusText.className = 'status-val text-offline';
  }
}

// --- Polling Controllers ---

function startPolling() {
  stopPolling();
  // Poll immediately, then every 3 seconds
  updateMetrics();
  pollingInterval = setInterval(updateMetrics, 3000);
  
  // Poll game server logs every 2 seconds
  pollServerLogs();
  serverLogInterval = setInterval(pollServerLogs, 2000);

  // Poll player list every 3 seconds
  loadPlayers();
  playersPollingInterval = setInterval(loadPlayers, 3000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  if (serverLogInterval) {
    clearInterval(serverLogInterval);
    serverLogInterval = null;
  }
  if (playersPollingInterval) {
    clearInterval(playersPollingInterval);
    playersPollingInterval = null;
  }
}

// --- Interactive UI Binding ---

// Tabs handling
const tabs = document.querySelectorAll('.tab-btn');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    tab.classList.add('active');
    const tabName = tab.getAttribute('data-tab');
    document.getElementById(`tab-${tabName}`).classList.add('active');
  });
});

// Clear console log
clearConsoleBtn.addEventListener('click', () => {
  consoleLogs.innerHTML = '<p class="log-info">[System] Logs cleared.</p>';
});

// --- Initialization Check ---

// Test if already logged in on page load
async function checkInitialLogin() {
  const appLoadingScreen = document.getElementById('app-loading-screen');
  const hideLoadingScreen = () => {
    if (appLoadingScreen) {
      appLoadingScreen.style.opacity = '0';
      appLoadingScreen.style.pointerEvents = 'none';
      setTimeout(() => {
        appLoadingScreen.classList.remove('active');
        appLoadingScreen.style.display = 'none';
      }, 500);
    }
  };

  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      addLog('Restoring active administrative session', 'success');
      loginOverlay.classList.remove('active');
      dashboardContainer.classList.add('active');
      startPolling();
      loadSettings();
      loadConfig();
      
      // Check if an update is currently running
      fetch('/api/update-status')
        .then(r => r.json())
        .then(data => {
          if (data.running) {
            addLog('Resuming server update log stream...', 'warning');
            startUpdatePolling();
          }
        })
        .catch(() => {});
    } else {
      loginOverlay.classList.add('active');
    }
  } catch (err) {
    loginOverlay.classList.add('active');
  } finally {
    hideLoadingScreen();
  }
}

// Server Console Logs Polling
const gameConsoleLogs = document.getElementById('game-console-logs');
const consoleLogsContainer = document.getElementById('console-logs');
const consoleTabBtns = document.querySelectorAll('.console-tab-btn');
let lastServerLog = '';
let serverLogInterval = null;

// Tab switcher for logs console
consoleTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    consoleTabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const consoleType = btn.getAttribute('data-console');
    if (consoleType === 'game') {
      consoleLogsContainer.classList.add('hidden');
      gameConsoleLogs.classList.remove('hidden');
      gameConsoleLogs.scrollTop = gameConsoleLogs.scrollHeight;
    } else {
      gameConsoleLogs.classList.add('hidden');
      consoleLogsContainer.classList.remove('hidden');
      consoleLogsContainer.scrollTop = consoleLogsContainer.scrollHeight;
    }
  });
});

async function pollServerLogs() {
  if (!isConnected) return;
  try {
    const res = await fetch('/api/server-log');
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (data.log !== undefined && data.log !== lastServerLog) {
      lastServerLog = data.log;
      
      const isScrolledToBottom = gameConsoleLogs.scrollHeight - gameConsoleLogs.clientHeight <= gameConsoleLogs.scrollTop + 30;
      
      gameConsoleLogs.innerText = data.log;
      
      if (isScrolledToBottom) {
        gameConsoleLogs.scrollTop = gameConsoleLogs.scrollHeight;
      }
    }
  } catch (err) {
    console.error('Error fetching server logs:', err);
  }
}

// --- Advanced Features: Main Tab Switching ---
const mainTabBtns = document.querySelectorAll('.main-tab-btn');
const mainTabContents = document.querySelectorAll('.main-tab-content');

mainTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    mainTabBtns.forEach(b => b.classList.remove('active'));
    mainTabContents.forEach(c => c.classList.add('hidden'));
    
    btn.classList.add('active');
    const tabName = btn.getAttribute('data-main-tab');
    const targetContent = document.getElementById(`main-tab-content-${tabName}`);
    if (targetContent) {
      targetContent.classList.remove('hidden');
    }
    
    // Fetch initial data if necessary
    if (tabName === 'backups') {
      loadBackups();
    } else if (tabName === 'players') {
      loadPlayers();
    }
  });
});

// --- Advanced Features: Players & Broadcast ---
const activePlayersTbody = document.getElementById('active-players-tbody');
const broadcastMsgInput = document.getElementById('broadcast-msg-input');
const sendBroadcastBtn = document.getElementById('send-broadcast-btn');
let playersPollingInterval = null;

async function loadPlayers() {
  if (!isConnected) return;
  try {
    const res = await fetch('/api/players');
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    
    if (data.error) {
      activePlayersTbody.innerHTML = `<tr><td colspan="5" style="padding: 20px; text-align: center; color: var(--danger); font-weight: 500;">❌ REST API is disabled or config error: ${data.error}</td></tr>`;
      return;
    }
    
    const players = data.players || [];
    if (players.length === 0) {
      activePlayersTbody.innerHTML = `<tr><td colspan="5" style="padding: 20px; text-align: center; color: var(--text-secondary);">No players online.</td></tr>`;
      return;
    }
    
    let html = '';
    players.forEach(p => {
      const name = p.name || 'Unknown';
      const steamId = p.steamId || '-';
      const playerId = p.playerId || '-';
      const ping = p.ping !== undefined ? `${Math.round(p.ping)}ms` : '-';
      const userId = p.playerId || p.steamId;
      
      html += `
        <tr>
          <td style="font-weight: 600; color: white;">${name}</td>
          <td>${steamId}</td>
          <td>${playerId}</td>
          <td><span style="color: #64ffda;">${ping}</span></td>
          <td style="text-align: right; display: flex; gap: 8px; justify-content: flex-end;">
            <button class="btn btn-warning-compact btn-compact" onclick="kickPlayer('${userId}', '${name}')">Kick</button>
            <button class="btn btn-danger-compact btn-compact" onclick="banPlayer('${userId}', '${name}')">Ban</button>
          </td>
        </tr>
      `;
    });
    activePlayersTbody.innerHTML = html;
  } catch (err) {
    activePlayersTbody.innerHTML = `<tr><td colspan="5" style="padding: 20px; text-align: center; color: var(--danger);">Network error fetching players list: ${err.message}</td></tr>`;
  }
}

// Global functions for inline kick/ban buttons
window.kickPlayer = async function(userId, name) {
  const reason = prompt(`Enter kick reason for player "${name}":`, 'Kicked via Web Dashboard');
  if (reason === null) return;
  
  try {
    addLog(`Kicking player "${name}" (${userId})...`, 'warning');
    const res = await fetch('/api/players/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid: userId, message: reason })
    });
    const data = await res.json();
    if (res.ok) {
      addLog(`Player "${name}" kicked successfully!`, 'success');
      showToast(`Player "${name}" kicked successfully!`, 'success');
      loadPlayers();
    } else {
      addLog(`Failed to kick player: ${data.error}`, 'danger');
      showToast(`Error kicking player: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`Network error kicking player: ${err.message}`, 'danger');
  }
};

window.banPlayer = async function(userId, name) {
  const reason = prompt(`Enter ban reason for player "${name}":`, 'Banned via Web Dashboard');
  if (reason === null) return;
  
  if (!confirm(`Are you absolutely sure you want to BAN player "${name}"?`)) return;
  
  try {
    addLog(`Banning player "${name}" (${userId})...`, 'danger');
    const res = await fetch('/api/players/ban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid: userId, message: reason })
    });
    const data = await res.json();
    if (res.ok) {
      addLog(`Player "${name}" banned successfully!`, 'success');
      showToast(`Player "${name}" banned successfully!`, 'success');
      loadPlayers();
    } else {
      addLog(`Failed to ban player: ${data.error}`, 'danger');
      showToast(`Error banning player: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`Network error banning player: ${err.message}`, 'danger');
  }
};

// Send Broadcast
sendBroadcastBtn.addEventListener('click', async () => {
  const msg = broadcastMsgInput.value.trim();
  if (!msg) return;
  
  try {
    addLog(`Sending broadcast message: "${msg}"`, 'info');
    const res = await fetch('/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    const data = await res.json();
    if (res.ok) {
      addLog(`Broadcast message sent successfully!`, 'success');
      broadcastMsgInput.value = '';
      showToast('Broadcast message sent successfully!', 'success');
    } else {
      addLog(`Failed to send broadcast: ${data.error}`, 'danger');
      showToast(`Error sending broadcast: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`Network error sending broadcast: ${err.message}`, 'danger');
  }
});


// --- Advanced Features: Backup Manager ---
const backupsTbody = document.getElementById('backups-tbody');
const createBackupBtn = document.getElementById('create-backup-btn');

async function loadBackups() {
  if (!isConnected) return;
  try {
    const res = await fetch('/api/backups');
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    const backups = data.backups || [];
    
    if (backups.length === 0) {
      backupsTbody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: var(--text-secondary);">No backups found. Click "Create Manual Backup" to start!</td></tr>`;
      return;
    }
    
    let html = '';
    backups.forEach(b => {
      const createdStr = new Date(b.created).toLocaleString();
      const isAuto = b.name.includes('_auto_');
      const badge = isAuto ? '<span style="background: rgba(157, 78, 221, 0.15); color: var(--primary); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; margin-left: 8px;">AUTO</span>' : '<span style="background: rgba(100, 255, 218, 0.1); color: #64ffda; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; margin-left: 8px;">MANUAL</span>';
      
      html += `
        <tr>
          <td style="font-family: monospace; font-weight: 600; color: white;">
            ${b.name}${badge}
          </td>
          <td>${createdStr}</td>
          <td>${b.sizeMb} MB</td>
          <td style="text-align: right;">
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
              <button class="btn btn-warning-compact btn-compact" onclick="restoreBackup('${b.name}')">Restore</button>
              <button class="btn btn-danger-compact btn-compact" onclick="deleteBackup('${b.name}')">Delete</button>
            </div>
          </td>
        </tr>
      `;
    });
    backupsTbody.innerHTML = html;
  } catch (err) {
    backupsTbody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: var(--danger);">Network error fetching backups list: ${err.message}</td></tr>`;
  }
}

createBackupBtn.addEventListener('click', async () => {
  try {
    addLog('Creating manual backup of SaveGames folder...', 'info');
    createBackupBtn.disabled = true;
    createBackupBtn.innerText = 'Creating...';
    
    const res = await fetch('/api/backups/create', { method: 'POST' });
    const data = await res.json();
    
    if (res.ok) {
      addLog(`Backup created successfully: ${data.message}`, 'success');
      showToast('Backup created successfully!', 'success');
      loadBackups();
    } else {
      addLog(`Backup failed: ${data.error}`, 'danger');
      showToast(`Error creating backup: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`Network error creating backup: ${err.message}`, 'danger');
  } finally {
    createBackupBtn.disabled = false;
    createBackupBtn.innerText = '➕ Create Manual Backup';
  }
});

window.restoreBackup = async function(name) {
  if (!confirm(`⚠️ WARNING: Restoring backup "${name}" will STOP the server, overwrite all world saves, and automatically START the server again.\n\nAre you absolutely sure you want to proceed?`)) {
    return;
  }
  
  try {
    addLog(`Initiating restore of backup: "${name}"...`, 'warning');
    const res = await fetch('/api/backups/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (res.ok) {
      addLog(`Backup "${name}" restored successfully. Server is restarting...`, 'success');
      showToast(`Backup "${name}" restored successfully! The server is now starting back up.`, 'success');
      loadBackups();
    } else {
      addLog(`Backup restore failed: ${data.error}`, 'danger');
      showToast(`Error restoring backup: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`Network error during restore: ${err.message}`, 'danger');
  }
};

window.deleteBackup = async function(name) {
  if (!confirm(`Are you sure you want to delete backup "${name}" permanently?`)) return;
  
  try {
    addLog(`Deleting backup "${name}"...`, 'warning');
    const res = await fetch(`/api/backups/${name}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      addLog(`Backup "${name}" deleted successfully.`, 'success');
      loadBackups();
    } else {
      addLog(`Failed to delete backup: ${data.error}`, 'danger');
      showToast(`Error deleting backup: ${data.error}`, 'error');
    }
  } catch (err) {
    addLog(`Network error deleting backup: ${err.message}`, 'danger');
  }
};


// --- Advanced Features: RCON Console ---
const rconTerminalOutput = document.getElementById('rcon-terminal-output');
const rconCmdInput = document.getElementById('rcon-cmd-input');
const executeRconBtn = document.getElementById('execute-rcon-btn');

async function executeRconCommand() {
  const cmd = rconCmdInput.value.trim();
  if (!cmd) return;
  
  rconTerminalOutput.innerHTML += `\n<span style="color: #ffffff;">&gt; ${cmd}</span>`;
  rconTerminalOutput.scrollTop = rconTerminalOutput.scrollHeight;
  rconCmdInput.value = '';
  
  try {
    const res = await fetch('/api/rcon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });
    const data = await res.json();
    if (res.ok) {
      rconTerminalOutput.innerHTML += `\n<span style="color: #64ffda;">${data.result}</span>`;
    } else {
      rconTerminalOutput.innerHTML += `\n<span style="color: #ef476f;">Error: ${data.error}</span>`;
    }
  } catch (err) {
    rconTerminalOutput.innerHTML += `\n<span style="color: #ef476f;">Network Error: ${err.message}</span>`;
  }
  rconTerminalOutput.scrollTop = rconTerminalOutput.scrollHeight;
}

executeRconBtn.addEventListener('click', executeRconCommand);
rconCmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    executeRconCommand();
  }
});

checkInitialLogin();
