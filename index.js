import express from 'express';
import cookieParser from 'cookie-parser';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'config.json');

// Helper to read config
function readConfig() {
  try {
    const data = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return {
      port: 31742,
      adminPassword: 'admin',
      serverPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PalServer\\PalServer.exe',
      settingsPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PalServer\\Pal\\Saved\\Config\\WindowsServer\\PalWorldSettings.ini'
    };
  }
}

// Helper to write config
function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

let config = readConfig();

const serverLogPath = path.join(__dirname, 'server.log');
let serverConsoleLog = '[System] Awaiting Palworld Dedicated Server launch...\n';
let lastPlayers = new Map();
try {
  if (fs.existsSync(serverLogPath)) {
    serverConsoleLog = fs.readFileSync(serverLogPath, 'utf8');
  }
} catch (e) {
  console.error('Error reading initial server log:', e);
}

function appendServerLog(data) {
  serverConsoleLog += data;
  if (serverConsoleLog.length > 100000) {
    serverConsoleLog = serverConsoleLog.substring(serverConsoleLog.length - 50000);
  }
  try {
    fs.appendFileSync(serverLogPath, data, 'utf8');
  } catch (e) {
    console.error('Error writing server log to file:', e);
  }
}

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function debugLog(text) {
  const logMsg = `[${new Date().toISOString()}] ${text}\n`;
  try {
    fs.appendFileSync(path.join(__dirname, 'debug.log'), logMsg, 'utf8');
  } catch (e) {}
  console.log(text);
}

app.use((req, res, next) => {
  if (req.url === '/api/login') {
    debugLog(`[Auth] Login attempt. Password: "${req.body?.password}" (length: ${req.body?.password?.length || 0})`);
    debugLog(`[Auth] Expected password: "${config.adminPassword}" (length: ${config.adminPassword?.length || 0})`);
  } else if (!req.url.startsWith('/api/status')) {
    debugLog(`[Req] ${req.method} ${req.url}`);
  }
  next();
});

// Authentication middleware
function authenticate(req, res, next) {
  const token = req.cookies.admin_token;
  if (token === config.adminPassword) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please login.' });
}

// 1. Auth API
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === config.adminPassword) {
    res.cookie('admin_token', password, { httpOnly: true, maxAge: 86400000 * 7 }); // 7 days
    return res.json({ success: true });
  }
  return res.status(400).json({ error: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true });
});

// 2. Status & Monitoring API
app.get('/api/status', authenticate, async (req, res) => {
  let isRunning = false;
  let processStats = null;
  let systemStats = null;

  // Check if server process is running
  try {
    const [res1, res2] = await Promise.all([
      execAsync('tasklist /FI "IMAGENAME eq PalServer-Win64-Shipping.exe" /NH').catch(() => ({ stdout: '' })),
      execAsync('tasklist /FI "IMAGENAME eq PalServer-Win64-Shipping-Cmd.exe" /NH').catch(() => ({ stdout: '' }))
    ]);
    isRunning = res1.stdout.includes('PalServer-Win64') || res2.stdout.includes('PalServer-Win64');
  } catch (err) {
    isRunning = false;
  }

  // Get process metrics if running
  if (isRunning) {
    try {
      // Get memory usage and start time
      const procInfoCmd = `powershell -Command "Get-Process -Name 'PalServer-Win64-Shipping*' -ErrorAction SilentlyContinue | Select-Object Id, Name, WorkingSet, StartTime | ConvertTo-Json"`;
      const { stdout } = await execAsync(procInfoCmd);
      if (stdout.trim()) {
        let rawStats = JSON.parse(stdout);
        if (Array.isArray(rawStats)) {
          rawStats = rawStats[0];
        }
        const startTime = rawStats.StartTime ? Date.parse(rawStats.StartTime) : null;
        
        // Calculate Uptime
        const uptimeSeconds = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
        
        // Get process CPU usage via Get-Counter using the exact process name
        let cpuPercent = 0;
        try {
          const procName = rawStats.Name || 'PalServer-Win64-Shipping';
          const cpuCmd = `powershell -Command "(Get-Counter '\\Process(${procName})\\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples.CookedValue"`;
          const { stdout: cpuOut } = await execAsync(cpuCmd);
          if (cpuOut.trim()) {
            cpuPercent = Math.round(parseFloat(cpuOut.trim()));
          }
        } catch (e) {}

        processStats = {
          pid: rawStats.Id,
          memoryMb: Math.round(rawStats.WorkingSet / (1024 * 1024)),
          cpuPercent: cpuPercent,
          uptimeSeconds: uptimeSeconds
        };
      }
    } catch (err) {
      console.error('Error fetching process stats:', err);
    }
  }

  // Get overall system status
  try {
    const memCmd = `powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory | ConvertTo-Json"`;
    const cpuCmd = `powershell -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"`;
    
    const [memOut, cpuOut] = await Promise.all([
      execAsync(memCmd).catch(() => ({ stdout: '' })),
      execAsync(cpuCmd).catch(() => ({ stdout: '' }))
    ]);

    let systemMemory = null;
    if (memOut.stdout.trim()) {
      const rawMem = JSON.parse(memOut.stdout);
      const totalMb = Math.round(rawMem.TotalVisibleMemorySize / 1024);
      const freeMb = Math.round(rawMem.FreePhysicalMemory / 1024);
      systemMemory = {
        totalMb,
        usedMb: totalMb - freeMb,
        freeMb,
        percentUsed: Math.round(((totalMb - freeMb) / totalMb) * 100)
      };
    }

    systemStats = {
      cpuPercent: cpuOut.stdout.trim() ? Math.round(parseFloat(cpuOut.stdout.trim())) : 0,
      memory: systemMemory
    };
  } catch (err) {
    console.error('Error fetching system stats:', err);
  }

  res.json({
    running: isRunning,
    process: processStats,
    system: systemStats
  });
});

