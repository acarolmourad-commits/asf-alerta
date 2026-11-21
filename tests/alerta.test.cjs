const {strict: assert} = require('node:assert');
const {readFileSync} = require('node:fs');
const {test} = require('node:test');
const vm = require('node:vm');

const html = readFileSync(require.resolve('../index.html'), 'utf8');
const script = readFileSync(require.resolve('../alerta.js'), 'utf8');
const now = new Date('2026-11-21T20:30:00.123Z');
const modelTime = Math.floor(now.valueOf() / 1000) - 900;

class Element {
  children = [];
  content = '';
  value = '';
  attr = {};
  get textContent() { return this.content + this.children.map(e => e.textContent).join(' '); }
  set textContent(value) { this.content = String(value); this.children = []; }
  get childElementCount() { return this.children.length; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.content = ''; this.children = items; }
  setAttribute(key, value) { this.attr[key] = value; }
  addEventListener(name, fn) { this[name] = fn; }
  reset() {}
}

async function open(...[storage = new Map(), reply = async () => ({ok: false}), denyWrite = false, expireRequests = false]) {
  const dom = Object.fromEntries(['lista', 'xp', 'local-status', 'observation-form', 'c', 'p', 'live'].map(id => [id, new Element()]));
  const calls = [];
  const timers = [];
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now.valueOf()])); }
    static now() { return now.valueOf(); }
  }
  vm.runInNewContext(script, {
    document: {getElementById: id => dom[id], createElement: () => new Element()},
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (denyWrite) throw Error('blocked storage');
        storage.set(key, value);
      },
    },
    Date: FixedDate, URLSearchParams, AbortController,
    setTimeout: (cb, delay) => {
      assert.equal(delay, 8000);
      return expireRequests ? setImmediate(cb) : null;
    },
    clearTimeout: clearImmediate,
    setInterval: (fn, delay) => timers.push({fn, delay}),
    fetch: async (url, options) => {
      calls.push({url, options});
      return reply(new URL(url), options);
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return {dom, storage, calls, timers};
}

function submit({dom}, c, p) {
  dom.c.value = c;
  dom.p.value = p;
  let prevented = false;
  dom['observation-form'].submit({preventDefault: () => { prevented = true; }});
  assert.equal(prevented, true);
}
const saved = context => JSON.parse(context.storage.get('asf_alertas') ?? '[]');

test('clean context has no built-in reports and writes nothing on load', async () => {
  const clean = await open();
  assert.match(clean.dom.lista.textContent, /Nenhuma observação salva/);
  assert.equal(clean.storage.size, 0);
  assert.equal(clean.calls.length, 8);
  assert.deepEqual(clean.timers.map(x => x.delay), [600000]);
});

test('filters only the exact old examples, preserving real and lookalike entries across reload', async () => {
  const seed = [{c: 'ok', p: 'Maresias', t: 'há 2h'}, {c: 'atencao', p: 'Camburi — corrente no canto esquerdo', t: 'há 40min'}];
  const real = [{c: 'atencao', p: 'Observação real', t: 'agora'}, {...seed[0], t: 'agora'}, {...seed[1], savedAt: '2026-11-21T19:00:00Z'}];
  const migrated = await open(new Map([['asf_alertas', JSON.stringify([...seed, ...real])], ['asf_xp', '50']]));
  assert.deepEqual(saved(migrated), real);
  assert.equal(migrated.storage.get('asf_xp'), '50');
  assert.match(migrated.dom.lista.textContent, /Observação real/);
  assert.match(migrated.dom.lista.textContent, /Data e hora não registradas/);
  assert.doesNotMatch(migrated.dom.lista.textContent, /há 2h|há 40min|agora/);
  assert.deepEqual(saved(await open(migrated.storage)), real);
});

test('records actual ISO time, does not submit to network, preserves text literally and remains browser-local', async () => {
  const local = await open();
  submit(local, 'vento', '  <strong> Praia teste </strong>  ');
  assert.deepEqual(saved(local), [{c: 'vento', p: '<strong> Praia teste </strong>', savedAt: now.toISOString()}]);
  assert.equal(local.storage.get('asf_xp'), '10');
  assert.equal(local.calls.length, 8);
  assert.match(local.dom.lista.textContent, /<strong> Praia teste <\/strong>/);
  assert.match(local.dom['local-status'].textContent, /somente neste navegador/);
  const reload = await open(local.storage);
  const time = reload.dom.lista.children[0].children[0].children[2];
  assert.equal(time.dateTime, now.toISOString());
  assert.match(time.textContent, /Brasília/);
  const separate = await open();
  assert.match(separate.dom.lista.textContent, /Nenhuma observação salva/);
  assert.equal(separate.storage.size, 0);
});

