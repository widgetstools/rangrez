/**
 * REST adapter — `rest-then-subscribe`.
 *
 * The snapshot is an HTTP fetch, possibly paginated; updates then arrive over a
 * *different* transport. That split is the whole point of the mode and the
 * reason it cannot just be "WebSocket with a different opener".
 *
 * ── The ordering problem ──────────────────────────────────────────────────────
 *
 * Everywhere else the rule is SUBSCRIBE BEFORE TRIGGER, because subscribing
 * after the snapshot request loses whatever changed in between (architecture
 * §5.5). Here the snapshot is a separate protocol entirely, so the rule is even
 * easier to get wrong and even more costly: an HTTP page-through of 500k rows
 * can take tens of seconds, and every update in that window is lost silently —
 * the grid looks complete and is simply stale in places.
 *
 * So the update transport is opened and subscribed FIRST, its rows buffered
 * while the pages are fetched, and replayed once the snapshot lands. Applying a
 * buffered update twice is harmless (the merge is idempotent); dropping one is
 * not recoverable.
 *
 * With no `updates` block configured this degrades to a one-shot fetch, which is
 * a legitimate way to serve a static reference table.
 */

import { BaseAdapter, substitute, bodyToRows } from './base.mjs';
import { STATE } from '../table_actor.mjs';

export class RestAdapter extends BaseAdapter {
  /**
   * @param {object} o
   * @param {(url:string, init:object)=>Promise<Response>} [o.fetchImpl]
   * @param {(conn:object, ds:object, opts:object)=>object} [o.makeUpdateAdapter]
   *        Builds the adapter that carries updates. Injected rather than
   *        imported so this file does not depend on every transport, and so a
   *        test can drive it without a socket.
   */
  constructor(opts) {
    super(opts);
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.makeUpdateAdapter = opts.makeUpdateAdapter;
    this.pending = [];
    this.buffering = true;
    this.pagesFetched = 0;
    this.aborted = false;
  }

  openTransport(url) {
    this.aborted = false;
    this.pending = [];
    this.buffering = true;

    // 1. Updates first, so nothing that happens during the fetch is lost.
    this.startUpdates();

    // 2. Then page through the snapshot.
    this.beginSnapshot(substitute(this.datasource?.snapshot?.url ?? url, this.params));
    this.fetchSnapshot().catch((e) => {
      if (this.aborted) return;
      // Keep the origin frame. "Cannot convert undefined or null to object" is
      // the same message wherever it comes from, and the whole snapshot path
      // runs behind one catch — without a frame there is nothing to go on.
      this.lastError = { message: String(e?.message ?? e), stack: String(e?.stack ?? '').split('\n').slice(0, 4).join(' | ') };
      this.fail(`snapshot fetch failed: ${e.message} @ ${this.lastError.stack}`);
    });
  }

  startUpdates() {
    const { updates } = this.datasource;
    if (!updates?.destination || !this.makeUpdateAdapter) return;

    this.updateAdapter = this.makeUpdateAdapter(this.connection, this.datasource, {
      params: this.params,
      onRows: (rows) => {
        if (this.buffering) this.pending.push(...rows);
        else this.deliver(rows);
      },
      // The update transport's own lifecycle must not drive ours: it reports
      // `live` as soon as it is subscribed, which is long before the snapshot
      // has been fetched. Only its failures matter here.
      onState: (s, detail) => { if (s === STATE.FAILED) this.fail(`update transport: ${detail}`); },
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    });
    this.updateAdapter.connect();
  }

  /**
   * Page through the snapshot.
   *
   * `offset` and `cursor` are the two styles worth supporting; `none` is a
   * single request. A page that returns nothing ends the walk regardless of
   * style, which is what stops a misconfigured cursor looping forever.
   */
  async fetchSnapshot() {
    const { snapshot } = this.datasource;
    const pg = snapshot.pagination ?? { style: 'none' };
    const size = pg.pageSize ?? 1000;

    let offset = 0;
    let cursor = null;
    let declared;

    for (;;) {
      if (this.aborted) return;

      const url = pageUrl(substitute(snapshot.url, this.params), pg, { offset, size, cursor });
      const res = await this.fetchImpl(url, {
        method: snapshot.method ?? 'GET',
        headers: substituteAll(snapshot.headers ?? {}, this.params),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText ?? ''} from ${url}`.trim());

      // The declared count usually rides on the FIRST response only.
      if (declared === undefined && snapshot.expectedCountHeader) {
        const raw = res.headers?.get?.(snapshot.expectedCountHeader);
        const n = Number(raw);
        if (Number.isFinite(n)) declared = n;
      }

      const body = await res.json();
      const rows = extractRows(body, pg);
      this.pagesFetched += 1;
      this.deliver(rows);

      if (pg.style === 'none' || rows.length === 0) break;
      if (pg.style === 'cursor') {
        cursor = pg.cursorPath ? readPath(body, pg.cursorPath) : null;
        if (!cursor) break;
      } else {
        // A short page is the last page.
        if (rows.length < size) break;
        offset += rows.length;
      }
    }

    if (this.aborted) return;
    if (!this.finishSnapshot(declared)) return;

    // 3. Replay what arrived while we were fetching, then go direct.
    this.buffering = false;
    const buffered = this.pending;
    this.pending = [];
    if (buffered.length) this.deliver(buffered);
    this.bufferedDuringSnapshot = buffered.length;
  }

  closeTransport() {
    this.aborted = true;
    try { this.updateAdapter?.close(); } catch { /* already gone */ }
    this.updateAdapter = null;
  }
}

/** Build the URL for one page. */
export function pageUrl(base, pg, { offset, size, cursor }) {
  if (!pg || pg.style === 'none') return base;
  const sep = base.includes('?') ? '&' : '?';
  if (pg.style === 'cursor') return cursor ? `${base}${sep}cursor=${encodeURIComponent(cursor)}` : base;
  return `${base}${sep}offset=${offset}&limit=${size}`;
}

/**
 * Rows out of a page body.
 *
 * A bare array is the common case; an envelope carries them under a key. Both
 * appear in the wild, and guessing wrong yields one row containing the envelope.
 */
export function extractRows(body, pg) {
  if (Array.isArray(body)) return body;
  if (pg?.rowsPath) return readPath(body, pg.rowsPath) ?? [];
  for (const k of ['rows', 'data', 'items', 'results', 'records']) {
    if (Array.isArray(body?.[k])) return body[k];
  }
  return bodyToRows(body, 'record');
}

const readPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const substituteAll = (obj, params) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, substitute(v, params)]));