// Helper functions for ini parsing
function formatValue(val) {
  if (val.startsWith('"') && val.endsWith('"')) {
    return val.slice(1, -1);
  }
  if (val.toLowerCase() === 'true') return true;
  if (val.toLowerCase() === 'false') return false;
  if (!isNaN(val) && val !== '') return Number(val);
  return val;
}

function parseSettings(fileContent) {
  const match = fileContent.match(/OptionSettings=\((.*)\)/);
  if (!match) return {};
  const settingsStr = match[1];
  const settings = {};
  
  let currentKey = '';
  let currentValue = '';
  let inQuotes = false;
  let isParsingValue = false;
  let parenDepth = 0;
  
  for (let i = 0; i < settingsStr.length; i++) {
    const char = settingsStr[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      currentValue += char;
    } else if (char === '(' && !inQuotes) {
      parenDepth++;
      currentValue += char;
    } else if (char === ')' && !inQuotes) {
      parenDepth--;
      currentValue += char;
    } else if (char === '=' && !inQuotes && !isParsingValue) {
      isParsingValue = true;
    } else if (char === ',' && !inQuotes && parenDepth === 0) {
      if (currentKey.trim()) {
        settings[currentKey.trim()] = formatValue(currentValue.trim());
      }
      currentKey = '';
      currentValue = '';
      isParsingValue = false;
    } else {
      if (isParsingValue) {
        currentValue += char;
      } else {
        currentKey += char;
      }
    }
  }
  if (currentKey.trim()) {
    settings[currentKey.trim()] = formatValue(currentValue.trim());
  }
  return settings;
}

function getDefaultSettings() {
  const defaultSettingsPath = path.join(path.dirname(config.serverPath), 'DefaultPalWorldSettings.ini');
  if (fs.existsSync(defaultSettingsPath)) {
    const content = fs.readFileSync(defaultSettingsPath, 'utf8');
    const sectionMatch = content.match(/\[(.*)\]/);
    const sectionHeader = sectionMatch ? sectionMatch[0] : '[/Script/Pal.PalGameWorldSettings]';
    return {
      settings: parseSettings(content),
      sectionHeader: sectionHeader
    };
  }
  return {
    settings: {},
    sectionHeader: '[/Script/Pal.PalGameWorldSettings]'
  };
}

