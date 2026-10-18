// build.js: the bundler and generator (docs/ARCHITECTURE.md, "build.js").
//
//   node build.js          write openbill.html, methodology.html and docs/DATA-QUALITY.md
//   node build.js --check  exit 1, listing every generated file that is out of date
//
// Importing this file has no side effects: buildAll() reads the inputs and returns the
// generated files as strings, so tests/build.test.js can compare them with the committed ones.
// Nothing generated contains a build time; the same inputs give byte-identical outputs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packDrugs } from './src/core/pack.js';
import { esc, safeHref } from './src/core/esc.js';
import { REPO_URL, APP_NAME } from './src/core/config.js';
import { STATE_INFO, PRICE_STATES } from './src/core/provenance.js';
import { HONESTY, RULES } from './src/core/rules.js';
import { SOURCE_INFO } from './src/core/sources.js';
import { renderMethodology } from './src/build/methodology.js';
import { renderDataQuality } from './src/build/quality.js';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The bundle's entry module, repo-relative. */
export const ENTRY = 'src/app/app.js';

/** The card shown when the page opens with no #drug= in the URL. */
export const DEFAULT_PRODUCT = Object.freeze({ drug: 'METFORMIN HCL 500 MG TABLET', qty: 60 });

/** The "Try:" links under the card. Each must be a product in data/drugs.json, or the build fails. */
export const TRY_PRODUCTS = Object.freeze([
  'ELIQUIS 5 MG TABLET',
  'ATORVASTATIN 20 MG TABLET',
  'LISINOPRIL 10 MG TABLET',
  'HUMULIN R 100 UNIT/ML VIAL',
]);

/** openbill.html must stay under this many bytes; the build fails above it. */
export const SIZE_LIMIT = 5 * 1024 * 1024;
/** Above this many bytes the build prints a warning. */
export const SIZE_WARN = 3 * 1024 * 1024;

const FONTS = Object.freeze([
  { family: 'IBM Plex Sans', weight: 400, file: 'src/app/fonts/ibm-plex-sans-latin-400-normal.woff2' },
  { family: 'IBM Plex Sans', weight: 600, file: 'src/app/fonts/ibm-plex-sans-latin-600-normal.woff2' },
  { family: 'IBM Plex Mono', weight: 400, file: 'src/app/fonts/ibm-plex-mono-latin-400-normal.woff2' },
]);

// The latin subset's unicode-range, as @fontsource writes it for these files.
const LATIN_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

const TEXT_EXT = new Set(['.js', '.css', '.html', '.json', '.md', '.txt', '.yml']);

// ---------------------------------------------------------------------------------------------
// Inputs

function readInput(rel) {
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);
  // Text inputs are read with LF line ends whatever the checkout did, so a Windows checkout
  // with CRLF builds the same bytes as CI.
  if (TEXT_EXT.has(path.extname(rel).toLowerCase())) return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return buf;
}

function readText(rel) {
  return readInput(rel).toString('utf8');
}

