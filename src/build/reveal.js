// The reveal clip (press/openbill-reveal.gif and its 9:16 variant): a 6-second loop of the card
// for the README and social posts. tools/record.mjs renders each frame with Playwright from the
// markup here and encodes the GIF (tools/gif.mjs).
//
// DOM-free and pure, like renderOgHtml(): the timeline is a list of states, and each state is
// rendered as a whole page with no script, so the same data always gives the same frames. Every
// figure comes from drugFacts() (src/build/drugpage.js), the numbers the showcase's drug page and
// preview card show. The spread counts up from 1.0× (the two prices equal) before it settles; the
// in-between frames are animation, 80 ms each, and the value it settles and holds on is core's,
// shown with its state chip and sentence (decision 51).

import { html, joinHtml, chip, honestyText, provTexts, drugFacts, quantityKicker } from './drugpage.js';
import { formatSpreadMultiple } from '../core/rules.js';
import { APP_NAME, SITE_URL } from '../core/config.js';

/** Each frame lasts 8 hundredths of a second: 12.5 frames a second. */
export const REVEAL_FRAME_CS = 8;

/** The whole loop: 6 seconds. */
export const REVEAL_DURATION_CS = 600;

/** The two clips: 16:9 for the README and most feeds, 9:16 for stories. Sizes in CSS pixels, rendered at scale 1. */
export const REVEAL_LAYOUTS = Object.freeze({
  wide: Object.freeze({ width: 1200, height: 675, file: 'openbill-reveal.gif', still: 'openbill-reveal.png' }),
  tall: Object.freeze({ width: 540, height: 960, file: 'openbill-reveal-9x16.gif', still: null }),
});

/** What the search box types: the product name's first word, lower-cased ("aripiprazole"). */
export function revealQuery(name) {
  return String(name).trim().split(/\s+/)[0].toLowerCase();
}

/**
 * The figures the clip shows, from drugFacts(). The clip needs a pack total, a Medicare figure and
 * a spread that is not extreme; a product without them stops the build (choose another showcase,
 * decision 45) rather than animating a gap.
 * @param {object} model buildModel()
 * @param {{ name: string, rows: object[] }} product
 */
export function revealFacts(model, product) {
  const f = drugFacts(model, product);
  const why = [];
  if (f.pharmacy.kind !== 'pack') why.push('it has no single pack total');
  if (f.medicare.missing) why.push('it has no Medicare figure');
  if (f.spread.missing) why.push('it has no spread');
  else if (f.spread.extreme) why.push('its spread is extreme, so the two figures may not measure the same thing');
  if (why.length) throw new Error(`the reveal clip cannot show ${product.name}: ${why.join('; ')}. Choose another showcase (decision 45).`);
  const max = f.s.spread.range.max.value;
  if (!Number.isFinite(max)) throw new Error(`the reveal clip cannot show ${product.name}: its spread has no value`);
  return f;
}

/**
 * The frames of the clip, in order: [{ state, delay }], delay in hundredths of a second. The beats:
 * an empty search box; the query typed a letter a frame; the card resolves; what pharmacies pay
 * appears; the rule draws; what Medicare paid lands; the spread counts up from 1.0× to core's
 * value, then its chip and sentence show; the source lines fade in; it holds; the GIF loops.
 * @param {object} f revealFacts()
 * @returns {{ state: object, delay: number }[]}
 */
export function revealTimeline(f) {
  const query = revealQuery(f.name);
  const out = [];
  const st = { typed: '', head: 0, pharmacy: 0, rule: 0, medicare: 0, spread: null, settled: false, sources: 0 };
  const push = () => out.push({ state: { ...st }, delay: REVEAL_FRAME_CS });
  const ramp = (n, set) => {
    for (let i = 1; i <= n; i++) {
      set(i / n);
      push();
    }
  };
  for (let i = 0; i < 4; i++) push();
  for (let i = 1; i <= query.length; i++) {
    st.typed = query.slice(0, i);
    push();
  }
  ramp(4, (p) => (st.head = p));
  ramp(4, (p) => (st.pharmacy = p));
  ramp(5, (p) => (st.rule = p));
  ramp(4, (p) => (st.medicare = p));
  const end = f.s.spread.range.max.value;
  const steps = 12;
  for (let j = 0; j < steps; j++) {
    const last = j === steps - 1;
    const p = j / (steps - 1);
    const eased = 1 - (1 - p) ** 3;
    st.spread = last ? f.spread.text : formatSpreadMultiple(1 + (end - 1) * eased);
    st.settled = last;
    push();
  }
  ramp(5, (p) => (st.sources = p));
  const used = out.length * REVEAL_FRAME_CS;
  const hold = REVEAL_DURATION_CS - used;
  if (hold < 100) throw new Error(`the reveal clip's beats take ${used / 100} s, leaving under 1 s to hold (the query ${JSON.stringify(query)} is too long)`);
  out.push({ state: { ...st }, delay: hold });
  return out;
}

