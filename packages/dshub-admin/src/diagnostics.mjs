/**
 * Diagnostics screen — architecture §10, plan Phase 5.
 *
 * "Every question in the form 'why is this blotter behaving oddly' can be
 * answered from the window without attaching a debugger."
 *
 * Built as a MOUNTABLE screen, not a standalone window: the OpenFin host and
 * apps/dshub-console render the same component, so there is one implementation
 * rather than two that drift.
 *
 * Deliberately framework-free. dshub-admin declares React as a peer dependency,
 * but this needs no build step and no JSX toolchain to be useful today; a React
 * wrapper around `mount()` is additive when the host wants one.
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const fmt = {
  int: (n) => (n ?? 0).toLocaleString(),
  rate: (n) => (n === 0 ? '0' : (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })),
  ms: (n) => (n === null || n === undefined ? '–' : `${n.toFixed(0)}ms`),
  bytes: (b) => (b === null || b === undefined ? '–' : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`),
  ago: (ms) => (ms < 1000 ? 'just now' : ms < 60_000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`),
};

const CSS = `
.dshub-diag { font: 12px ui-monospace, Menlo, monospace; color: #e7eaed; background: #14181d; padding: 14px; }
.dshub-diag h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #8a939c; margin: 0 0 10px; font-weight: 600; }
.dshub-diag section { margin-bottom: 18px; }
.dshub-diag table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
.dshub-diag th { text-align: left; font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
                 color: #6b747e; font-weight: 600; padding: 6px 10px; border-bottom: 1px solid #2b3138; white-space: nowrap; }
.dshub-diag td { padding: 6px 10px; border-bottom: 1px solid #1e242b; white-space: nowrap; }
.dshub-diag td.num { text-align: right; }
.dshub-diag .badge { padding: 1px 7px; border-radius: 2px; font-size: 10px; letter-spacing: .07em; text-transform: uppercase; }
.dshub-diag .s-live { background:#16321f; color:#7fd18a }
.dshub-diag .s-stale, .dshub-diag .s-recovering { background:#332b16; color:#e5a244 }
.dshub-diag .s-failed { background:#331c19; color:#e8776a }
.dshub-diag .s-idle, .dshub-diag .s-connecting, .dshub-diag .s-snapshotting { background:#1b2733; color:#7eb2d1 }
.dshub-diag .rung-none { color:#6b747e } .dshub-diag .rung-conflating { color:#e5a244 }
.dshub-diag .rung-snapshot-refresh, .dshub-diag .rung-disconnecting { color:#e8776a }
.dshub-diag .err { color:#e8776a; font-size: 11px; }
.dshub-diag .meter { position: relative; height: 6px; background: #1e242b; border-radius: 3px; overflow: hidden; min-width: 120px; }
.dshub-diag .meter > i { position: absolute; inset: 0 auto 0 0; background: #7fd18a; }
.dshub-diag .meter.warn > i { background: #e5a244 } .dshub-diag .meter.crit > i { background: #e8776a }
.dshub-diag .spark { display: block; }
.dshub-diag .empty { color:#6b747e; padding: 10px; }
`;

/** Sparkline: values over time, so a stall is visible as a shape, not a number. */
function sparkline(values, { w = 110, h = 20, color = '#7eb2d1' } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('class', 'spark');
  if (!values.length) return svg;
  const max = Math.max(...values, 1);
  const step = w / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(' ');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '1.5');
  svg.appendChild(line);
  return svg;
}

/**
 * @param {HTMLElement} host
 * @param {object} [opts] { historyLength }
 * @returns {{ update(tick): void, destroy(): void }}
 */