function serializeSettings(settings, sectionHeader = '[/Script/Pal.PalGameWorldSettings]') {
  const pairs = [];
  for (const [key, val] of Object.entries(settings)) {
    if (val === null || val === undefined || (typeof val === 'number' && isNaN(val))) {
      continue;
    }
    let serializedVal = val;
    if (typeof val === 'string') {
      if (val.startsWith('(') && val.endsWith(')')) {
        serializedVal = val;
      } else {
        serializedVal = `"${val}"`;
      }
    } else if (typeof val === 'boolean') {
      serializedVal = val ? 'True' : 'False';
    }
    pairs.push(`${key}=${serializedVal}`);
  }
  return `${sectionHeader}\nOptionSettings=(${pairs.join(',')})`;
}

// 3. Settings API
app.get('/api/settings', authenticate, (req, res) => {
  const settingsFilePath = config.settingsPath;
  try {
    let settings = {};
    const hasExist = fs.existsSync(settingsFilePath);
    const defaults = getDefaultSettings();
    
    if (hasExist) {
      const content = fs.readFileSync(settingsFilePath, 'utf8');
      const fileSettings = parseSettings(content);
      settings = { ...defaults.settings, ...fileSettings };
    } else {
      settings = defaults.settings;
    }
    
    // Remove any invalid keys or nulls
    for (const key in settings) {
      if (settings[key] === null || settings[key] === undefined) {
        delete settings[key];
      }
    }
    
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: `Failed to read settings: ${err.message}` });
  }
});

