import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadVendoredRustHub, resetRustHubLoader, RustHubHost, type RustHubLike } from './RustHubHost.js';

function fakeHub(): RustHubLike {
  return {
    boot_datasource: () => 'ok',
    connect: () => undefined,
    disconnect: () => '[]',
    on_control: () => '[]',
    tick: () => '[]',
    apply_message_json: () => '[]',
    poll_shared_delta: () => '',
    mem_stats: () => '{}',
  };
}

afterEach(() => {
  resetRustHubLoader();
});

describe('RustHubHost', () => {
  it('creates the hub once and exposes current', async () => {
    const created: RustHubLike[] = [];
    const host = new RustHubHost(() => {
      const hub = fakeHub();
      created.push(hub);
      return hub;
    });
    expect(host.current).toBeNull();
    const a = await host.ensure();
    const b = await host.ensure();
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
    expect(host.current).toBe(a);
  });
});

describe('loadVendoredRustHub', () => {
  it('inits the wasm module once and returns RustHub.new()', async () => {
    const hub = fakeHub();
    const init = vi.fn(async () => undefined);
    resetRustHubLoader(async () => ({
      default: init,
      RustHub: { new: () => hub },
    } as never));

    const first = await loadVendoredRustHub();
    const second = await loadVendoredRustHub();
    expect(first).toBe(hub);
    expect(second).toBe(hub);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0][0]).toMatchObject({
      module_or_path: expect.any(URL),
    });
  });
});