function listFiles(relDir) {
  const out = [];
  const abs = path.join(ROOT, relDir);
  if (!fs.existsSync(abs)) return out;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${ent.name}`;
    if (ent.isDirectory()) out.push(...listFiles(rel));
    else if (ent.isFile() && ent.name !== '.gitkeep') out.push(rel);
  }
  return out;
}

/** Every file whose bytes the build depends on, repo-relative, sorted. */
export function inputFiles() {
  const files = ['build.js', 'data/drugs.json', ...listFiles('src')];
  return [...new Set(files)].sort();
}

/**
 * The build id: the first 12 hex digits of the sha256 of every input (path, length and bytes,
 * in sorted path order). Deterministic: no clock.
 * @returns {string}
 */
export function computeBuildId() {
  const h = crypto.createHash('sha256');
  for (const rel of inputFiles()) {
    const buf = readInput(rel);
    h.update(rel);
    h.update('\0');
    h.update(String(buf.length));
    h.update('\0');
    h.update(buf);
  }
  return h.digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------------------------
// The bundler

const IMPORT_RE = /^import \{ ([A-Za-z_$][\w$]*(?:, [A-Za-z_$][\w$]*)*) \} from '(\.\.?\/[^']+\.js)';$/;
const EXPORT_RE = /^export (async function\*? |function\*? |const |class )([A-Za-z_$][\w$]*)/;

const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

/**
 * For each line of a module, whether it starts in top-level code: not inside a string, a
 * template literal (or a ${…} inside one), a block comment or a regular expression literal.
 * A small tokenizer, enough for the bundler to tell a real `export` or `import` statement from
 * the same text inside a template literal or a comment. Throws on an unterminated literal.
 * @param {string} source
 * @returns {boolean[]} one entry per line of source.split('\n')
 */
export function codeLineStarts(source, rel = 'module') {
  const starts = [true];
  const stack = []; // template-expression brace depths; each entry is a ${…} inside a template
  let state = 'code';
  let braces = 0;
  let prev = ''; // the last significant code token's last character, or a keyword
  let word = '';
  let inClass = false;
  const n = source.length;
  for (let i = 0; i < n; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '\n') {
      if (state === 'line') state = 'code';
      else if (state === 'single' || state === 'double' || state === 'regex') throw new Error(`${rel}:${starts.length}: unterminated string or regular expression`);
      starts.push(state === 'code' && stack.length === 0);
      if (state === 'code' && word) {
        prev = word;
        word = '';
      }
      continue;
    }
    switch (state) {
      case 'line':
        break;
      case 'block':
        if (c === '*' && next === '/') {
          state = 'code';
          i++;
        }
        break;
      case 'single':
      case 'double':
        if (c === '\\') {
          i++;
          if (source[i] === '\n') starts.push(false); // a line continuation inside the string
        }
        else if ((state === 'single' && c === "'") || (state === 'double' && c === '"')) {
          state = 'code';
          prev = 'x';
        }
        break;
      case 'template':
        if (c === '\\') {
          i++;
          if (source[i] === '\n') starts.push(false);
        }
        else if (c === '`') {
          state = 'code';
          prev = 'x';
        } else if (c === '$' && next === '{') {
          stack.push(braces);
          braces = 0;
          state = 'code';
          prev = '(';
          i++;
        }
        break;
      case 'regex':
        if (c === '\\') i++;
        else if (inClass) {
          if (c === ']') inClass = false;
        } else if (c === '[') inClass = true;
        else if (c === '/') {
          state = 'code';
          while (/[a-z]/.test(source[i + 1] || '')) i++;
          prev = 'x';
        }
        break;
      default: {
        if (/[A-Za-z0-9_$]/.test(c)) {
          word += c;
          continue;
        }
        if (word) {
          prev = word;
          word = '';
        }
        if (/\s/.test(c)) continue;
        if (c === '/' && next === '/') state = 'line';
        else if (c === '/' && next === '*') {
          state = 'block';
          i++;
        } else if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '`') state = 'template';
        else if (c === '/') {
          const regexOk = prev === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || REGEX_AFTER_WORDS.has(prev);
          if (regexOk) {
            state = 'regex';
            inClass = false;
          } else prev = '/';
        } else if (c === '{') {
          braces++;
          prev = '{';
        } else if (c === '}') {
          if (braces === 0 && stack.length) {
            braces = stack.pop();
            state = 'template';
          } else {
            braces--;
            prev = '}';
          }
        } else prev = c;
      }
    }
  }
  if (state !== 'code' && state !== 'line') throw new Error(`${rel}: unterminated ${state === 'block' ? 'block comment' : state === 'template' ? 'template literal' : 'string or regular expression'} at the end of the file`);
  return starts;
}

