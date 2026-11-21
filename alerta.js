'use strict';

const recordKey = 'asf_alertas';
const xpKey = 'asf_xp';
const legacyExamples = [
  {c: 'ok', p: 'Maresias', t: 'há 2h'},
  {c: 'atencao', p: 'Camburi — corrente no canto esquerdo', t: 'há 40min'},
];
const labels = new Map(Object.entries({
  ondas: 'Ondas', vento: 'Vento', corrente: 'Corrente ou risco percebido', outra: 'Outra observação',
}));
const dateLabel = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
});
const decimal = new Intl.NumberFormat('pt-BR', {maximumFractionDigits: 1});
const beaches = [
  {name: 'Maresias', lat: -23.80, lon: -45.56},
  {name: 'Camburi', lat: -23.77, lon: -45.64},
  {name: 'Ubatuba (Praia Grande)', lat: -23.44, lon: -45.07},
  {name: 'Praia Grande', lat: -24.01, lon: -46.42},
];

const el = id => document.getElementById(id);
const node = (tag, text) => {
  const item = document.createElement(tag);
  item.textContent = text;
  return item;
};
function timestamp(iso) {
  const item = node('time', dateLabel.format(new Date(iso)) + ' (Brasília)');
  item.dateTime = iso;
  return item;
}
function isExample(entry) {
  if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 3) return false;
  return legacyExamples.some(sample => entry.c === sample.c && entry.p === sample.p && entry.t === sample.t);
}
function readRecords() {
  const raw = localStorage.getItem(recordKey);
  if (raw === null) return [];
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error('Invalid local record list');
  const actual = records.filter(entry => !isExample(entry));
  if (actual.length !== records.length) {
    // A failed migration never destroys the previous value; the samples are still hidden.
    try { localStorage.setItem(recordKey, JSON.stringify(actual)); } catch { /* read only */ }
  }
  return actual;
}
function renderRecords(records) {
  const list = node('ul', '');
  for (const entry of records) {
    if (!entry || typeof entry.p !== 'string') continue;
    const item = node('li', '');
    item.append(node('strong', (labels.get(entry.c) || 'Observação anterior') + ': ' + entry.p), node('br', ''));
    if (typeof entry.savedAt === 'string' && Number.isFinite(Date.parse(entry.savedAt))) {
      item.append(timestamp(entry.savedAt));
    } else {
      item.append(node('small', 'Data e hora não registradas.'));
    }
    list.append(item);
  }
  el('lista').replaceChildren(list.childElementCount ? list : node('p', 'Nenhuma observação salva neste navegador.'));
}
function readXp() {
  return Number.parseInt(localStorage.getItem(xpKey), 10) || 0;
}
function awardXp() {
  try {
    localStorage.setItem(xpKey, String(readXp() + 10));
    el('xp').textContent = readXp();
  } catch { /* The observation was already saved; failure to award XP must not undo it. */ }
}
function initRecords() {
  try {
    renderRecords(readRecords());
    el('xp').textContent = readXp();
  } catch {
    el('lista').replaceChildren(node('p', 'Não foi possível ler as observações salvas neste navegador.'));
  }
  el('observation-form').addEventListener('submit', event => {
    event.preventDefault();
    const c = el('c').value;
    const p = el('p').value.trim();
    if (!labels.has(c) || !p) {
      el('local-status').textContent = 'Escolha um tipo de observação e preencha a descrição.';
      return;
    }
    try {
      const records = [{c, p, savedAt: new Date().toISOString()}, ...readRecords()];
      localStorage.setItem(recordKey, JSON.stringify(records));
      renderRecords(records);
      awardXp();
      el('observation-form').reset();
      el('local-status').textContent = 'Observação salva somente neste navegador.';
    } catch {
      el('local-status').textContent = 'Não foi possível salvar a observação neste navegador.';
    }
  });
}

const waveFields = [['wave_height', 'Altura significativa', 'm'], ['wave_period', 'Período', 's'], ['swell_wave_height', 'Swell', 'm']];
const windFields = [['wind_speed_10m', 'Velocidade', 'km/h']];
async function getModel(endpoint, beach, fields) {
  const params = new URLSearchParams({
    latitude: String(beach.lat), longitude: String(beach.lon),
    current: fields.map(([key]) => key).join(','), timeformat: 'unixtime', timezone: 'GMT',
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const reply = await fetch(endpoint + '?' + params, {cache: 'no-store', signal: controller.signal});
    if (!reply.ok) throw new Error('Open-Meteo request failed');
    const {current} = await reply.json();
    return current;
  } finally {
    clearTimeout(timeout);
  }
}
function renderModel(parent, label, result, fields, now) {
  const line = node('p', '');
  line.append(node('strong', label + ': '));
  const sample = result.status === 'fulfilled' && result.value;
  const sampleTime = sample?.time * 1000;
  if (!Number.isSafeInteger(sample?.time) || sampleTime <= 0 ||
      sampleTime > now + 15 * 60_000 || now - sampleTime > 2 * 60 * 60_000) {
    line.append(node('span', 'Sem estimativa recente disponível.'));
  } else {
    const values = fields.map(([key, name, unit]) => {
      const value = sample[key];
      return name + ': ' + (Number.isFinite(value) && value >= 0 ? decimal.format(value) + ' ' + unit : 'indisponível');
    });
    line.append(node('span', values.join(' · ') + ' · Horário do modelo: '), timestamp(new Date(sampleTime).toISOString()));
  }
  parent.append(line);
}
let loading = false;
async function loadModels() {
  if (loading) return;
  loading = true;
  const box = el('live');
  box.setAttribute('aria-busy', 'true');
  try {
    const rows = await Promise.all(beaches.map(async beach => {
      const [waves, wind] = await Promise.allSettled([
        getModel('https://marine-api.open-meteo.com/v1/marine', beach, waveFields),
        getModel('https://api.open-meteo.com/v1/forecast', beach, windFields),
      ]);
      const row = node('div', '');
      row.className = 'praia';
      const details = node('div', '');
      details.append(node('h3', beach.name));
      const now = Date.now();
      renderModel(details, 'Ondas', waves, waveFields, now);
      renderModel(details, 'Vento', wind, windFields, now);
      row.append(details);
      return row;
    }));
    box.replaceChildren(...rows);
  } finally {
    loading = false;
    box.setAttribute('aria-busy', 'false');
  }
}

initRecords();
loadModels();
setInterval(loadModels, 600_000);
