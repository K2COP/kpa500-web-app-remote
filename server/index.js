const fs = require('fs');
const path = require('path');
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
        intendedOff = true;
        await kpa.powerOff();
        break;
      case 'powerOn':
        intendedOff = false;
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
kpa.on('log', (line) => broadcast('log', line));

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
// power circuit treats that DTR edge as a wake trigger. A stray byte
// landing on the wire during the amp's off-transition can *also* revive
// it, since its bootloader treats any unrecognized byte mid-transition as
// "cancel, wake back up" - so there's more than one way for it to turn
// itself back on. Rather than catch one specific cause once at startup,
// treat "should be off" as a standing invariant for as long as nobody has
// deliberately asked for it to be on: every observed power:true while that
// invariant holds gets corrected, not just the first one.
let intendedOff = config.lastPower === false;
kpa.on('state', (state) => {
  if (state.power === true && intendedOff) {
    console.log('KPA500 powered on unexpectedly - restoring intended off state');
    kpa.powerOff().catch((err) => console.error(`Auto power-off failed: ${err.message}`));
  }
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', payload: kpa.getState() }));
});

process.on('SIGINT', () => {
  kpa.disconnect();
  process.exit(0);
});

// Auto-connect on startup if a port was previously configured.
if (config.serialPath) {
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