/**
 * Parse one module under the convention in docs/ARCHITECTURE.md: single-line named imports
 * from relative paths, and `export function|async function|const|class name`. Anything else
 * that imports or exports throws, naming the file and line. Only lines that start in
 * top-level code count (codeLineStarts): `export …` at column 0 inside a template literal or
 * a block comment is text, and is left exactly as it is.
 * @param {string} rel repo-relative path
 * @param {string} source
 * @returns {{ rel: string, imports: { from: string, names: string[] }[], exports: string[], body: string }}
 */
export function parseModule(rel, source) {
  const imports = [];
  const exports = [];
  const body = [];
  const lines = source.split('\n');
  const code = codeLineStarts(source, rel);
  lines.forEach((line, i) => {
    const where = `${rel}:${i + 1}`;
    const trimmed = line.trim();
    if (!code[i]) {
      body.push(line);
      return;
    }
    if (/^import\b/.test(trimmed)) {
      if (line !== trimmed) throw new Error(`${where}: imports must start at column 0: ${trimmed}`);
      const m = IMPORT_RE.exec(trimmed);
      if (!m) throw new Error(`${where}: only single-line named imports from a relative .js path are allowed (import { a, b } from './x.js';), got: ${trimmed}`);
      const from = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2]));
      imports.push({ from, names: m[1].split(', '), line: i + 1 });
      body.push('');
      return;
    }
    if (/\bimport\s*\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) throw new Error(`${where}: dynamic import() is not allowed`);
    if (/\bimport\.meta\b/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) throw new Error(`${where}: import.meta is not allowed in bundled modules`);
    if (/^export\b/.test(trimmed)) {
      if (line !== trimmed) throw new Error(`${where}: exports must start at column 0: ${trimmed}`);
      const m = EXPORT_RE.exec(trimmed);
      if (!m) throw new Error(`${where}: only export function, export async function, export const and export class are allowed (no default exports, export lists or re-exports), got: ${trimmed}`);
      if (exports.includes(m[2])) throw new Error(`${where}: ${m[2]} is exported twice`);
      exports.push(m[2]);
      body.push(line.replace(/^export /, ''));
      return;
    }
    body.push(line);
  });
  return { rel, imports, exports, body: body.join('\n') };
}

/**
 * Bundle the entry and every module it imports, transitively, into one classic script.
 * Modules are ordered so each comes after its imports (a cycle throws), each runs in its own
 * function scope that returns its exports, and imports are wired by destructuring.
 * @param {string} [entry]
 * @param {(rel: string) => string} [read]
 * @returns {{ code: string, modules: string[] }}
 */
export function bundle(entry = ENTRY, read = readText) {
  const mods = new Map();
  const order = [];
  const top = `${entry.split('/')[0]}/`; // src/ for the page
  const state = new Map(); // rel → 'visiting' | 'done'
  const visit = (rel, chain) => {
    const s = state.get(rel);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`import cycle: ${[...chain, rel].join(' → ')}`);
    state.set(rel, 'visiting');
    let source;
    try {
      source = read(rel);
    } catch (e) {
      throw new Error(`${chain.length ? chain[chain.length - 1] : 'entry'} imports ${rel}, which cannot be read: ${e.message}`);
    }
    const mod = parseModule(rel, source);
    mods.set(rel, mod);
    for (const imp of mod.imports) {
      // inputFiles() hashes src/** into the build id; a module outside the entry's top folder (src/) would change the
      // page without changing the id, so it is refused.
      if (!imp.from.startsWith(top)) throw new Error(`${rel}:${imp.line}: imports ${imp.from}, which is outside ${top}; the bundle takes modules from ${top} only`);
      visit(imp.from, [...chain, rel]);
    }
    state.set(rel, 'done');
    order.push(rel);
  };
  visit(entry, []);

  const varName = new Map(order.map((rel, i) => [rel, `__m${i}`]));
  const parts = ["(function () {\n'use strict';\n"];
  for (const rel of order) {
    const mod = mods.get(rel);
    const declared = new Set();
    let head = '';
    for (const imp of mod.imports) {
      const dep = mods.get(imp.from);
      for (const n of imp.names) {
        if (!dep.exports.includes(n)) throw new Error(`${rel}:${imp.line}: ${imp.from} does not export ${n}`);
        if (declared.has(n)) throw new Error(`${rel}:${imp.line}: ${n} is imported twice`);
        declared.add(n);
      }
      head += `const { ${imp.names.join(', ')} } = ${varName.get(imp.from)};\n`;
    }
    const ret = mod.exports.length ? `return { ${mod.exports.join(', ')} };` : 'return {};';
    parts.push(`// ---- ${rel}\nconst ${varName.get(rel)} = (function () {\n${head}${mod.body.replace(/\s+$/, '')}\n${ret}\n})();\n`);
  }
  parts.push('})();\n');
  const code = parts.join('');
  if (/<\/script|<!--/i.test(code)) throw new Error('the bundle contains "</script" or "<!--", which would end the inline script early');
  // Compile the bundle, so a name clash between an import and a declaration fails here, then run
  // it once against an empty page: every module's top level runs, so an export that names no
  // declaration (a ReferenceError) fails the build instead of the page. The page code finds no
  // elements and stops at its own error handling.
  const script = new vm.Script(code, { filename: 'openbill-bundle.js' });
  runAgainstEmptyPage(script);
  return { code, modules: order };
}

