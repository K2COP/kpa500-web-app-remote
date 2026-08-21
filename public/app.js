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

const el = (id) => document.getElementById(id);

const bandSelect = el('bandSelect');
BANDS.forEach((b) => {
  const opt = document.createElement('option');
  opt.value = b.code;
  opt.textContent = b.label;
  bandSelect.appendChild(opt);
});

let suppressBandChange = false;
let currentState = {};

async function postCommand(action, value) {
  const res = await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error('command failed', action, body.error);
    alert(`${action} failed: ${body.error || res.statusText}`);
  }
}

// --- Power -----------------------------------------------------------------

el('powerOnBtn').addEventListener('click', () => postCommand('powerOn'));
el('powerOffBtn').addEventListener('click', () => {
  if (confirm('Power off the KPA500? This soft-powers down the amplifier.')) {
    postCommand('powerOff');
  }
});

// --- Operate / Standby -------------------------------------------------------

document.querySelectorAll('.operate-btn').forEach((btn) => {
  btn.addEventListener('click', () => postCommand('operate', btn.dataset.op === '1'));
});

// --- Band --------------------------------------------------------------------

bandSelect.addEventListener('change', () => {
  if (suppressBandChange) return;
  postCommand('band', bandSelect.value);
});

el('clearFaultBtn').addEventListener('click', () => postCommand('clearFault'));

// --- Power adjust --------------------------------------------------------------

el('powerAdjustSetBtn').addEventListener('click', () => {
  postCommand('powerAdjust', Number(el('powerAdjustInput').value));
});

// --- Advanced settings ---------------------------------------------------------

el('alcSetBtn').addEventListener('click', () => postCommand('alcThreshold', Number(el('alcInput').value)));
el('fanSetBtn').addEventListener('click', () => postCommand('fanMin', Number(el('fanInput').value)));
el('trSetBtn').addEventListener('click', () => postCommand('trDelay', Number(el('trInput').value)));
el('arSetBtn').addEventListener('click', () => postCommand('attenRelease', Number(el('arInput').value)));

function wireToggle(offId, onId, action) {
  el(offId).addEventListener('click', () => postCommand(action, false));
  el(onId).addEventListener('click', () => postCommand(action, true));
}
wireToggle('bcOffBtn', 'bcOnBtn', 'stbyOnBandChange');
wireToggle('nhOffBtn', 'nhOnBtn', 'inhibit');
wireToggle('spOffBtn', 'spOnBtn', 'speaker');
wireToggle('dmoOffBtn', 'dmoOnBtn', 'demoMode');

el('xiSetBtn').addEventListener('click', () => {
  const type = Number(el('xiTypeSelect').value);
  const option = currentState.radioInterfaceOption ? 1 : 0;
  postCommand('radioInterface', { type, option });
});
el('xiOptOffBtn').addEventListener('click', () => {
  postCommand('radioInterface', { type: Number(el('xiTypeSelect').value), option: 0 });
});
el('xiOptOnBtn').addEventListener('click', () => {
  postCommand('radioInterface', { type: Number(el('xiTypeSelect').value), option: 1 });
});

// --- Connection ----------------------------------------------------------------

el('refreshPortsBtn').addEventListener('click', loadPorts);
el('connectBtn').addEventListener('click', async () => {
  const portSelect = el('portSelect');
  const baudSelect = el('baudSelect');
  const path = portSelect.value;
  if (!path) return;
  const res = await fetch('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, baud: baudSelect.value ? Number(baudSelect.value) : null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(`Connect failed: ${body.error || res.statusText}`);
  }
});

// --- Raw console -----------------------------------------------------------------

el('rawSendBtn').addEventListener('click', sendRaw);
el('rawInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendRaw();
});
function sendRaw() {
  const input = el('rawInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  postCommand('raw', cmd);
  input.value = '';
}

async function loadPorts() {
  const res = await fetch('/api/ports');
  const ports = await res.json();
  const select = el('portSelect');
  select.innerHTML = '';
  ports.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = `${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}`;
    select.appendChild(opt);
  });
  syncPortSelection();
}

function syncPortSelection() {
  const select = el('portSelect');
  if (currentState.path && [...select.options].some((o) => o.value === currentState.path)) {
    select.value = currentState.path;
  }
}

