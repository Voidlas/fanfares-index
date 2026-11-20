/**
 * Hand-rolled SVG charts. One measure, one neutral hue (set in CSS),
 * recessive axes, 4px rounded bar tops, per-bar hover
 * tooltips, and a visually hidden table for screen readers.
 */
import { esc, num } from './ui.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };

/** Rounds an axis maximum up to a clean 1/2/5 × 10^n step. */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

/**
 * Monthly column chart.
 * @param {HTMLElement} host Element to render into.
 * @param {{month: string, value: number}[]} rows Chronological series.
 * @param {object} opts
 * @param {(n: number) => string} opts.format Tooltip value formatter.
 * @param {string} opts.label Accessible name of the measure.
 */
export function monthlyBars(host, rows, { format = num, label = 'Value' } = {}) {
  if (!rows.length) { host.innerHTML = '<div class="empty">No dated data yet.</div>'; return; }
  // Draw at the host's real pixel width so axis text stays 11px on phones
  // instead of being scaled down with the viewBox.
  const W = Math.max(280, Math.round(host.clientWidth) || 720);
  const H = W < 520 ? 190 : 240; const L = 40; const B = 26; const T = 8;
  const max = niceMax(Math.max(...rows.map((r) => r.value)));
  const step = (W - L) / rows.length;
  const bw = Math.max(3, Math.min(28, step - 2));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const labelEvery = Math.ceil(rows.length / (W < 520 ? 4 : 8));
  const bars = rows.map((r, i) => {
    const x = L + i * step + (step - bw) / 2;
    const top = y(r.value);
    const h = Math.max(0, H - B - top);
    const rad = Math.min(4, h / 2, bw / 2);
    const path = h > 0
      ? `M${x},${H - B}V${top + rad}Q${x},${top} ${x + rad},${top}H${x + bw - rad}Q${x + bw},${top} ${x + bw},${top + rad}V${H - B}Z`
      : '';
    return `<path class="bar" d="${path}" data-i="${i}"/>
      <rect class="hit" x="${L + i * step}" y="${T}" width="${step}" height="${H - T - B}" data-i="${i}"/>`;
  }).join('');
  const xLabels = rows.map((r, i) => (i % labelEvery === 0
    ? `<text x="${L + i * step + step / 2}" y="${H - 8}" text-anchor="middle">${esc(monthLabel(r.month).replace(' 20', " '"))}</text>` : '')).join('');
  host.innerHTML = `<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} per month">
      <g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>
      <g class="axis">${ticks.map((t) => `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${esc(shortNum(t))}</text>`).join('')}${xLabels}</g>
      ${bars}
    </svg>
    <table class="sr-only"><caption>${esc(label)} per month</caption>${rows.map((r) => `<tr><th>${esc(monthLabel(r.month))}</th><td>${esc(format(r.value))}</td></tr>`).join('')}</table>
  </div>`;
  const chart = host.querySelector('.chart');
  const svg = chart.querySelector('svg');
  let tip;
  svg.addEventListener('pointermove', (e) => {
    const i = e.target.dataset?.i;
    if (i === undefined) return;
    const r = rows[i];
    svg.querySelectorAll('.bar').forEach((b) => b.classList.toggle('dim', b.dataset.i !== i));
    tip ||= chart.appendChild(Object.assign(document.createElement('div'), { className: 'tooltip' }));
    tip.innerHTML = `<b>${esc(format(r.value))}</b>${esc(monthLabel(r.month))}${r.extra ? ` · ${esc(r.extra)}` : ''}`;
    const box = svg.getBoundingClientRect();
    const scale = box.width / W;
    tip.style.left = `${(L + Number(i) * step + step / 2) * scale}px`;
    tip.style.top = `${y(r.value) * scale}px`;
  });
  svg.addEventListener('pointerleave', () => {
    svg.querySelectorAll('.bar').forEach((b) => b.classList.remove('dim'));
    tip?.remove(); tip = null;
  });
}

/** Axis tick labels: 250000 → "250K". */
function shortNum(n) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/**
 * Horizontal bars for a small categorical breakdown (one hue: it encodes
 * magnitude, the label carries identity).
 * @param {{label: string, count: number}[]} rows
 * @param {{format?: (n: number) => string}} [opts] Formats the value shown at the end of each bar.
 */
export function hbars(rows, { format = num } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return rows.map((r) => `<div class="hbar"><span>${esc(r.label)}</span>
    <div class="track"><div class="fill" style="width:${(r.count / max) * 100}%"></div></div>
    <span class="n">${esc(format(r.count))}</span></div>`).join('');
}