function runAgainstEmptyPage(script) {
  const root = { dataset: {} };
  const context = vm.createContext({
    performance: { now: () => 0 },
    document: { getElementById: () => null, documentElement: root, querySelectorAll: () => [], title: '' },
    location: { hash: '' },
    history: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console: { log() {}, warn() {}, error() {} },
  });
  try {
    script.runInContext(context, { timeout: 5000 });
  } catch (e) {
    throw new Error(`the bundle fails when it runs: ${e && e.message ? e.message : e}`);
  }
}

// ---------------------------------------------------------------------------------------------
// A deterministic DEFLATE encoder (RFC 1951, one block with the fixed Huffman codes).
// The page decodes it with the browser's own DecompressionStream('deflate-raw'). It is written
// here rather than taken from zlib because zlib's output can differ between builds and CPUs,
// and the generated page must be byte-identical everywhere.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function reverseBits(v, n) {
  let r = 0;
  for (let i = 0; i < n; i++) {
    r = (r << 1) | (v & 1);
    v >>>= 1;
  }
  return r;
}

let fixedTables = null;
function tables() {
  if (fixedTables) return fixedTables;
  const litCode = new Uint16Array(288);
  const litBits = new Uint8Array(288);
  for (let c = 0; c < 288; c++) {
    let code;
    let bits;
    if (c < 144) [code, bits] = [0x30 + c, 8];
    else if (c < 256) [code, bits] = [0x190 + (c - 144), 9];
    else if (c < 280) [code, bits] = [c - 256, 7];
    else [code, bits] = [0xc0 + (c - 280), 8];
    litCode[c] = reverseBits(code, bits);
    litBits[c] = bits;
  }
  const distCodeRev = new Uint8Array(30);
  for (let d = 0; d < 30; d++) distCodeRev[d] = reverseBits(d, 5);
  const lenSym = new Uint8Array(259);
  for (let s = 0; s < 29; s++) {
    const hi = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
    for (let l = LEN_BASE[s]; l <= hi; l++) lenSym[l] = s;
  }
  lenSym[258] = 28;
  const distSym = new Uint8Array(32769);
  for (let s = 0; s < 30; s++) {
    const hi = s === 29 ? 32768 : DIST_BASE[s + 1] - 1;
    for (let d = DIST_BASE[s]; d <= hi; d++) distSym[d] = s;
  }
  fixedTables = { litCode, litBits, distCodeRev, lenSym, distSym };
  return fixedTables;
}

