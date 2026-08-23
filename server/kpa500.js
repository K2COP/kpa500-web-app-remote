const { SerialPort } = require('serialport');
const { EventEmitter } = require('events');

// KPA500 Programmer's Reference (Elecraft, rev A2):
// 4800/9600/19200/38400 8N1, no flow control, commands/responses are
// printable ASCII terminated by ';'. Commands are 2-3 letters prefixed
// with '^'. GETs always produce a RESPONSE, except ^ON when the amp is
// off (no response at all). SET commands generally produce no response
// (verified here the same way as the KAT500: follow each SET with the
// null command ";", which always echoes back).
const BAUD_RATES = [38400, 19200, 9600, 4800];

const BANDS = [
  { code: '00', label: '160m' },
  { code: '01', label: '80m' },
  { code: '02', label: '60m' },
  { code: '03', label: '40m' },
  { code: '04', label: '30m' },
  { code: '05', label: '20m' },
  { code: '06', label: '17m' },
  { code: '07', label: '15m' },
  { code: '08', label: '12m' },
  { code: '09', label: '10m' },
  { code: '10', label: '6m' },
];

const RADIO_INTERFACES = {
  0: 'K3',
  1: 'BCD',
  2: 'Analog (Icom)',
  3: 'Elecraft/Kenwood serial',
};

function bandLabel(code) {
  const band = BANDS.find((b) => b.code === code);
  return band ? band.label : `band ${code}`;
}