app.post('/api/settings', authenticate, (req, res) => {
  const settingsFilePath = config.settingsPath;
  const { settings: clientSettings } = req.body;
  if (!clientSettings) {
    return res.status(400).json({ error: 'No settings provided' });
  }

  try {
    const dir = path.dirname(settingsFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const defaults = getDefaultSettings();
    
    let existingSettings = {};
    if (fs.existsSync(settingsFilePath)) {
      const content = fs.readFileSync(settingsFilePath, 'utf8');
      existingSettings = parseSettings(content);
    }
    
    const cleanClientSettings = {};
    for (const [key, val] of Object.entries(clientSettings)) {
      if (val !== null && val !== undefined && !(typeof val === 'number' && isNaN(val))) {
        cleanClientSettings[key] = val;
      }
    }
    
    const mergedSettings = { ...defaults.settings, ...existingSettings, ...cleanClientSettings };
    const serialized = serializeSettings(mergedSettings, defaults.sectionHeader);
    
    fs.writeFileSync(settingsFilePath, serialized, 'utf8');
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    res.status(500).json({ error: `Failed to save settings: ${err.message}` });
  }
});

// 4. Server Control API
function getSettingsPort() {
  const settingsFilePath = config.settingsPath;
  try {
    if (fs.existsSync(settingsFilePath)) {
      const content = fs.readFileSync(settingsFilePath, 'utf8');
      const settings = parseSettings(content);
      if (settings.PublicPort) {
        return Number(settings.PublicPort);
      }
    }
  } catch (err) {
    console.error('Error reading settings port:', err);
  }
  return 8211;
}

app.post('/api/start', authenticate, async (req, res) => {
  const exePath = config.serverPath;
  if (!fs.existsSync(exePath)) {
    return res.status(400).json({ error: `PalServer.exe not found at path: ${exePath}` });
  }

  try {
    const [res1, res2] = await Promise.all([
      execAsync('tasklist /FI "IMAGENAME eq PalServer-Win64-Shipping.exe" /NH').catch(() => ({ stdout: '' })),
      execAsync('tasklist /FI "IMAGENAME eq PalServer-Win64-Shipping-Cmd.exe" /NH').catch(() => ({ stdout: '' }))
    ]);
    if (res1.stdout.includes('PalServer-Win64') || res2.stdout.includes('PalServer-Win64')) {
      return res.status(400).json({ error: 'Server is already running' });
    }

    const port = getSettingsPort();
    const exeDir = path.dirname(exePath);
    const cmdExePath = path.join(exeDir, 'Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping-Cmd.exe');

    let targetExe = exePath;
    let spawnCwd = exeDir;
    let spawnStdio = 'ignore';

    if (fs.existsSync(cmdExePath)) {
      targetExe = cmdExePath;
      spawnCwd = path.dirname(cmdExePath);
      spawnStdio = ['ignore', 'pipe', 'pipe'];
    }

    try {
      fs.writeFileSync(serverLogPath, '', 'utf8');
    } catch (e) {}
    serverConsoleLog = `[System] Server starting on port ${port}...\n`;
    try {
      fs.writeFileSync(serverLogPath, serverConsoleLog, 'utf8');
    } catch (e) {}

    const child = spawn(targetExe, [`-port=${port}`, '-stdout', '-FullStdOutLogOutput'], {
      cwd: spawnCwd,
      detached: true,
      stdio: spawnStdio
    });

    if (spawnStdio !== 'ignore') {
      child.stdout.on('data', (data) => {
        appendServerLog(data.toString());
      });
      child.stderr.on('data', (data) => {
        appendServerLog(`[Error] ${data.toString()}`);
      });
      child.on('close', (code) => {
        appendServerLog(`\n[System] Server process exited with code ${code}\n`);
      });
    }

    child.unref();

    res.json({ success: true, message: `Server start command issued on port ${port}` });
  } catch (err) {
    res.status(500).json({ error: `Failed to start server: ${err.message}` });
  }
});

app.post('/api/stop', authenticate, async (req, res) => {
  try {
    // Graceful taskkill for both GUI and Cmd server processes
    await execAsync('taskkill /f /im PalServer-Win64-Shipping.exe').catch(() => {});
    await execAsync('taskkill /f /im PalServer-Win64-Shipping-Cmd.exe').catch(() => {});
    await execAsync('taskkill /f /im PalServer.exe').catch(() => {});
    lastPlayers = new Map();
    res.json({ success: true, message: 'Server stopped successfully' });
  } catch (err) {
    lastPlayers = new Map();
    res.json({ success: true, message: 'Server is already stopped or not running' });
  }
});

app.post('/api/restart', authenticate, async (req, res) => {
  try {
    // Stop server
    await execAsync('taskkill /f /im PalServer-Win64-Shipping.exe').catch(() => {});
    await execAsync('taskkill /f /im PalServer-Win64-Shipping-Cmd.exe').catch(() => {});
    await execAsync('taskkill /f /im PalServer.exe').catch(() => {});
    lastPlayers = new Map();
    
    // Wait 3 seconds
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Start server
    const exePath = config.serverPath;
    if (!fs.existsSync(exePath)) {
      return res.status(400).json({ error: `PalServer.exe not found. Stopped server but could not start.` });
    }

    const port = getSettingsPort();
    const exeDir = path.dirname(exePath);
    const cmdExePath = path.join(exeDir, 'Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping-Cmd.exe');

    let targetExe = exePath;
    let spawnCwd = exeDir;
    let spawnStdio = 'ignore';

    if (fs.existsSync(cmdExePath)) {
      targetExe = cmdExePath;
      spawnCwd = path.dirname(cmdExePath);
      spawnStdio = ['ignore', 'pipe', 'pipe'];
    }

    try {
      fs.writeFileSync(serverLogPath, '', 'utf8');
    } catch (e) {}
    serverConsoleLog = `[System] Server restarting on port ${port}...\n`;
    try {
      fs.writeFileSync(serverLogPath, serverConsoleLog, 'utf8');
    } catch (e) {}

    const child = spawn(targetExe, [`-port=${port}`, '-stdout', '-FullStdOutLogOutput'], {
      cwd: spawnCwd,
      detached: true,
      stdio: spawnStdio
    });

    if (spawnStdio !== 'ignore') {
      child.stdout.on('data', (data) => {
        appendServerLog(data.toString());
      });
      child.stderr.on('data', (data) => {
        appendServerLog(`[Error] ${data.toString()}`);
      });
      child.on('close', (code) => {
        appendServerLog(`\n[System] Server process exited with code ${code}\n`);
      });
    }

    child.unref();

    res.json({ success: true, message: `Server restarted successfully on port ${port}` });
  } catch (err) {
    res.status(500).json({ error: `Restart operation failed: ${err.message}` });
  }
});

app.get('/api/server-log', authenticate, (req, res) => {
  res.json({ log: serverConsoleLog });
});

// background REST API poller for online players
async function pollPlayersAPI() {
  const settingsFilePath = config.settingsPath;
  if (!fs.existsSync(settingsFilePath)) return;
  
  try {
    const content = fs.readFileSync(settingsFilePath, 'utf8');
    const settings = parseSettings(content);
    
    const restEnabled = settings.RESTAPIEnabled === true || settings.RESTAPIEnabled === 'True';
    const adminPassword = settings.AdminPassword;
    const restPort = Number(settings.RESTAPIPort) || 8212;
    
    if (!restEnabled || !adminPassword || adminPassword === '""' || adminPassword === '') {
      return;
    }
    
    const cleanPassword = adminPassword.replace(/^"(.*)"$/, '$1');
    const authHeader = 'Basic ' + Buffer.from('admin:' + cleanPassword).toString('base64');
    
    const options = {
      hostname: '127.0.0.1',
      port: restPort,
      path: '/v1/api/players',
      method: 'GET',
      headers: {
        'Authorization': authHeader
      },
      timeout: 1000,
      insecureHTTPParser: true
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            const currentPlayers = result.players || [];
            
            const currentMap = new Map();
            for (const p of currentPlayers) {
              const id = p.steamId || p.playerId;
              currentMap.set(id, p.name);
            }
            
            // Check for joins
            for (const [id, name] of currentMap.entries()) {
              if (!lastPlayers.has(id)) {
                appendServerLog(`[${new Date().toLocaleTimeString()}] [Player] Join: "${name}" (ID: ${id})\n`);
              }
            }
            
            // Check for leaves
            for (const [id, name] of lastPlayers.entries()) {
              if (!currentMap.has(id)) {
                appendServerLog(`[${new Date().toLocaleTimeString()}] [Player] Leave: "${name}" (ID: ${id})\n`);
              }
            }
            
            lastPlayers = currentMap;
          } catch (e) {
            // JSON parse error
          }
        }
      });
    });
    
    req.on('error', (err) => {
      // Server offline or port not listening
    });
    
    req.end();
  } catch (err) {
    // Ignore errors
  }
}