/**
 * Compress bytes as raw DEFLATE (no zlib or gzip header): LZ77 with hash chains and one-step
 * lazy matching, encoded in a single final block with the fixed Huffman codes. Pure and
 * deterministic. zlib.inflateRawSync() of the result gives the input back.
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 */
export function deflateRawFixed(input) {
  const { litCode, litBits, distCodeRev, lenSym, distSym } = tables();
  const n = input.length;
  let out = new Uint8Array(Math.max(1024, (n >>> 2) + 1024));
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  const put = (value, bits) => {
    bitBuf |= value << bitCnt;
    bitCnt += bits;
    while (bitCnt >= 8) {
      if (pos >= out.length) {
        const bigger = new Uint8Array(out.length * 2);
        bigger.set(out);
        out = bigger;
      }
      out[pos++] = bitBuf & 0xff;
      bitBuf >>>= 8;
      bitCnt -= 8;
    }
  };
  const lit = (c) => put(litCode[c], litBits[c]);
  const match = (len, dist) => {
    const ls = lenSym[len];
    lit(257 + ls);
    if (LEN_EXTRA[ls]) put(len - LEN_BASE[ls], LEN_EXTRA[ls]);
    const ds = distSym[dist];
    put(distCodeRev[ds], 5);
    if (DIST_EXTRA[ds]) put(dist - DIST_BASE[ds], DIST_EXTRA[ds]);
  };

  put(1, 1); // BFINAL
  put(1, 2); // BTYPE 01: fixed Huffman codes

  const WSIZE = 32768;
  const WMASK = WSIZE - 1;
  const HBITS = 16;
  const head = new Int32Array(1 << HBITS).fill(-1);
  const prev = new Int32Array(WSIZE).fill(-1);
  const MAX_CHAIN = 48;
  const GOOD_ENOUGH = 128;
  const hash = (i) => (Math.imul((input[i] << 16) | (input[i + 1] << 8) | input[i + 2], 2654435761) >>> (32 - HBITS));
  const insert = (i) => {
    if (i + 2 >= n) return;
    const h = hash(i);
    prev[i & WMASK] = head[h];
    head[h] = i;
  };
  let bestLen = 0;
  let bestDist = 0;
  const find = (i) => {
    bestLen = 0;
    bestDist = 0;
    if (i + 2 >= n) return;
    const max = Math.min(258, n - i);
    let cand = head[hash(i)];
    let chain = MAX_CHAIN;
    while (cand >= 0 && i - cand <= WSIZE && chain-- > 0) {
      if (input[cand + bestLen] === input[i + bestLen] && input[cand] === input[i]) {
        let l = 0;
        while (l < max && input[cand + l] === input[i + l]) l++;
        if (l > bestLen) {
          bestLen = l;
          bestDist = i - cand;
          if (l >= max || l >= GOOD_ENOUGH) break;
        }
      }
      const next = prev[cand & WMASK];
      if (next >= cand) break;
      cand = next;
    }
    if (bestLen < 3) bestLen = 0;
  };

  let i = 0;
  let havePrev = false;
  let prevLen = 0;
  let prevDist = 0;
  while (i < n) {
    find(i);
    const len = bestLen;
    const dist = bestDist;
    insert(i);
    if (havePrev) {
      if (prevLen >= len) {
        match(prevLen, prevDist);
        const end = i - 1 + prevLen;
        for (let j = i + 1; j < end; j++) insert(j);
        i = end;
        havePrev = false;
        continue;
      }
      lit(input[i - 1]);
    }
    if (len >= GOOD_ENOUGH) {
      match(len, dist);
      for (let j = i + 1; j < i + len; j++) insert(j);
      i += len;
      havePrev = false;
    } else if (len >= 3) {
      havePrev = true;
      prevLen = len;
      prevDist = dist;
      i++;
    } else {
      havePrev = false;
      lit(input[i]);
      i++;
    }
  }
  if (havePrev) match(prevLen, prevDist);
  lit(256); // end of block
  if (bitCnt > 0) put(0, 8 - bitCnt);
  return out.slice(0, pos);
}

// ---------------------------------------------------------------------------------------------
// Page pieces

function sha256Base64(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('base64');
}

/**
 * The CSP for a page with these inline scripts and styles: each allowed by its own sha256 hash.
 * @param {string[]} scripts
 * @param {string[]} styles
 * @returns {string}
 */