export function mount(host, { historyLength = 40 } = {}) {
  if (!document.getElementById('dshub-diag-css')) {
    const style = el('style');
    style.id = 'dshub-diag-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = el('div', 'dshub-diag');
  host.appendChild(root);

  const processSection = el('section');
  const dsSection = el('section');
  root.append(processSection, dsSection);

  /** Per-datasource rate history, for the sparklines. */
  const history = new Map();

  function renderProcess(tick) {
    processSection.textContent = '';
    processSection.appendChild(el('h2', null, 'host'));

    const used = tick.engine?.used_size ?? tick.usedBytes ?? 0;
    const ceiling = tick.ceilingBytes ?? 0;
    const pct = ceiling ? Math.min(100, (used / ceiling) * 100) : 0;

    const t = el('table');
    const head = el('tr');
    for (const h of ['tables', 'subscribers', 'sessions', 'open views', 'engine memory', 'vs ceiling']) {
      head.appendChild(el('th', null, h));
    }
    t.appendChild(head);

    const row = el('tr');
    for (const v of [fmt.int(tick.tables), fmt.int(tick.subscribers), fmt.int(tick.sessions), fmt.int(tick.openViews)]) {
      row.appendChild(el('td', 'num', v));
    }
    row.appendChild(el('td', 'num', fmt.bytes(used)));

    // The answer to "why was I refused?" — §6.2's budget, visible.
    const meterCell = el('td');
    const meter = el('div', `meter${pct > 90 ? ' crit' : pct > 70 ? ' warn' : ''}`);
    const fill = el('i');
    fill.style.width = `${pct}%`;
    meter.appendChild(fill);
    meterCell.appendChild(meter);
    meterCell.appendChild(el('span', null, ` ${pct.toFixed(0)}% of ${fmt.bytes(ceiling)}`));
    row.appendChild(meterCell);
    t.appendChild(row);
    processSection.appendChild(t);
  }

  function renderDatasources(tick) {
    dsSection.textContent = '';
    dsSection.appendChild(el('h2', null, 'datasources'));

    const list = tick.datasources ?? [];
    if (!list.length) { dsSection.appendChild(el('div', 'empty', 'no active datasources')); return; }

    const t = el('table');
    const head = el('tr');
    for (const h of ['datasource', 'state', 'for', 'rows/s in', 'rows/s out', 'conflation',
                     'apply p50', 'p99', 'subs', 'views', 'queue', 'rung', 'in']) {
      head.appendChild(el('th', null, h));
    }
    t.appendChild(head);

    for (const d of list) {
      const hist = history.get(d.datasourceId) ?? [];
      hist.push(d.rowsInPerSec ?? 0);
      while (hist.length > historyLength) hist.shift();
      history.set(d.datasourceId, hist);

      const tr = el('tr');
      tr.appendChild(el('td', null, d.datasourceId));

      const st = el('td');
      st.appendChild(el('span', `badge s-${d.state}`, d.state));
      tr.appendChild(st);

      tr.appendChild(el('td', 'num', fmt.ago(d.stateForMs ?? 0)));
      tr.appendChild(el('td', 'num', fmt.rate(d.rowsInPerSec)));
      tr.appendChild(el('td', 'num', fmt.rate(d.rowsOutPerSec)));
      tr.appendChild(el('td', 'num', (d.conflationRatio ?? 1).toFixed(3)));
      tr.appendChild(el('td', 'num', fmt.ms(d.latency?.p50)));
      tr.appendChild(el('td', 'num', fmt.ms(d.latency?.p99)));
      tr.appendChild(el('td', 'num', fmt.int(d.subscribers)));
      tr.appendChild(el('td', 'num', fmt.int(d.openViews)));
      tr.appendChild(el('td', 'num', `${fmt.int(d.queueDepth)}/${fmt.int(d.queueLimit)}`));

      const rung = el('td');
      rung.appendChild(el('span', `rung-${d.backpressureRung ?? 'none'}`, d.backpressureRung ?? 'none'));
      tr.appendChild(rung);

      const spark = el('td');
      spark.appendChild(sparkline(hist));
      tr.appendChild(spark);
      t.appendChild(tr);

      // The error that explains a failure, kept visible after the state moves on.
      if (d.lastError) {
        const errRow = el('tr');
        const cell = el('td', 'err', `last error — ${d.lastError.message}`);
        cell.colSpan = 13;
        errRow.appendChild(cell);
        t.appendChild(errRow);
      }
    }
    dsSection.appendChild(t);
  }

  return {
    update(tick) {
      if (!tick) return;
      renderProcess(tick);
      renderDatasources(tick);
    },
    destroy() { root.remove(); history.clear(); },
  };
}

export { sparkline, fmt };
