import type { DatasourceConfig } from './hub/types';

// The `positions` datasource the app asks the hub to cache and publish.
// The hub connects upstream to a STOMP view server on :8081, triggers a 20k-row
// snapshot, and streams live updates — the app only describes it here.
export const POSITIONS: DatasourceConfig = {
  id: 'positions',
  schemaRef: 'positions@v1',
  keyColumns: ['positionId'],
  columns: [
    { name: 'positionId', type: 'string' },
    { name: 'desk', type: 'string' },
    { name: 'trader', type: 'string' },
    { name: 'bookName', type: 'string' },
    { name: 'instrumentType', type: 'string' },
    { name: 'currency', type: 'string' },
    { name: 'marketValue', type: 'integer' },
    { name: 'notionalAmount', type: 'integer' },
    { name: 'dv01', type: 'float' },
    { name: 'currentPrice', type: 'float' },
    { name: 'quantity', type: 'integer' },
    { name: 'pnl', type: 'integer' },
  ],
  connection: {
    transport: 'stomp',
    url: 'ws://127.0.0.1:8081',
    vhost: 'localhost',
    heartbeat: { outMs: 1000, inMs: 10000 },
  },
  snapshot: {
    mode: 'trigger-reply',
    triggerDestination: '/snapshot/positions/{clientId}/{rate}/{batchSize}',
    replyDestination: '/snapshot/positions/{clientId}',
  },
  updates: {
    destination: '/snapshot/positions/{clientId}',
    bodyShape: 'record-array',
  },
};

/** Presentation: group by desk → trader, sum the money columns. */
export const GRID_HINTS = {
  group: ['desk', 'trader'],
  agg: { marketValue: 'sum', notionalAmount: 'sum', dv01: 'sum' },
} as const;

export const HUB_URL = 'ws://127.0.0.1:8787';