export function cspFor(scripts, styles) {
  const list = (xs) => (xs.length ? xs.map((x) => `'sha256-${sha256Base64(x)}'`).join(' ') : "'none'");
  return `default-src 'none'; script-src ${list(scripts)}; style-src ${list(styles)}; font-src data:; img-src data:; base-uri 'none'; form-action 'none'`;
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function fontFaces() {
  return FONTS.map((f) => {
    const b64 = readInput(f.file).toString('base64');
    return `@font-face {\n  font-family: '${f.family}';\n  font-style: normal;\n  font-weight: ${f.weight};\n  font-display: swap;\n  src: url(data:font/woff2;base64,${b64}) format('woff2');\n  unicode-range: ${LATIN_RANGE};\n}\n`;
  }).join('');
}

function fill(template, values, what) {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    const token = `{{${key}}}`;
    const count = out.split(token).length - 1;
    if (count !== 1) throw new Error(`${what}: placeholder ${token} appears ${count} times, expected once`);
    out = out.split(token).join(value);
  }
  const left = /\{\{[A-Z_]+\}\}/.exec(out);
  if (left) throw new Error(`${what}: placeholder ${left[0]} was not filled`);
  return out;
}

function hashFor(drug, qty) {
  return `#drug=${encodeURIComponent(drug)}${qty === undefined ? '' : `&qty=${encodeURIComponent(String(qty))}`}`;
}

function honestyText(id) {
  const line = HONESTY.find((h) => h.id === id);
  if (!line) throw new Error(`HONESTY has no line ${id}`);
  return line;
}

function honestyHtml(id) {
  return honestyText(id)
    .parts.map((p) => (p.strong ? `<strong>${esc(p.text)}</strong>` : esc(p.text)))
    .join('');
}

/** The disclaimer, from HONESTY "disclaimer" without its "Disclaimer footer:" label. */
export function disclaimerText() {
  const t = honestyText('disclaimer').text;
  const m = /^Disclaimer footer:\s*(.+)$/.exec(t);
  return m ? `Disclaimer: ${m[1]}` : t;
}

function periodText(p) {
  if (!p) return '';
  const [a, b] = String(p).split('/');
  return `${a} to ${b}`;
}

function sourceLines(doc) {
  const order = ['nadac', 'fda_ndc', 'partd', 'asp_limits', 'asp_crosswalk'];
  const ids = [...order.filter((k) => doc.sources[k]), ...Object.keys(doc.sources).filter((k) => !order.includes(k)).sort()];
  return ids
    .map((id) => {
      const s = doc.sources[id];
      // A source link comes from the data; only an https:// URL with a plain host is linked.
      if (!safeHref(s.source_url) || !/^https:/.test(s.source_url)) throw new Error(`data/drugs.json sources.${id}.source_url is not an https:// URL: ${JSON.stringify(s.source_url)}`);
      const bits = [
        s.source_file,
        s.period ? `period ${periodText(s.period)}` : null,
        s.as_of_date ? `as of ${s.as_of_date}` : null,
        `retrieved ${s.retrieved_date}`,
      ].filter(Boolean);
      return `<li><a href="${esc(s.source_url)}" rel="noopener">${esc(s.name || (SOURCE_INFO[id] && SOURCE_INFO[id].label) || id)}</a> <span class="mono">${bits.map(esc).join(' · ')}</span></li>`;
    })
    .join('\n');
}

function footerHtml(doc, buildId, { home }) {
  return `<footer class="site-footer">
<p class="disclaimer">${esc(disclaimerText())}</p>
<p>${honestyHtml('range')}</p>
<h2 class="footer-head">Sources in this build</h2>
<ul class="footer-sources">
${sourceLines(doc)}
</ul>
<ul class="footer-links">
<li><a href="${home ? 'methodology.html' : 'openbill.html'}">${home ? 'Methodology' : 'Back to OpenBill'}</a></li>
${home ? '' : '<li><a href="methodology.html">Methodology</a></li>\n'}<li><a href="${esc(REPO_URL)}" rel="noopener">Source code on GitHub</a></li>
<li><a href="data/drugs.json">data/drugs.json</a></li>
</ul>
<p class="mono build-line">build ${esc(buildId)}</p>
</footer>`;
}

