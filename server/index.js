const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const KPA500 = require('./kpa500');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    return { httpPort: 8600, serialPath: null, baudRate: null };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const config = loadConfig();
const kpa = new KPA500();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/state', (req, res) => {
  res.json(kpa.getState());
});

app.get('/api/ports', async (req, res) => {
  try {
    const ports = await kpa.listPorts();
    res.json(ports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connect', async (req, res) => {
  const { path: serialPath, baud } = req.body || {};
  if (!serialPath) return res.status(400).json({ error: 'path is required' });
  try {
    await kpa.connect({ path: serialPath, baud: baud || null });
    config.serialPath = serialPath;
    config.baudRate = baud || null;
    saveConfig(config);
    res.json(kpa.getState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  kpa.disconnect();
  res.json(kpa.getState());
});

app.post('/api/command', async (req, res) => {
  const { action, value } = req.body || {};
  try {
    switch (action) {
      case 'operate':
        await kpa.setOperate(Boolean(value));
        break;
      case 'powerOff':
        await kpa.powerOff();
        break;
      case 'powerOn':
        kpa.powerOn();
        break;
      case 'band':
        await kpa.setBand(String(value));
        break;
      case 'clearFault':
        await kpa.clearFault();
        break;
      case 'powerAdjust':
        await kpa.setPowerAdjust(Number(value));
        break;
      case 'alcThreshold':
        await kpa.setAlcThreshold(Number(value));
        break;
      case 'fanMin':
        await kpa.setFanMin(Number(value));
        break;
      case 'trDelay':
        await kpa.setTrDelay(Number(value));
        break;
      case 'attenRelease':
        await kpa.setAttenRelease(Number(value));
        break;
      case 'stbyOnBandChange':
        await kpa.setStbyOnBandChange(Boolean(value));
        break;
      case 'inhibit':
        await kpa.setInhibitEnabled(Boolean(value));
        break;
      case 'demoMode':
        await kpa.setDemoMode(Boolean(value));
        break;
      case 'speaker':
        await kpa.setSpeakerOn(Boolean(value));
        break;
      case 'radioInterface':
        await kpa.setRadioInterface(value && value.type, value && value.option);
        break;
      case 'raw':
        await kpa.raw(String(value));
        break;
      default:
        return res.status(400).json({ error: `unknown action: ${action}` });
    }
    res.json(kpa.getState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(config.httpPort, () => {
  console.log(`KPA500 web control listening on http://localhost:${config.httpPort}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(msg);
  });
}

kpa.on('state', (state) => broadcast('state', state));
kpa.on('log', (line) => {
  console.log(`[wire] ${line}`);
  broadcast('log', line);
});

// Track the amp's last known power state across restarts so a fresh boot
// can tell "was off, came back on by itself" apart from "was already on".
kpa.on('state', (state) => {
  if (state.power !== null && state.power !== config.lastPower) {
    config.lastPower = state.power;
    saveConfig(config);
  }
});

// Opening the serial port asserts DTR as a side effect of the underlying
// open() syscall, before any bytes are written, and the KPA500's remote
// power circuit treats that DTR edge as a wake trigger - so the very first
// power reading after a fresh connect can show "on" even though the amp
// was actually left off (confirmed via wire log: the amp was already
// fully booted before this app sent a single byte). This has to be scoped
// tightly to that one post-open reading, not treated as a standing
// invariant - the server reconnects periodically now (after the native
// Elecraft app closes, see below), and a broader check would also fight
// the user turning the amp on by hand at the front panel or in the native
// app afterward, mistaking a real power-on for another wake glitch.
//
// config.lastPower is only trustworthy to correct against when nothing else
// could have touched the amp while we were disconnected - true right after
// a fresh process start (a real reboot, the bug this was built for) or a
// brief native-app-yield. It is NOT trustworthy after an on-demand idle
// disconnect (see wantsConnection() below), since that gap can be hours
// long and is the exact window where someone else changing the amp's power
// is expected and legitimate, not a glitch to undo (confirmed live: an idle
// reconnect wrongly powered off an amp the user had turned on via the
// native app while this server was disconnected).
let wasConnected = false;
let awaitingPostOpenReading = false;
let expectedOffOnOpen = false;
let lastDisconnectWasIdle = false;
kpa.on('state', (state) => {
  if (state.connected && !wasConnected) {
    // Snapshot before the sibling listener above can overwrite
    // config.lastPower with this same connection's own first reading.
    expectedOffOnOpen = !lastDisconnectWasIdle && config.lastPower === false;
    awaitingPostOpenReading = true;
  }
  wasConnected = state.connected;

  if (awaitingPostOpenReading && state.power !== null) {
    awaitingPostOpenReading = false;
    if (state.power === true && expectedOffOnOpen) {
      console.log('KPA500 woke itself on serial port open - restoring prior off state');
      kpa.powerOff().catch((err) => console.error(`Auto power-off failed: ${err.message}`));
    }
  }
});

// Hold the serial port only while a browser tab of the web remote is
// actually connected, instead of always-on. That way the native Elecraft
// app can open the port on its own the moment nobody's using the web
// remote, without racing this server's poll-based yield below. The grace
// period survives a page refresh (which briefly drops and reopens the
// WebSocket) without bouncing the serial connection.
let activeClients = 0;
let lastClientDisconnectAt = null;
const CLIENT_GRACE_MS = 5000;

function wantsConnection() {
  if (activeClients > 0) return true;
  return Boolean(lastClientDisconnectAt) && Date.now() - lastClientDisconnectAt < CLIENT_GRACE_MS;
}

wss.on('connection', (ws) => {
  activeClients++;
  ws.send(JSON.stringify({ type: 'state', payload: kpa.getState() }));
  checkConnectionState();
  ws.on('close', () => {
    activeClients--;
    lastClientDisconnectAt = Date.now();
  });
});

process.on('SIGINT', () => {
  kpa.disconnect();
  process.exit(0);
});

function attemptConnect() {
  if (!config.serialPath) return;
  kpa
    .connect({ path: config.serialPath, baud: config.baudRate || null })
    .then(() => {
      // Persist whatever baud we ended up on so the next process start
      // (e.g. the LaunchAgent firing at login/reboot) reuses it via
      // openAt() instead of re-running autoBaud().
      const { baud } = kpa.getState();
      if (baud && baud !== config.baudRate) {
        config.baudRate = baud;
        saveConfig(config);
      }
    })
    .catch((err) => console.error(`Auto-connect failed: ${err.message}`));
}

// The official Elecraft KPA Utility.app wants exclusive access to the same
// physical serial line: it opens /dev/cu.usbserial-*, we open
// /dev/tty.usbserial-* for the same port, and on macOS those two device
// nodes can't both be open at once. Unlike this server (which fails fast
// and retries), the native app doesn't handle losing that race gracefully -
// it just hangs (or throws an unrecoverable error dialog) waiting for the
// amp, with no retry. On-demand connect (above) means this server no longer
// holds the port by default, which handles the common case; this poll is a
// backstop for when a browser tab is left open and the native app is
// launched anyway - it still yields the moment the native app appears, and
// reclaims the port once it closes.
const NATIVE_APP_PATTERN = 'Elecraft KPA Utility.app';
const NATIVE_APP_POLL_MS = 150;

function isNativeAppRunning() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', NATIVE_APP_PATTERN], (err) => resolve(!err));
  });
}

async function checkConnectionState() {
  const running = await isNativeAppRunning();
  const state = kpa.getState();
  if (running) {
    if (state.connected || state.connecting) {
      console.log(`${NATIVE_APP_PATTERN} detected - releasing serial port`);
      lastDisconnectWasIdle = false;
      kpa.disconnect();
    }
    return;
  }
  if (wantsConnection()) {
    if (!state.connected && !state.connecting) attemptConnect();
  } else if (state.connected || state.connecting) {
    console.log('No web remote clients connected - releasing serial port');
    lastDisconnectWasIdle = true;
    kpa.disconnect();
  }
}

setInterval(checkConnectionState, NATIVE_APP_POLL_MS);
checkConnectionState();