const num = (x) => String(Math.round(x * 1000) / 1000);

/** opacity, and a slide from `dy` pixels to 0, for a beat that is p of the way in. */
function motion(p, dy) {
  if (p >= 1) return null;
  return `opacity:${num(p)};transform:translateY(${num((1 - p) * dy)}px)`;
}

/**
 * One frame of the clip as a whole HTML page, for tools/record.mjs to screenshot. `css` is
 * src/site/reveal.css with the IBM Plex @font-face rules as data: URIs, so nothing is fetched.
 * @param {object} model
 * @param {object} f revealFacts()
 * @param {{ css: string, layout: 'wide'|'tall', state: object }} opts
 * @returns {string}
 */
export function renderRevealHtml(model, f, { css, layout, state }) {
  if (typeof css !== 'string' || /<\/style/i.test(css)) throw new Error('renderRevealHtml needs the clip CSS as a string');
  if (!REVEAL_LAYOUTS[layout]) throw new Error(`no reveal layout ${JSON.stringify(layout)}`);
  const m = f.medicare;
  const st = state;
  const attr = (style) => (style ? html` style="${style}"` : '');
  const ruleStyle = st.rule >= 1 ? null : `transform:${layout === 'wide' ? 'scaleY' : 'scaleX'}(${num(st.rule)})`;
  const hidden = (show) => (show ? '' : html` style="visibility:hidden"`);
  const sources = [...provTexts(f.pharmacy.records), ...provTexts(m.records, m.inputs)];
  const body = html`<div class="scene">
<div class="top"><span class="stamp"><span class="stamp-name">${APP_NAME}</span><span class="stamp-sub">drug price receipt</span></span><span class="week">NADAC week of ${model.doc.sources.nadac.as_of_date}</span></div>
<div class="search"><p class="search-label">Drug name or the NDC on your label</p><div class="search-box"><span class="typed" data-reveal="typed">${st.typed}</span></div></div>
<div class="card">
<div class="head"${attr(st.head > 0 ? motion(st.head, 6) : 'opacity:0')}><p class="kicker">${quantityKicker(f)}</p><h1 class="name">${f.name}</h1></div>
<div class="figs">
<section class="fig fig-pharmacy"${attr(st.pharmacy > 0 ? motion(st.pharmacy, 10) : 'opacity:0')}><h2 class="label">Pharmacies pay</h2><p class="value-line"><span class="value" data-reveal="pharmacy">${f.pharmacy.text}</span> ${chip(f.pharmacy.state)}</p><p class="arith">${f.pharmacy.arith}</p></section>
<div class="rule"${attr(ruleStyle)}></div>
<section class="fig fig-medicare"${attr(st.medicare > 0 ? motion(st.medicare, -16) : 'opacity:0')}><h2 class="label">${m.label}</h2><p class="value-line"><span class="value" data-reveal="medicare">${m.text}</span> ${chip(m.state)}</p><p class="arith">${m.arith}</p><p class="note">${m.year ? `Data year ${m.year}` : `Period ${m.period}`}, every strength and form together</p><p class="not-yours">${honestyText('not-your-price', { firstSentenceOnly: true })}</p></section>
<section class="fig fig-spread"${attr(st.spread === null ? 'opacity:0' : null)}><h2 class="label">The spread</h2><p class="value-line"><span class="value multiple" data-reveal="spread">${st.spread === null ? f.spread.text : st.spread}</span> <span${hidden(st.settled)}>${chip(f.spread.state)}</span></p><p class="sentence"${hidden(st.settled)}>${f.spread.sentence}</p>${f.spread.caveats.first ? html`<p class="caveat"${hidden(st.settled)}>${f.spread.caveats.first}</p>` : ''}</section>
</div>
<div class="sources"${attr(st.sources >= 1 ? null : `opacity:${num(st.sources)}`)}>${joinHtml(
    sources.map((t) => html`<p class="prov">${t}</p>`),
    '',
  )}</div>
</div>
<p class="foot"><span>${honestyText('range')}</span><span>${SITE_URL.replace(/^https:\/\//, '').replace(/\/$/, '')}</span></p>
</div>`;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>${css}</style>\n</head>\n<body class="${layout}">\n${body.s}\n</body>\n</html>\n`;
}