function howToReadHtml() {
  const items = PRICE_STATES.map(
    (s) => `<li><span class="chip chip-${esc(s)}">${esc(STATE_INFO[s].label)}</span> <span>${esc(STATE_INFO[s].summary)}</span></li>`,
  ).join('\n');
  return `<section class="howto" aria-labelledby="howto-title">
<h2 id="howto-title">How to read a card</h2>
<p>Every number carries a label that says how we know it, strongest first:</p>
<ul class="howto-states">
${items}
<li><span class="chip chip-stale">stale</span> <span>The source file is older than its publisher’s schedule says it should be. The figure is still shown, never hidden or zeroed.</span></li>
</ul>
<p>Under each number is its source line: the dataset, the exact file, the date the price took effect, the file’s own date and the date we downloaded it. “Sources and method” on the card opens every figure in full.</p>
</section>`;
}

function stampHtml(doc, buildId) {
  const nadac = doc.sources.nadac;
  return `<header class="masthead">
<a class="stamp" href="openbill.html" aria-label="${esc(APP_NAME)} drug price receipt, home"><span class="stamp-name">${esc(APP_NAME)}</span><span class="stamp-sub">drug price receipt</span></a>
<p class="mono masthead-line">NADAC week of ${esc(nadac.as_of_date)}</p>
</header>`;
}

// ---------------------------------------------------------------------------------------------
// buildAll

function sourceDates(doc) {
  const out = {};
  for (const [id, s] of Object.entries(doc.sources)) {
    out[id] = {
      name: s.name,
      source_url: s.source_url,
      source_file: s.source_file,
      period: s.period === undefined ? null : s.period,
      as_of_date: s.as_of_date === undefined ? null : s.as_of_date,
      retrieved_date: s.retrieved_date,
    };
  }
  return out;
}

/**
 * Encode the packed data for the page: the JSON text of packDrugs(doc), compressed with
 * deflateRawFixed and base64-encoded, wrapped in a small JSON descriptor.
 * @param {object} doc
 * @returns {{ descriptor: object, jsonText: string }}
 */
export function encodeData(doc) {
  const jsonText = JSON.stringify(packDrugs(doc));
  const raw = Buffer.from(jsonText, 'utf8');
  const z = deflateRawFixed(raw);
  return {
    jsonText,
    descriptor: {
      format: 'openbill.inline/1',
      encoding: 'deflate-raw+base64',
      json_bytes: raw.length,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      data: Buffer.from(z).toString('base64'),
    },
  };
}

/**
 * Wrap body HTML in the shared shell (CSS, fonts, CSP from this page's own hashes).
 * @param {{ title: string, description: string, bodyHtml: string, css: string, scripts?: string[], tail?: string }} p
 */