function renderState(state) {
  currentState = state;
  syncPortSelection();

  const indicator = el('connIndicator');
  const connText = el('connText');
  indicator.classList.remove('connected', 'connecting', 'disconnected');
  if (state.connected) {
    indicator.classList.add('connected');
    connText.textContent = `Connected @ ${state.baud} baud`;
  } else if (state.connecting) {
    indicator.classList.add('connecting');
    connText.textContent = 'Connecting…';
  } else {
    indicator.classList.add('disconnected');
    connText.textContent = state.lastError ? `Disconnected: ${state.lastError}` : 'Disconnected';
  }

  const powerStatus = el('powerStatus');
  if (state.power === true) {
    powerStatus.textContent = 'ON';
    powerStatus.classList.add('on');
    powerStatus.classList.remove('off');
  } else if (state.power === false) {
    powerStatus.textContent = 'OFF';
    powerStatus.classList.add('off');
    powerStatus.classList.remove('on');
  } else {
    powerStatus.textContent = 'Unknown';
    powerStatus.classList.remove('on', 'off');
  }
  el('powerOnBtn').disabled = state.power !== false || !state.connected;
  el('powerOffBtn').disabled = state.power !== true || !state.connected;

  document.querySelectorAll('.operate-btn').forEach((btn) => {
    const isOperate = btn.dataset.op === '1';
    btn.classList.toggle('active', state.operate === isOperate);
  });

  if (state.band) {
    suppressBandChange = true;
    bandSelect.value = state.band;
    suppressBandChange = false;
  }

  const fault = state.fault || 0;
  const faultBanner = el('faultBanner');
  if (fault !== 0) {
    faultBanner.classList.remove('hidden');
    el('faultText').textContent = state.faultMessage || `Fault ${fault}`;
  } else {
    faultBanner.classList.add('hidden');
  }

  el('wattsValue').textContent = state.watts != null ? state.watts : '—';
  el('swrValue').textContent = state.swr != null ? `${state.swr.toFixed(1)}:1` : '—';
  const bar = el('swrBar');
  const swr = state.swr != null && state.swr > 0 ? state.swr : 1;
  const pct = Math.max(0, Math.min(100, ((swr - 1) / (5 - 1)) * 100));
  bar.style.width = `${pct}%`;

  el('voltsValue').textContent = state.volts != null ? state.volts.toFixed(1) : '—';
  el('ampsValue').textContent = state.amps != null ? state.amps.toFixed(1) : '—';
  el('tempValue').textContent = state.tempC != null ? state.tempC : '—';

  if (document.activeElement !== el('powerAdjustInput') && state.powerAdjust != null) {
    el('powerAdjustInput').value = state.powerAdjust;
  }
  if (document.activeElement !== el('alcInput') && state.alcThreshold != null) {
    el('alcInput').value = state.alcThreshold;
  }
  if (document.activeElement !== el('fanInput') && state.fanMin != null) {
    el('fanInput').value = state.fanMin;
  }
  if (document.activeElement !== el('trInput') && state.trDelay != null) {
    el('trInput').value = state.trDelay;
  }
  if (document.activeElement !== el('arInput') && state.attenRelease != null) {
    el('arInput').value = state.attenRelease;
  }

  setTogglePair('bcOffBtn', 'bcOnBtn', state.stbyOnBandChange);
  setTogglePair('nhOffBtn', 'nhOnBtn', state.inhibitEnabled);
  setTogglePair('spOffBtn', 'spOnBtn', state.speakerOn);
  setTogglePair('dmoOffBtn', 'dmoOnBtn', state.demoMode);
  setTogglePair('xiOptOffBtn', 'xiOptOnBtn', state.radioInterfaceOption === 1);

  if (document.activeElement !== el('xiTypeSelect') && state.radioInterfaceType != null) {
    el('xiTypeSelect').value = String(state.radioInterfaceType);
  }

  el('fwValue').textContent = state.firmware || '—';
  el('snValue').textContent = state.serialNumber || '—';
  el('portValue').textContent = state.path || '—';
}

function setTogglePair(offId, onId, value) {
  if (value == null) {
    el(offId).classList.remove('active');
    el(onId).classList.remove('active');
    return;
  }
  el(offId).classList.toggle('active', value === false);
  el(onId).classList.toggle('active', value === true);
}

function appendLog(line) {
  const out = el('logOutput');
  out.textContent += `${line}\n`;
  out.scrollTop = out.scrollHeight;
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'state') renderState(msg.payload);
    if (msg.type === 'log') appendLog(msg.payload);
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

async function init() {
  await loadPorts();
  const res = await fetch('/api/state');
  renderState(await res.json());
  connectWs();
}

init();
