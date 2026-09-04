import { readFileSync, existsSync } from 'node:fs';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reports, per service and provider, how many interface methods are implemented
// and how many throw UnsupportedError. Run with: bun run coverage
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'provider');
const SERVICES = ['storage','secrets','parameters','messaging','queue','email','monitoring','audit','streaming','cdn','identity','cache','search'];
const PROVIDERS = ['aws','azure','gcp','oci'];

// The body's opening brace is the first '{' that ends a line — signatures can
// themselves contain braces (Go's map[string]interface{}, TS's Promise<{...}>).
function bodyBrace(src, from) {
  for (let j = from; j < src.length; j++) {
    if (src[j] !== '{') continue;
    let k = j + 1;
    while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\r')) k++;
    if (src[k] === '\n') return j;
  }
  return src.indexOf('{', from);
}

function blockAt(src, i) {
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(i, j + 1); }
  }
  return src.slice(i);
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function interfaceMethods(svc) {
  const src = readFileSync(`${ROOT}/types/${svc}.ts`, 'utf8');
  const re = /export interface ([A-Z]\w*)\s*\{/g;
  let m, best = [];
  while ((m = re.exec(src))) {
    const body = blockAt(src, src.indexOf('{', m.index));
    if (!body.includes('Promise<')) continue;
    const names = [];
    for (const line of body.split('\n')) {
      const mm = line.match(/^  ([a-z]\w*)\s*[(<]/);
      if (mm && !names.includes(mm[1])) names.push(mm[1]);
    }
    if (names.length > best.length) best = names;
  }
  return best;
}

// Helpers whose whole job is to produce an UnsupportedError.
function unsupportedHelpers(src) {
  const names = new Set();
  const re = /function\s+(\w*[Uu]nsupported\w*)\s*\(/gi;
  let m;
  while ((m = re.exec(src))) {
    const body = blockAt(src, src.indexOf('{', m.index));
    if (/UnsupportedError/.test(body)) names.add(m[1]);
  }
  return names;
}

function analyse(prov, svc, seen = new Set()) {
  const file = `${ROOT}/${prov}/${svc}.ts`;
  if (!existsSync(file) || seen.has(file)) return {};
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  const helpers = unsupportedHelpers(src);
  const out = {};

  const re = /^  (?:(?:public|private|protected)\s+)?(?:async\s+)?([a-z]\w*)\s*[(<]/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const i = bodyBrace(src, m.index);
    if (i < 0 || name in out) continue;
    const inner = strip(blockAt(src, i)).slice(1, -1).trim();
    // Unsupported only when the body does nothing but raise — a throw inside an
    // `if` is a configuration guard on an otherwise implemented method.
    const callsHelper = [...helpers].some(h => new RegExp(`\\b${h}\\(`).test(inner));
    const helperCall = [...helpers].some(h => new RegExp(`^(?:return\\s+|throw\\s+)?${h}\\([^;]*\\);?$`, 's').test(inner));
    const bareThrow = /^throw\s+[^;]+;?$/s.test(inner) && (/UnsupportedError/.test(inner) || callsHelper);
    out[name] = (helperCall || bareThrow) ? 'unsupported' : 'implemented';
  }

  if (/class\s+\w+\s+extends\s+\w+/.test(src)) {
    for (const other of PROVIDERS) {
      if (other === prov || !new RegExp(`from '\\.\\./${other}/${svc}\\.js'`).test(src)) continue;
      for (const [k, v] of Object.entries(analyse(other, svc, seen))) if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

const rows = []; let total = 0;
const per = Object.fromEntries(PROVIDERS.map(p => [p, { impl: 0, uns: 0, miss: 0 }]));
const gaps = [];

for (const svc of SERVICES) {
  const methods = interfaceMethods(svc);
  total += methods.length;
  const cells = {};
  for (const prov of PROVIDERS) {
    const map = analyse(prov, svc);
    let uns = 0; const missing = []; const unsNames = [];
    for (const n of methods) {
      if (!(n in map)) { missing.push(n); continue; }
      if (map[n] === 'unsupported') { uns++; unsNames.push(n); }
    }
    const impl = methods.length - uns - missing.length;
    per[prov].impl += impl; per[prov].uns += uns; per[prov].miss += missing.length;
    if (unsNames.length) gaps.push(`${svc}/${prov}: ${unsNames.join(', ')}`);
    cells[prov] = missing.length ? `MISSING ${missing.length}` : (uns ? `${impl} + ${uns}X` : `${impl}`);
  }
  rows.push({ svc, n: methods.length, ...cells });
}

const pad = (s, w) => String(s).padEnd(w);
console.log(pad('SERVICE', 13) + pad('METHODS', 9) + PROVIDERS.map(p => pad(p.toUpperCase(), 13)).join(''));
console.log('-'.repeat(74));
for (const r of rows) console.log(pad(r.svc, 13) + pad(r.n, 9) + PROVIDERS.map(p => pad(r[p], 13)).join(''));
console.log('-'.repeat(74));
console.log(pad('TOTAL', 13) + pad(total, 9) + PROVIDERS.map(p => pad(`${per[p].impl} + ${per[p].uns}X`, 13)).join(''));
const impl = PROVIDERS.reduce((a,p)=>a+per[p].impl,0), uns = PROVIDERS.reduce((a,p)=>a+per[p].uns,0), miss = PROVIDERS.reduce((a,p)=>a+per[p].miss,0);
console.log(`\n${impl} implemented + ${uns} unsupported = ${impl+uns} of ${total*4} pairs. Unimplemented: ${miss}.`);
console.log('\nGAPS (X = throws UnsupportedError naming the provider limitation):');
for (const g of gaps) console.log('  ' + g);