// Poll players list every 3 seconds
setInterval(pollPlayersAPI, 3000);

// Generic REST API client helper
function callPalworldAPI(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const settingsFilePath = config.settingsPath;
    if (!fs.existsSync(settingsFilePath)) {
      return reject(new Error('Settings file not found'));
    }
    
    try {
      const content = fs.readFileSync(settingsFilePath, 'utf8');
      const settings = parseSettings(content);
      
      const restEnabled = settings.RESTAPIEnabled === true || settings.RESTAPIEnabled === 'True';
      const adminPassword = settings.AdminPassword;
      const restPort = Number(settings.RESTAPIPort) || 8212;
      
      if (!restEnabled) {
        return reject(new Error('REST API is not enabled in settings'));
      }
      if (!adminPassword || adminPassword === '""' || adminPassword === '') {
        return reject(new Error('AdminPassword is empty'));
      }
      
      const cleanPassword = adminPassword.replace(/^"(.*)"$/, '$1');
      const authHeader = 'Basic ' + Buffer.from('admin:' + cleanPassword).toString('base64');
      
      const bodyData = body ? JSON.stringify(body) : null;
      const headers = {
        'Authorization': authHeader
      };
      if (bodyData) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyData);
      }
      
      const options = {
        hostname: '127.0.0.1',
        port: restPort,
        path: `/v1/api${endpoint}`,
        method: method,
        headers: headers,
        timeout: 2000,
        insecureHTTPParser: true
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : { success: true });
            } catch (e) {
              resolve({ raw: data, success: true });
            }
          } else {
            reject(new Error(`REST API status code ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on('error', (err) => {
        reject(new Error(`Failed to reach server REST API: ${err.message}`));
      });
      
      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// 3.1 Player Management API
app.get('/api/players', authenticate, async (req, res) => {
  try {
    const data = await callPalworldAPI('GET', '/players');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/kick', authenticate, async (req, res) => {
  const { userid, message } = req.body;
  if (!userid) return res.status(400).json({ error: 'Missing userid' });
  try {
    await callPalworldAPI('POST', '/kick', { userid, message: message || 'Kicked from dashboard' });
    res.json({ success: true, message: `Player ${userid} kicked` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/players/ban', authenticate, async (req, res) => {
  const { userid, message } = req.body;
  if (!userid) return res.status(400).json({ error: 'Missing userid' });
  try {
    await callPalworldAPI('POST', '/ban', { userid, message: message || 'Banned from dashboard' });
    res.json({ success: true, message: `Player ${userid} banned` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/broadcast', authenticate, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  try {
    await callPalworldAPI('POST', '/announce', { message });
    res.json({ success: true, message: 'Message broadcasted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3.2 RCON Command Console Bridge API
app.post('/api/rcon', authenticate, async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Missing command' });
  
  const parts = command.trim().split(/\s+/);
  const cmdName = parts[0].toLowerCase();
  
  try {
    if (cmdName === 'save') {
      await callPalworldAPI('POST', '/save');
      return res.json({ result: 'World saved successfully' });
    } else if (cmdName === 'shutdown') {
      const waitTime = Number(parts[1]) || 60;
      const message = parts.slice(2).join(' ') || 'Server is shutting down...';
      await callPalworldAPI('POST', '/shutdown', { waittime: waitTime, message });
      return res.json({ result: `Server shutdown scheduled in ${waitTime} seconds` });
    } else if (cmdName === 'kick') {
      const userid = parts[1];
      if (!userid) throw new Error('Usage: Kick <SteamID/PlayerID>');
      const msg = parts.slice(2).join(' ') || 'Kicked via RCON';
      await callPalworldAPI('POST', '/kick', { userid, message: msg });
      return res.json({ result: `Kicked player ${userid}` });
    } else if (cmdName === 'ban') {
      const userid = parts[1];
      if (!userid) throw new Error('Usage: Ban <SteamID/PlayerID>');
      const msg = parts.slice(2).join(' ') || 'Banned via RCON';
      await callPalworldAPI('POST', '/ban', { userid, message: msg });
      return res.json({ result: `Banned player ${userid}` });
    } else if (cmdName === 'broadcast' || cmdName === 'announce') {
      const msg = parts.slice(1).join(' ');
      if (!msg) throw new Error('Usage: Broadcast <message>');
      await callPalworldAPI('POST', '/announce', { message: msg });
      return res.json({ result: `Broadcasted: ${msg}` });
    } else {
      throw new Error(`Command "${parts[0]}" is not supported via REST RCON bridge. Available: Save, Shutdown, Kick, Ban, Broadcast`);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3.3 Backup Management API
const backupDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

function getFolderSize(dirPath) {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  const files = fs.readdirSync(dirPath);
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(dirPath, files[i]);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      size += getFolderSize(filePath);
    } else {
      size += stats.size;
    }
  }
  return size;
}

app.get('/api/backups', authenticate, (req, res) => {
  try {
    if (!fs.existsSync(backupDir)) {
      return res.json({ backups: [] });
    }
    const folders = fs.readdirSync(backupDir);
    const backups = folders.map(name => {
      const fullPath = path.join(backupDir, name);
      const stat = fs.statSync(fullPath);
      const sizeBytes = getFolderSize(fullPath);
      return {
        name,
        created: stat.birthtime || stat.mtime,
        sizeMb: (sizeBytes / (1024 * 1024)).toFixed(2)
      };
    });
    backups.sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ backups });
  } catch (err) {
    res.status(500).json({ error: `Failed to read backups: ${err.message}` });
  }
});

function makeBackup(isAuto = false) {
  const serverDir = path.dirname(config.serverPath);
  const saveGamesPath = path.join(serverDir, 'Pal', 'Saved', 'SaveGames');
  
  if (!fs.existsSync(saveGamesPath)) {
    throw new Error(`SaveGames folder not found at: ${saveGamesPath}`);
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const type = isAuto ? 'auto' : 'manual';
  const destName = `backup_${type}_${timestamp}`;
  const destPath = path.join(backupDir, destName);
  
  fs.mkdirSync(destPath, { recursive: true });
  fs.cpSync(saveGamesPath, destPath, { recursive: true });
  
  return destName;
}

app.post('/api/backups/create', authenticate, (req, res) => {
  try {
    const destName = makeBackup(false);
    res.json({ success: true, message: `Backup created: ${destName}` });
  } catch (err) {
    res.status(500).json({ error: `Backup failed: ${err.message}` });
  }
});

app.delete('/api/backups/:name', authenticate, (req, res) => {
  const { name } = req.params;
  const fullPath = path.join(backupDir, name);
  if (!fs.existsSync(fullPath) || path.relative(backupDir, fullPath).includes('..')) {
    return res.status(400).json({ error: 'Invalid backup name' });
  }
  try {
    fs.rmSync(fullPath, { recursive: true, force: true });
    res.json({ success: true, message: 'Backup deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: `Failed to delete backup: ${err.message}` });
  }
});

app.post('/api/backups/restore', authenticate, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing backup name' });

  const backupSource = path.join(backupDir, name);
  if (!fs.existsSync(backupSource) || path.relative(backupDir, backupSource).includes('..')) {
    return res.status(400).json({ error: 'Invalid backup path' });
  }

  const serverDir = path.dirname(config.serverPath);
  const saveGamesPath = path.join(serverDir, 'Pal', 'Saved', 'SaveGames');

  try {
    appendServerLog(`[System] Initiate backup restore of "${name}"...\n`);
    appendServerLog(`[System] Stopping Palworld Server processes to prevent save lock...\n`);
    
    await execAsync('taskkill /f /im PalServer-Win64-Shipping.exe').catch(() => {});
    await execAsync('taskkill /f /im PalServer-Win64-Shipping-Cmd.exe').catch(() => {});
    await execAsync('taskkill /f /im PalServer.exe').catch(() => {});
    lastPlayers = new Map();
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    if (fs.existsSync(saveGamesPath)) {
      const backupTempPath = saveGamesPath + '_temp_before_restore';
      fs.renameSync(saveGamesPath, backupTempPath);
      try {
        fs.rmSync(backupTempPath, { recursive: true, force: true });
      } catch (e) {
        console.error('Non-critical: error cleaning temp directory:', e);
      }
    }
    
    fs.mkdirSync(saveGamesPath, { recursive: true });
    fs.cpSync(backupSource, saveGamesPath, { recursive: true });
    
    appendServerLog(`[System] Backup files restored. Starting server again...\n`);
    
    const port = getSettingsPort();
    const cmdExePath = path.join(serverDir, 'Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping-Cmd.exe');

    let targetExe = config.serverPath;
    let spawnCwd = serverDir;
    let spawnStdio = 'ignore';

    if (fs.existsSync(cmdExePath)) {
      targetExe = cmdExePath;
      spawnCwd = path.dirname(cmdExePath);
      spawnStdio = ['ignore', 'pipe', 'pipe'];
    }

    const child = spawn(targetExe, [`-port=${port}`, '-stdout', '-FullStdOutLogOutput'], {
      cwd: spawnCwd,
      detached: true,
      stdio: spawnStdio
    });

    if (spawnStdio !== 'ignore') {
      child.stdout.on('data', (data) => {
        appendServerLog(data.toString());
      });
      child.stderr.on('data', (data) => {
        appendServerLog(`[Error] ${data.toString()}`);
      });
      child.on('close', (code) => {
        appendServerLog(`\n[System] Server process exited with code ${code}\n`);
      });
    }

    child.unref();
    
    res.json({ success: true, message: `Backup "${name}" restored and server restarted.` });
  } catch (err) {
    res.status(500).json({ error: `Restore failed: ${err.message}` });
  }
});

// Auto Backup timer (every 30 minutes)
setInterval(() => {
  execAsync('tasklist /FI "IMAGENAME eq PalServer-Win64-Shipping-Cmd.exe" /NH')
    .then(({ stdout }) => {
      if (stdout.includes('PalServer-Win64')) {
        try {
          const name = makeBackup(true);
          appendServerLog(`[${new Date().toLocaleTimeString()}] [System] Automated periodic backup created: ${name}\n`);
          
          const files = fs.readdirSync(backupDir);
          const autoBackups = files
            .filter(f => f.startsWith('backup_auto_'))
            .map(f => ({ name: f, path: path.join(backupDir, f), stat: fs.statSync(path.join(backupDir, f)) }));
          
          autoBackups.sort((a, b) => b.stat.birthtime - a.stat.birthtime);
          if (autoBackups.length > 20) {
            for (let i = 20; i < autoBackups.length; i++) {
              fs.rmSync(autoBackups[i].path, { recursive: true, force: true });
              appendServerLog(`[System] Pruned old auto backup: ${autoBackups[i].name}\n`);
            }
          }
        } catch (err) {
          console.error('Automated backup failed:', err);
        }
      }
    })
    .catch(() => {});
}, 30 * 60 * 1000);

// 5. Config API (Get & Save dashboard config)
app.get('/api/config', authenticate, (req, res) => {
  // Return configuration without password
  const safeConfig = { ...config };
  delete safeConfig.adminPassword;
  res.json(safeConfig);
});

app.post('/api/config', authenticate, (req, res) => {
  const { serverPath, settingsPath, newPassword } = req.body;
  
  if (serverPath) config.serverPath = serverPath;
  if (settingsPath) config.settingsPath = settingsPath;
  if (newPassword && newPassword.trim() !== '') {
    config.adminPassword = newPassword;
  }

  try {
    writeConfig(config);
    res.json({ success: true, message: 'Dashboard configuration updated' });
  } catch (err) {
    res.status(500).json({ error: `Failed to save configuration: ${err.message}` });
  }
});

// 6. Server Update API
let updateStatus = {
  running: false,
  log: ''
};

async function downloadSteamCmd() {
  const steamcmdDir = path.join(__dirname, 'steamcmd');
  const zipPath = path.join(__dirname, 'steamcmd.zip');
  const exePath = path.join(steamcmdDir, 'steamcmd.exe');

  if (fs.existsSync(exePath)) {
    return exePath;
  }

  if (!fs.existsSync(steamcmdDir)) {
    fs.mkdirSync(steamcmdDir, { recursive: true });
  }

  updateStatus.log += '[Update] steamcmd.exe not found. Downloading official SteamCMD...\n';
  
  const response = await fetch('https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip');
  if (!response.ok) throw new Error(`Failed to download SteamCMD: ${response.statusText}`);
  
  const fileStream = fs.createWriteStream(zipPath);
  await pipeline(Readable.fromWeb(response.body), fileStream);
  
  updateStatus.log += '[Update] Extracting steamcmd.zip using PowerShell...\n';
  await execAsync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${steamcmdDir}' -Force"`);
  
  try {
    fs.unlinkSync(zipPath);
  } catch (e) {}

  updateStatus.log += '[Update] SteamCMD ready.\n';
  return exePath;
}

app.post('/api/update', authenticate, async (req, res) => {
  if (updateStatus.running) {
    return res.status(400).json({ error: 'Update is already running' });
  }

  let isRunning = false;
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq PalServer-Win64-Shipping.exe" /NH');
    isRunning = stdout.includes('PalServer-Win64');
  } catch (err) {}

  if (isRunning) {
    return res.status(400).json({ error: 'Please stop the Palworld Server before updating!' });
  }

  updateStatus.running = true;
  updateStatus.log = '[Update] Initiating server update process...\n';

  res.json({ success: true, message: 'Update process started' });

  // Run update asynchronously
  (async () => {
    try {
      const exePath = await downloadSteamCmd();
      const serverDir = path.dirname(config.serverPath);
      
      updateStatus.log += `[Update] Running SteamCMD to update server in: ${serverDir}\n`;
      
      const steamcmdProcess = spawn(exePath, [
        '+force_install_dir', serverDir,
        '+login', 'anonymous',
        '+app_update', '2394010', 'validate',
        '+quit'
      ], {
        cwd: path.dirname(exePath)
      });

      steamcmdProcess.stdout.on('data', (data) => {
        updateStatus.log += data.toString();
      });

      steamcmdProcess.stderr.on('data', (data) => {
        updateStatus.log += `[Error] ${data.toString()}`;
      });

      steamcmdProcess.on('close', (code) => {
        updateStatus.running = false;
        if (code === 0) {
          updateStatus.log += '\n[Update] Server updated successfully!\n';
        } else {
          updateStatus.log += `\n[Update] SteamCMD exited with code ${code}\n`;
        }
      });

    } catch (err) {
      updateStatus.running = false;
      updateStatus.log += `\n[Update] Update failed: ${err.message}\n`;
    }
  })();
});

app.get('/api/update-status', authenticate, (req, res) => {
  res.json(updateStatus);
});

// Check port on start
const startApp = () => {
  const PORT = config.port || 31742;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(`🚀 Palworld Dedicated Server Web Dashboard Running!`);
    console.log(`🔗 Local Access: http://localhost:${PORT}`);
    console.log(`🔗 External Access: http://<Your-IP-Address>:${PORT}`);
    console.log(`==================================================`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Error: Port ${PORT} is already in use by another application.`);
      console.error(`👉 Please change the port in config.json and try again.`);
      process.exit(1);
    } else {
      console.error('❌ Server startup error:', err);
    }
  });
};

startApp();
