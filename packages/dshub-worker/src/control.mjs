/**
 * Control-channel message handling.
 *
 * Architecture §7.2. Plain objects over a MessagePort in worker mode; the
 * sidecar will carry the same messages as WebSocket text frames.
 *
 * Every inbound message is validated against the generated schema before it is
 * acted on. With no server in front of the hub, this validation is the only
 * thing standing between a malformed request and undefined behaviour.
 */

/**
 * No static import of the validator. `schema` was already injected; importing
 * `validate` by package name coupled this module to Node's resolver, and a
 * browser worker cannot resolve bare specifiers (import maps do not apply to
 * workers). Both now arrive through deps, which is also the more consistent
 * shape.
 */

export const PROTOCOL_VERSION = 1;

/** Typed error the provider can act on, rather than a string it can only print. */
export class ControlError extends Error {
  constructor(code, message, { ref, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.ref = ref;
    this.retryable = retryable;
  }
  toMessage(id) {
    return { id, type: 'error', code: this.code, message: this.message, retryable: this.retryable, ...(this.ref ? { ref: this.ref } : {}) };
  }
}

/**
 * Three-way config reconcile (architecture §3.6).
 *
 * Compares the PAIR (bundleVersion, checksum) — never the version alone.
 * `bundleVersion` is a client-side counter, so two apps editing while the hub
 * is unreachable both bump 12 -> 13 with different content. Comparing versions
 * only, they meet at "equal -> nothing" and stay divergent forever with no
 * signal to either user.
 *
 * A conflict is SURFACED, not resolved. Neither side wins automatically: the
 * app opens the import diff view and a human picks. Divergence is survivable;
 * silently overwriting someone's desk config is not.
 */
export function reconcileConfig(app, hub) {
  const appV = app?.bundleVersion ?? 0;
  const hubV = hub?.bundleVersion ?? 0;

  if (appV === hubV) {
    const appSum = app?.bundleChecksum;
    const hubSum = hub?.bundleChecksum;
    // Only a conflict when BOTH sides actually have a bundle to compare. A
    // first-run app with no config is not in conflict with anything.
    if (appSum && hubSum && appSum !== hubSum) {
      return { status: 'conflict', reason: 'same bundleVersion, different content' };
    }
    return { status: 'current' };
  }
  return appV > hubV ? { status: 'app-newer' } : { status: 'hub-newer' };
}

/**
 * Dispatch one control message.
 *
 * @param {object} msg     raw inbound message
 * @param {object} deps    { schema, hub, session }
 * @returns {Promise<object|null>} response message, or null for fire-and-forget
 */
export async function handleControl(msg, deps) {
  const { schema, validate, hub, session } = deps;
  const id = msg?.id ?? 'unknown';

  const errors = validate(msg, schema);
  if (errors.length) {
    return new ControlError('invalid-params', `malformed ${msg?.type ?? 'message'}: ${errors[0].path} ${errors[0].message}`).toMessage(id);
  }

  try {
    switch (msg.type) {
      case 'hello': {
        // Refuse rather than degrade. With config client-side and a hub
        // installed per machine, version skew across a desk is the steady
        // state, and a silently-degraded session is harder to diagnose than a
        // refused one.
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          throw new ControlError(
            'protocol-version-mismatch',
            `provider speaks protocol ${msg.protocolVersion}; this hub speaks ${PROTOCOL_VERSION}`
          );
        }
        session.appId = msg.appId;
        session.protocolVersion = msg.protocolVersion;

        const r = reconcileConfig(msg, hub.configMeta());
        const out = {
          id, type: 'configAck', status: r.status,
          bundleVersion: hub.configMeta().bundleVersion ?? 0,
          bundleChecksum: hub.configMeta().bundleChecksum,
        };
        if (r.status === 'hub-newer' || r.status === 'conflict') out.bundle = hub.configBundle();
        return out;
      }

      case 'subscribe': {
        const { tableName, schemaRef, mode, estimatedRows } = await hub.subscribe(msg.ref, session, { delivery: msg.delivery });
        return { id, type: 'subscribed', tableName, schemaRef, mode, estimatedRows };
      }

      case 'ack':
        // Fire-and-forget: acking is a flow signal, not a request, and making
        // the client await a reply would add exactly the round trip the
        // backpressure ladder exists to avoid.
        hub.flowFor(session).onAck(msg.seq);
        return null;

      case 'command': {
        const r = await hub.command(msg);
        return { id, type: 'commandResult', idempotencyKey: r.idempotencyKey, outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}) };
      }