test('invalid categories, malformed data or blocked storage cannot masquerade as saved', async () => {
  const invalid = await open();
  submit(invalid, 'ok', 'teste');
  assert.equal(invalid.storage.size, 0);
  const malformed = await open(new Map([['asf_alertas', '{oops']]));
  submit(malformed, 'vento', 'teste');
  assert.equal(malformed.storage.get('asf_alertas'), '{oops');
  assert.match(malformed.dom['local-status'].textContent, /Não foi possível salvar/);
  const blocked = await open(new Map(), undefined, true);
  submit(blocked, 'vento', 'teste');
  assert.equal(blocked.storage.size, 0);
  assert.match(blocked.dom['local-status'].textContent, /Não foi possível salvar/);
});

test('shows source time and partial data without safety badges; hides stale and failed responses', async () => {
  const c = await open(new Map(), async url => {
    const marine = url.hostname.startsWith('marine-api');
    const lat = url.searchParams.get('latitude');
    assert.equal(url.searchParams.get('timeformat'), 'unixtime');
    if (marine && lat === '-23.8') return {ok: true, json: async () => ({current: {
      time: modelTime, wave_height: 0.4, wave_period: 8, swell_wave_height: null,
    }})};
    if (!marine && lat === '-23.8') return {ok: true, json: async () => ({current: {time: modelTime - 360, wind_speed_10m: 0}})};
    if (marine && lat === '-23.77') return {ok: true, json: async () => ({current: {time: modelTime - 10_000, wave_height: 84}})};
    if (!marine && lat === '-23.77') throw Error('network unavailable');
    if (marine && lat === '-23.44') return {ok: true, json: async () => ({current: {wave_height: 89}})};
    if (!marine && lat === '-23.44') return {ok: true, json: async () => ({current: {time: modelTime + 7200, wind_speed_10m: 98}})};
    return {ok: false, json: async () => ({current: {time: modelTime, wave_height: 99}})};
  });
  const rows = c.dom.live.children;
  assert.equal(c.dom.live.attr['aria-busy'], 'false');
  assert.equal(rows.length, 4);
  assert.match(rows[0].textContent, /Maresias.*0,4 m.*8 s.*Swell: indisponível.*0 km\/h/);
  assert.equal(rows[0].children[0].children[1].children[2].dateTime, new Date(modelTime * 1000).toISOString());
  assert.equal(rows[0].children[0].children[2].children[2].dateTime, new Date((modelTime - 360) * 1000).toISOString());
  assert.match(rows[1].textContent, /Camburi.*Sem estimativa recente disponível/);
  assert.match(rows[2].textContent, /Ubatuba.*Sem estimativa recente disponível/);
  assert.match(rows[3].textContent, /Praia Grande.*Sem estimativa recente disponível/);
  assert.doesNotMatch(c.dom.live.textContent, /\b(?:Boa|Perigo|Atenção)\b|84 m|89 m|98 km\/h|99 m/);
});

test('refresh removes previously usable readings when the responses are unavailable', async () => {
  let ok = true;
  const c = await open(new Map(), async () => ({ok, json: async () => ({current: {time: modelTime, wave_height: 8.8, wind_speed_10m: 20}})}));
  assert.match(c.dom.live.textContent, /8,8 m/);
  ok = false;
  await c.timers[0].fn();
  assert.doesNotMatch(c.dom.live.textContent, /8,8 m/);
  assert.match(c.dom.live.textContent, /Sem estimativa recente disponível/);
});

test('hanging forecast requests abort and leave no permanently busy model section', async () => {
  let aborted = 0;
  const c = await open(new Map(), async (_, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted++;
      reject(Error('aborted'));
    }, {once: true});
  }), false, true);
  assert.equal(aborted, 8);
  assert.equal(c.dom.live.attr['aria-busy'], 'false');
  assert.equal(c.dom.live.children.length, 4);
  assert.match(c.dom.live.textContent, /Sem estimativa recente disponível/);
});

test('visible FAQ and JSON-LD match; local protocol, sources and forecasts remain linked', () => {
  const schema = [...html.matchAll(/<script type="application\/ld\+json">\s*(.*?)\s*<\/script>/gs)]
    .map(m => JSON.parse(m[1])).find(s => s['@type'] === 'FAQPage');
  const visible = [...html.matchAll(/<details><summary>(.*?)<\/summary><p>(.*?)<\/p><\/details>/gs)].map(m => m.slice(1));
  assert.deepEqual(schema.mainEntity.map(q => [q.name, q.acceptedAnswer.text]), visible);
  assert.match(html, /<b>193<\/b>.*Corpo de Bombeiros/);
  assert.match(html, /<b>192<\/b>.*SAMU/);
  assert.match(html, /ubatuba\.sp\.gov\.br\/noticias\/legado\/orientacoesgvtechamamento/);
  assert.match(html, /open-meteo\.com\/en\/docs\/marine-weather-api/);
  assert.match(html, /github\.io\/asf-previsao\//);
  assert.match(html, /github\.io\/asf-sos\//);
  assert.doesNotMatch(html, /20.50 m|0,3 a 0,8|1,2 m|condições tranquilas|devem ficar no raso|Alertas da comunidade|tempo real/i);
  assert.doesNotMatch(script, /innerHTML|function classifica/);
});