// ppp/vvv/sss fields on ^WS and ^VI are 3 ASCII digits with an implied
// decimal point after the 2nd digit (e.g. "015" -> 1.5).
function impliedDecimal(digits) {
  return Number(`${digits.slice(0, 2)}.${digits.slice(2)}`);
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

class KPA500 {
  constructor() {
    this.port = null;
    this.buffer = '';
    this.queue = [];
    this.waiting = null;
    this.actionLock = Promise.resolve();
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.pollTick = 0;
    this.events = new EventEmitter();
    this.configuredPath = null;
    this.configuredBaud = null;

    this.state = {
      connected: false,
      connecting: false,
      path: null,
      baud: null,
      lastUpdated: null,
      lastError: null,
      ...this.liveFieldDefaults(),
    };
  }

  on(event, handler) {
    this.events.on(event, handler);
  }

  /** Fields that describe the live device, not the connection itself.
   * Cleared on disconnect and before probing a new port so stale readings
   * never linger and look live. */
  liveFieldDefaults() {
    return {
      power: null, // ^ON: true/false/null(unknown - only known after a probe)
      operate: null, // ^OS: true = OPERATE, false = STANDBY
      band: null,
      bandLabel: null,
      fault: 0,
      faultMessage: 'No fault',
      watts: null,
      swr: null,
      volts: null,
      amps: null,
      tempC: null,
      powerAdjust: null, // ^PJ, 80-120, per-band
      alcThreshold: null, // ^AL, 0-210, per-band
      fanMin: null, // ^FC, 0-6
      trDelay: null, // ^TR, 0-50 ms
      attenRelease: null, // ^AR, 1400-5000 ms
      stbyOnBandChange: null, // ^BC
      inhibitEnabled: null, // ^NH
      demoMode: null, // ^DMO
      speakerOn: null, // ^SP
      radioInterfaceType: null, // ^XI n
      radioInterfaceOption: null, // ^XI o
      firmware: null,
      serialNumber: null,
    };
  }

  getState() {
    return { ...this.state };
  }

  setState(patch) {
    Object.assign(this.state, patch, { lastUpdated: Date.now() });
    this.events.emit('state', this.getState());
  }

  log(line) {
    this.events.emit('log', line);
  }

  async listPorts() {
    return SerialPort.list();
  }

  // --- connection lifecycle -------------------------------------------------

  async connect({ path, baud } = {}) {
    this.disconnect();
    this.configuredPath = path || this.configuredPath;
    if (!this.configuredPath) throw new Error('No serial port specified');

    // baud === undefined means "caller didn't specify, reuse last known
    // good rate" (used by the reconnect watchdog). An explicit null means
    // "auto-detect now" and must not be silently replaced by a stale value
    // remembered from a previous connect() call.
    const requestedBaud = baud !== undefined ? baud : this.configuredBaud;

    this.setState({ connecting: true, lastError: null, ...this.liveFieldDefaults() });
    try {
      if (requestedBaud) {
        await this.openAt(this.configuredPath, requestedBaud);
      } else {
        await this.autoBaud(this.configuredPath);
      }
    } catch (err) {
      this.setState({ connecting: false, lastError: err.message });
      throw err;
    }
  }

  async autoBaud(path) {
    let lastErr = null;
    for (const rate of BAUD_RATES) {
      try {
        await this.probeBaud(path, rate);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error(`Unable to find a working baud rate on ${path}`);
  }

  probeBaud(path, baud) {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
      let settled = false;
      let buf = '';

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        port.removeAllListeners();
        if (err) {
          try {
            port.close(() => {});
          } catch (e) {
            /* ignore */
          }
          reject(err);
        } else {
          this.attach(port, path, baud);
          resolve();
        }
      };

      const timer = setTimeout(() => finish(new Error('probe timeout')), 900);

      port.open((err) => {
        if (err) return finish(err);
        port.on('data', (chunk) => {
          buf += chunk.toString('ascii');
          if (buf.includes(';')) finish(null);
        });
        port.on('error', (err2) => finish(err2));
        // Null command: the KPA500 echoes ';' for it. If the amp's main
        // firmware isn't running (soft-off / bootloader), this will just
        // time out - autoBaud() will report a connect failure and the UI
        // exposes a "Power on" action once the user knows the port/baud.
        port.write(';;;');
      });
    });
  }

  openAt(path, baud) {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
      port.open((err) => {
        if (err) return reject(err);
        this.attach(port, path, baud);
        resolve();
      });
    });
  }

  attach(port, path, baud) {
    this.port = port;
    this.buffer = '';
    this.pollTick = 0;
    this.configuredBaud = baud;
    this.setState({
      connected: true,
      connecting: false,
      path,
      baud,
      lastError: null,
    });
    this.log(`Connected to ${path} @ ${baud} baud`);

    port.on('data', (chunk) => this.onData(chunk));
    port.on('close', () => this.onDisconnect('port closed'));
    port.on('error', (err) => this.onDisconnect(err.message));

    this.startPolling();
    this.primeState();
  }

  onDisconnect(reason) {
    if (!this.state.connected && !this.state.connecting) return;
    this.setState({
      connected: false,
      connecting: false,
      lastError: reason,
      ...this.liveFieldDefaults(),
    });
    this.log(`Disconnected: ${reason}`);
    this.stopPolling();
    this.failQueue(new Error(reason));
    if (this.port) {
      try {
        this.port.removeAllListeners();
      } catch (e) {
        /* ignore */
      }
    }
    this.port = null;
    this.scheduleReconnect();
  }

  disconnect() {
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failQueue(new Error('disconnected'));
    if (this.port) {
      try {
        this.port.removeAllListeners();
        this.port.close(() => {});
      } catch (e) {
        /* ignore */
      }
    }
    this.port = null;
    this.setState({ connected: false, connecting: false, ...this.liveFieldDefaults() });
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.configuredPath) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect({ path: this.configuredPath, baud: this.configuredBaud });
      } catch (err) {
        this.scheduleReconnect();
      }
    }, 3000);
  }

  // --- command queue ----------------------------------------------------

  enqueue(cmd, { awaitResponse = true, timeoutMs = 800 } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, awaitResponse, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.waiting || this.queue.length === 0) return;
    if (!this.port || !this.state.connected) {
      this.failQueue(new Error('not connected'));
      return;
    }
    const job = this.queue.shift();
    const wire = job.cmd.endsWith(';') ? job.cmd : `${job.cmd};`;
    this.port.write(wire);
    this.log(`> ${wire}`);

    if (!job.awaitResponse) {
      job.resolve(null);
      setTimeout(() => this.pump(), 15);
      return;
    }

    const timer = setTimeout(() => {
      this.waiting = null;
      job.reject(new Error(`timeout waiting for response to ${job.cmd}`));
      this.pump();
    }, job.timeoutMs);
    this.waiting = { job, timer };
  }

  failQueue(err) {
    const jobs = this.queue.splice(0, this.queue.length);
    jobs.forEach((job) => job.reject(err));
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.job.reject(err);
      this.waiting = null;
    }
  }

  /** GET command: normally produces a response ("^ON" is the one
   * documented exception - see getPowerState()). */
  get(cmd, timeoutMs = 800) {
    return this.enqueue(cmd, { awaitResponse: true, timeoutMs });
  }

  /**
   * SET command: per Elecraft's guidance, SET commands produce no
   * response. We follow each one with the null command (";"), which always
   * echoes back, giving us flow control without guessing per-command timing.
   */
  async set(cmd, { syncTimeoutMs = 500 } = {}) {
    this.enqueue(cmd, { awaitResponse: false });
    return this.enqueue(';', { awaitResponse: true, timeoutMs: syncTimeoutMs });
  }

  /** ^ON is documented to produce NO response at all when the amp is off,
   * so a timeout here is a normal, meaningful result (not a dropped byte)
   * and must not be swallowed like other polled GETs. In practice the
   * bootloader sometimes instead echoes the bare query back with no status
   * digit ("^ON" instead of "^ON0"/"^ON1") rather than staying silent -
   * that's not a dropped/garbled read, it's the same "amp is off" case as
   * the timeout, and must be treated the same way. Previously this fell
   * through to "leave power unchanged," which could get stuck at its
   * initial `null` forever (seen live: power state never resolved, so the
   * UI's Power On button - gated on state.power === false exactly - never
   * enabled). */
  async getPowerState() {
    try {
      const token = await this.get('^ON', 600);
      const m = /^\^ON(\d)$/.exec(token);
      this.setState({ power: m ? m[1] === '1' : false });
    } catch (err) {
      this.setState({ power: false });
    }
  }

  /** Boot-mode "power on" command. Only meaningful while the amp's main
   * firmware is NOT running (soft-off via ^ON0, or a fresh cold start);
   * sent outside the normal ';'-terminated queue since the bootloader
   * doesn't use it. The caller is expected to gate this on state.power
   * being known false. */
  powerOn() {
    if (!this.port || !this.state.connected) throw new Error('not connected');
    this.port.write('P');
    this.log('> P (boot: power on)');
    setTimeout(() => this.primeState(), 3000);
  }

  // --- incoming data ------------------------------------------------------

  onData(chunk) {
    this.buffer += chunk.toString('ascii');
    let idx;
    while ((idx = this.buffer.indexOf(';')) !== -1) {
      const token = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (token.length > 0) {
        this.log(`< ${token};`);
        this.handleMessage(token);
      }
      if (this.waiting) {
        clearTimeout(this.waiting.timer);
        this.waiting.job.resolve(token);
        this.waiting = null;
        this.pump();
      }
    }
  }

  handleMessage(token) {
    let m;

    if ((m = /^\^ON(\d)$/.exec(token))) {
      this.setState({ power: m[1] === '1' });
      return;
    }
    if ((m = /^\^OS(\d)$/.exec(token))) {
      this.setState({ operate: m[1] === '1' });
      return;
    }
    if ((m = /^\^BN(\d{2})$/.exec(token))) {
      this.setState({ band: m[1], bandLabel: bandLabel(m[1]) });
      return;
    }
    if ((m = /^\^FL(\d{2})$/.exec(token))) {
      const fault = Number(m[1]);
      this.setState({
        fault,
        // Elecraft's Programmer's Reference doesn't enumerate fault-code
        // text (only that 00 = no fault); the owner's manual describes
        // fault causes but not a nn -> text mapping, so we show the code.
        faultMessage: fault === 0 ? 'No fault' : `Fault code ${m[1]}`,
      });
      return;
    }
    if ((m = /^\^WS(\d{3})\s*(\d{3})$/.exec(token))) {
      this.setState({ watts: Number(m[1]), swr: impliedDecimal(m[2]) });
      return;
    }
    if ((m = /^\^VI(\d{3})\s*(\d{3})$/.exec(token))) {
      this.setState({ volts: impliedDecimal(m[1]), amps: impliedDecimal(m[2]) });
      return;
    }
    if ((m = /^\^TM(\d{3})$/.exec(token))) {
      this.setState({ tempC: Number(m[1]) });
      return;
    }
    if ((m = /^\^PJ(\d{3})$/.exec(token))) {
      this.setState({ powerAdjust: Number(m[1]) });
      return;
    }
    if ((m = /^\^AL(\d{3})$/.exec(token))) {
      this.setState({ alcThreshold: Number(m[1]) });
      return;
    }
    if ((m = /^\^FC(\d{1,2})$/.exec(token))) {
      // Doc shows a single digit (0-6); the actual firmware zero-pads to 2.
      this.setState({ fanMin: Number(m[1]) });
      return;
    }
    if ((m = /^\^TR(\d{2})$/.exec(token))) {
      this.setState({ trDelay: Number(m[1]) });
      return;
    }
    if ((m = /^\^AR(\d{4})$/.exec(token))) {
      this.setState({ attenRelease: Number(m[1]) });
      return;
    }
    if ((m = /^\^BC(\d)$/.exec(token))) {
      this.setState({ stbyOnBandChange: m[1] === '1' });
      return;
    }
    if ((m = /^\^NH(\d)$/.exec(token))) {
      this.setState({ inhibitEnabled: m[1] === '1' });
      return;
    }
    if ((m = /^\^DMO(\d)$/.exec(token))) {
      this.setState({ demoMode: m[1] === '1' });
      return;
    }
    if ((m = /^\^SP(\d)$/.exec(token))) {
      this.setState({ speakerOn: m[1] === '1' });
      return;
    }
    if ((m = /^\^XI(\d)(\d)$/.exec(token))) {
      this.setState({ radioInterfaceType: Number(m[1]), radioInterfaceOption: Number(m[2]) });
      return;
    }
    if ((m = /^\^RVM\s*([\d.]+)$/.exec(token))) {
      this.setState({ firmware: m[1] });
      return;
    }
    if ((m = /^\^SN\s*(\d+)$/.exec(token))) {
      this.setState({ serialNumber: m[1] });
      return;
    }
    // Unrecognized token (bare "KPA500" identify reply, echoes, etc.) -
    // ignore for now, still logged above.
  }

  // --- polling --------------------------------------------------------------

  async primeState() {
    // Soft-off (or a still-booting amp) leaves only the bootloader running,
    // listening for a bare 'P' byte to power back on. Any other command -
    // notably '^PJ', which starts with that same byte - would be misread as
    // that wake trigger. It's not enough to check this once up front: power
    // can drop mid-sequence (e.g. a concurrent corrective powerOff() from
    // the DTR-wake guard), so re-check before every single command and bail
    // out the moment it's no longer confirmed on.
    const steps = [
      '^OS', '^RVM', '^SN', '^BN', '^PJ', '^AL', '^FC', '^TR', '^AR',
      '^BC', '^NH', '^DMO', '^SP', '^XI', '^FL', '^WS', '^VI', '^TM',
    ];
    try {
      await this.getPowerState();
      for (const cmd of steps) {
        if (this.state.power !== true) return;
        await this.get(cmd).catch(() => {});
      }
    } catch (err) {
      /* connection may have dropped mid-sequence; polling loop will retry */
    }
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.pollOnce(), 1000);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollOnce() {
    if (!this.state.connected || this.queue.length > 2) return;
    this.pollTick += 1;
    try {
      // Confirm power state fresh on every tick, before anything else goes
      // out. The amp can enter soft-off (front-panel button, not just
      // ^ON0) at any moment, and while it's transitioning its bootloader
      // treats any stray byte on the line as "cancel, wake back up" - so a
      // stale cached state.power (checked less often than every tick) lets
      // routine polling commands land mid-transition and revive it. ^ON is
      // documented safe to send even to the bootloader (that's how this
      // check itself works), so it's the only thing allowed to go out
      // before we know the real state.
      await this.getPowerState();
      if (this.state.power !== true) return;

      await this.get('^WS').catch(() => {});
      if (this.state.power !== true) return;
      await this.get('^VI').catch(() => {});
      if (this.pollTick % 3 === 0) {
        if (this.state.power !== true) return;
        await this.get('^FL').catch(() => {});
        if (this.state.power !== true) return;
        await this.get('^TM').catch(() => {});
      }
      if (this.pollTick % 5 === 0) {
        if (this.state.power !== true) return;
        await this.get('^OS').catch(() => {});
        if (this.state.power !== true) return;
        await this.get('^BN').catch(() => {});
        if (this.state.power !== true) return;
        await this.get('^PJ').catch(() => {});
        if (this.state.power !== true) return;
        await this.get('^AL').catch(() => {});
      }
    } catch (err) {
      /* ignore poll errors; connection watchdog handles real drops */
    }
  }

  // --- high level actions -------------------------------------------------

  // SET commands produce no response, so the UI's cached state would
  // otherwise only catch up on the next slow poll tick. Re-GET immediately
  // after each SET so the UI reflects the new state right away instead of
  // waiting on the background poller.
  //
  // Each action below is a small sequence of enqueued commands (SET, then
  // one or more follow-up GETs). Two actions fired back to back (e.g. the
  // UI POSTing a second command before the first HTTP request returns)
  // could otherwise interleave their steps on the shared queue and leave
  // state reflecting neither action cleanly. withLock() forces actions to
  // run one at a time, in the order they arrive.
  withLock(fn) {
    const run = this.actionLock.then(fn, fn);
    this.actionLock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  setOperate(operate) {
    return this.withLock(async () => {
      await this.set(`^OS${operate ? 1 : 0}`);
      return this.get('^OS').catch(() => {});
    });
  }

  /** Soft power-off (^ON0). Leaves the amp listening in the bootloader for
   * a 'P' command (see powerOn on the driver, or the raw console) - it does
   * not require a trip to the rear panel switch to bring back. */
  powerOff() {
    return this.withLock(async () => {
      await this.set('^ON0', { syncTimeoutMs: 1500 }).catch(() => {});
      this.setState({ power: false });
    });
  }

  setBand(code) {
    if (!BANDS.some((b) => b.code === code)) throw new Error('invalid band code');
    return this.withLock(async () => {
      await this.set(`^BN${code}`);
      await this.get('^BN').catch(() => {});
      // Power/ALC targets are stored per-band; refresh so the UI shows
      // the new band's saved values, not the previous band's.
      await this.get('^PJ').catch(() => {});
      return this.get('^AL').catch(() => {});
    });
  }

  clearFault() {
    return this.withLock(() => this.set('^FLC'));
  }

  setPowerAdjust(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 80 || v > 120) throw new Error('power adjust must be 80-120');
    return this.withLock(async () => {
      await this.set(`^PJ${pad(v, 3)}`);
      return this.get('^PJ').catch(() => {});
    });
  }

  setAlcThreshold(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 0 || v > 210) throw new Error('ALC threshold must be 0-210');
    return this.withLock(async () => {
      await this.set(`^AL${pad(v, 3)}`);
      return this.get('^AL').catch(() => {});
    });
  }

  setFanMin(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 0 || v > 6) throw new Error('fan minimum must be 0-6');
    return this.withLock(async () => {
      // SET takes a single digit; the amp's RSP zero-pads it to 2 (^FC00).
      await this.set(`^FC${v}`);
      return this.get('^FC').catch(() => {});
    });
  }

  setTrDelay(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 0 || v > 50) throw new Error('TR delay must be 0-50');
    return this.withLock(async () => {
      await this.set(`^TR${pad(v, 2)}`);
      return this.get('^TR').catch(() => {});
    });
  }

  setAttenRelease(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 1400 || v > 5000)
      throw new Error('attenuator release time must be 1400-5000');
    return this.withLock(async () => {
      await this.set(`^AR${pad(v, 4)}`);
      return this.get('^AR').catch(() => {});
    });
  }

  setStbyOnBandChange(enabled) {
    return this.withLock(async () => {
      await this.set(`^BC${enabled ? 1 : 0}`);
      return this.get('^BC').catch(() => {});
    });
  }

  setInhibitEnabled(enabled) {
    return this.withLock(async () => {
      await this.set(`^NH${enabled ? 1 : 0}`);
      return this.get('^NH').catch(() => {});
    });
  }

  setDemoMode(enabled) {
    return this.withLock(async () => {
      await this.set(`^DMO${enabled ? 1 : 0}`);
      return this.get('^DMO').catch(() => {});
    });
  }

  setSpeakerOn(enabled) {
    return this.withLock(async () => {
      await this.set(`^SP${enabled ? 1 : 0}`);
      return this.get('^SP').catch(() => {});
    });
  }

  setRadioInterface(type, option) {
    const n = Number(type);
    const o = Number(option);
    if (![0, 1, 2, 3].includes(n)) throw new Error('radio interface type must be 0-3');
    if (![0, 1].includes(o)) throw new Error('radio interface option must be 0 or 1');
    return this.withLock(async () => {
      await this.set(`^XI${n}${o}`);
      return this.get('^XI').catch(() => {});
    });
  }

  raw(cmd) {
    return this.withLock(() => this.get(cmd, 1500));
  }
}

KPA500.BANDS = BANDS;
KPA500.RADIO_INTERFACES = RADIO_INTERFACES;

module.exports = KPA500;