function shell({ title, description, bodyHtml, css, script, tail = '' }) {
  const csp = cspFor(script ? [script] : [], [css]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="data:,">
<style>${css}</style>
</head>
<body>
${bodyHtml}
${tail}${script ? `<script>${script}</script>\n` : ''}</body>
</html>
`;
}

/**
 * Build every generated file. Reads inputs; writes nothing.
 * @returns {{ files: Record<string, string>, buildId: string, modules: string[], sizes: Record<string, number> }}
 */
export function buildAll() {
  const doc = JSON.parse(readText('data/drugs.json'));
  if (!doc || !Array.isArray(doc.rows) || !doc.sources || !doc.sources.nadac) throw new Error('data/drugs.json has no rows or no nadac source');
  const names = new Set(doc.rows.map((r) => r.name));
  for (const n of [DEFAULT_PRODUCT.drug, ...TRY_PRODUCTS]) {
    if (!names.has(n)) throw new Error(`build.js names the product ${JSON.stringify(n)}, which is not in data/drugs.json`);
  }
  for (const r of RULES) if (!/^[a-z0-9][a-z0-9-]*$/.test(r.id)) throw new Error(`rule id ${JSON.stringify(r.id)} cannot be an anchor`);

  const buildId = computeBuildId();
  const css = fontFaces() + readText('src/app/styles.css');
  if (/<\/style/i.test(css)) throw new Error('styles.css contains "</style"');
  const { code, modules } = bundle();
  const { descriptor } = encodeData(doc);

  const buildInfo = {
    build_id: buildId,
    schema: doc.schema,
    sources: sourceDates(doc),
    default: { drug: DEFAULT_PRODUCT.drug, qty: DEFAULT_PRODUCT.qty },
    try: [...TRY_PRODUCTS],
  };

  const tryLinks = TRY_PRODUCTS.map((n) => `<li><a href="${esc(hashFor(n))}">${esc(n)}</a></li>`).join('\n');
  const template = readText('src/app/index.html');
  const page = fill(
    template,
    {
      CSP: esc(cspFor([code], [css])),
      STYLE: css,
      MASTHEAD: stampHtml(doc, buildId),
      TRY_LINKS: tryLinks,
      HOWTO: howToReadHtml(),
      FOOTER: footerHtml(doc, buildId, { home: true }),
      BUILD_JSON: jsonForScript(buildInfo),
      DATA_JSON: jsonForScript(descriptor),
      SCRIPT: code,
    },
    'src/app/index.html',
  );

  const m = renderMethodology({
    doc,
    buildId,
    build: buildInfo,
    sources: doc.sources,
    repoUrl: REPO_URL,
    appName: APP_NAME,
  });
  if (!m || typeof m.bodyHtml !== 'string' || !m.title) throw new Error('renderMethodology must return { title, description, bodyHtml }');
  const methodology = shell({
    title: m.title,
    description: m.description || '',
    css,
    bodyHtml: `${stampHtml(doc, buildId)}\n<main id="main" class="doc">\n${m.bodyHtml}\n</main>\n${footerHtml(doc, buildId, { home: false })}`,
  });

  let quality = renderDataQuality(doc);
  if (typeof quality !== 'string') throw new Error('renderDataQuality must return a string');
  quality = quality.replace(/\r\n/g, '\n');
  if (!quality.endsWith('\n')) quality += '\n';

  const files = {
    'openbill.html': page,
    'methodology.html': methodology,
    'docs/DATA-QUALITY.md': quality,
  };
  for (const [rel, text] of Object.entries(files)) {
    if (/ style\s*=/i.test(text.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')) && rel.endsWith('.html')) {
      throw new Error(`${rel} has a style= attribute, which the CSP blocks`);
    }
  }
  const sizes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.byteLength(v, 'utf8')]));
  if (sizes['openbill.html'] >= SIZE_LIMIT) {
    throw new Error(`openbill.html is ${sizes['openbill.html']} bytes, over the ${SIZE_LIMIT}-byte budget`);
  }
  return { files, buildId, modules, sizes };
}

// ---------------------------------------------------------------------------------------------
// CLI

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function main(argv) {
  const check = argv.includes('--check');
  const { files, buildId, sizes } = buildAll();
  const stale = [];
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(ROOT, rel);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (current === text) continue;
    if (check) stale.push(rel);
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, 'utf8');
    }
  }
  for (const [rel, n] of Object.entries(sizes)) {
    const warn = rel === 'openbill.html' && n > SIZE_WARN ? `  WARNING: over ${mb(SIZE_WARN)}` : '';
    console.log(`${rel.padEnd(22)} ${String(n).padStart(9)} bytes  ${mb(n)}${warn}`);
  }
  console.log(`build ${buildId}`);
  if (check) {
    if (stale.length) {
      console.error(`Out of date (run node build.js): ${stale.join(', ')}`);
      return 1;
    }
    console.log('All generated files are up to date.');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