      case 'alertSubscribe': {
        const r = await hub.subscribeAlert(msg.ref, { ruleId: msg.ruleId, predicate: msg.predicate }, session);
        return { id, type: 'result', payload: r };
      }

      case 'alertUnsubscribe': {
        await hub.unsubscribeAlert(msg.ruleId, session);
        return { id, type: 'result', payload: { ruleId: msg.ruleId, watching: false } };
      }

      case 'watchGroups': {
        const r = await hub.watchGroups(msg.ref, { groupBy: msg.groupBy, aggregates: msg.aggregates }, session);
        return { id, type: 'result', payload: r };
      }

      case 'pushConfig': {
        // Apply a new config to the RUNNING hub and report the reload plan the
        // hub actually computed — the client shows what took effect, and cannot
        // be told a weaker class than the edit really was.
        const result = await hub.applyConfig(msg.bundle);
        return { id, type: 'configApplied', bundleVersion: hub.configMeta().bundleVersion ?? 0, ...result };
      }

      case 'unsubscribe':
        await hub.unsubscribe(msg.ref, session);
        return null;

      case 'distinctValues':
        return { id, type: 'result', payload: await hub.distinctValues(msg.ref, msg.colId, msg.contextFilter, msg.limit) };

      case 'searchValues':
        return { id, type: 'result', payload: await hub.searchValues(msg.ref, msg.colId, msg.prefix, msg.limit) };

      case 'rowCount':
        return { id, type: 'result', payload: await hub.rowCount(msg.ref, msg.view) };

      case 'aggregates':
        return { id, type: 'result', payload: await hub.aggregates(msg.ref, msg.specs, msg.view) };

      case 'scan': {
        // Streamed: each batch is its own `result` with partial:true, and a
        // final non-partial message closes the sequence.
        let batches = 0;
        const rows = await hub.scan(msg.ref, msg.view, (block, start, total) => {
          batches++;
          session.send?.({ id, type: 'result', partial: true, payload: { block, start, total } });
        }, { batchRows: msg.batchRows ?? 2000 });
        return { id, type: 'result', payload: { rows, batches } };
      }

      case 'rank':
        return { id, type: 'result', payload: await hub.rank(msg.ref, msg.key, msg.view) };

      case 'openView':
        return { id, type: 'result', payload: await hub.openView(msg.ref, msg.view, session) };

      case 'readWindow':
        return { id, type: 'result', payload: await hub.readWindow(msg.viewId, { startRow: msg.startRow, endRow: msg.endRow }) };

      case 'expandRow':
        return { id, type: 'result', payload: await hub.expandRow(msg.viewId, msg.index, msg.collapse === true) };

      case 'disposeView':
        return { id, type: 'result', payload: { disposed: await hub.disposeView(msg.viewId) } };

      case 'stats':
        return { id, type: 'result', payload: await hub.stats() };

      default:
        throw new ControlError('internal', `unhandled message type "${msg.type}"`);
    }
  } catch (e) {
    if (e instanceof ControlError) return e.toMessage(id);
    // Registry errors already carry a typed code (row-limit-exceeded,
    // memory-ceiling-exceeded); preserve it rather than flattening to internal.
    if (e.code) return new ControlError(e.code, e.message, { ref: msg.ref }).toMessage(id);
    return new ControlError('internal', e.message, { ref: msg.ref }).toMessage(id);
  }
}
