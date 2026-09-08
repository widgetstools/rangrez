import * as psp from '@perspective-dev/client/dist/esm/perspective.node.js';

console.log('memory64:', psp.host_supports_memory64());

// In-process: server + session + client over a direct byte pipe.
const server = new psp.PerspectiveServer();
const session = await server.new_session(async (resp) => client.handle_response(resp));
const client = psp.make_client(async (req) => { await session.handle_request(req); });

const t = await client.table([{ id: 'P1', px: 99.5, book: 'CMBS' }, { id: 'P2', px: 100.25, book: 'RMBS' }], { index: 'id' });
console.log('size:', await t.size(), 'schema:', await t.schema());
const g = await t.view({ group_by: ['book'], aggregates: { px: 'sum' } });
console.log('grouped:', JSON.stringify(await g.to_columns()));
await g.delete(); await t.delete();
console.log('OK');
