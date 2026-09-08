// Ambient types for the provider's ESM (.mjs) modules the app imports. Runtime
// code is the real @wellsfargo-starui/dshub-provider package; these give the app
// strict-enough types over the handful of methods it uses.

declare module '@wellsfargo-starui/dshub-provider/src/transport.mjs' {
  export class Transport {
    constructor(o: {
      connect: () => unknown; // a MessagePort / port-like object
      onControl: (m: any) => void;
      onBinary?: (b: ArrayBuffer) => void;
      onState?: (s: string, detail?: string) => void;
      reconnect?: Record<string, unknown>;
    });
    open(): void;
    send(m: any): boolean;
    close(): void;
  }
}

declare module '@wellsfargo-starui/dshub-provider/src/control.mjs' {
  export class ControlError extends Error { code: string; }
  export class ControlClient {
    constructor(o: { send: (m: any) => boolean | void; timeoutMs?: number });
    on(type: string, fn: (m: any) => void): () => void;
    handle(m: any): void;
    request<T = any>(m: any, opts?: any): Promise<{ id: string; type: string; payload: T }>;
    hello(o: { appId: string; protocolVersion?: number }): Promise<any>;
    subscribe(ref: any, opts?: { delivery?: string }): Promise<any>;
    watchGroups(ref: any, groupBy: string[], aggregates: Record<string, string>): Promise<any>;
    rowCount(ref: any, view: any): Promise<{ payload: number }>;
    distinctValues(ref: any, colId: string, contextFilter?: any, limit?: number): Promise<any>;
  }
}

declare module '@wellsfargo-starui/dshub-provider/src/hubDataService.mjs' {
  export class HubDataService {
    constructor(o: {
      control: any; ref: any; artifact: any; mode?: string;
      keyColumns?: string[]; softDeleteColumn?: string; searchColumns?: string[];
    });
    openView(spec: any): Promise<any>;
    readWindow(handle: any, w?: { startRow?: number; endRow?: number }): Promise<{ rows: any[]; rowCount: number }>;
    disposeView(handle: any): Promise<any>;
    distinctValues(colId: string, ctx?: any, limit?: number): Promise<any>;
    search(text: string, cols: string[]): any;
  }
}

declare module '@wellsfargo-starui/dshub-provider/src/modes/ssrm.mjs' {
  import type { GridApi } from 'ag-grid-community';
  /** getRows request → hub ViewSpec (filter/sort/groupBy/aggregates/splitBy). */
  export function toViewSpec(req: any, opts?: { softDeleteColumn?: string }): any;
  export class SsrmMode {
    constructor(o: { dataService: any; artifact: any; keyColumns?: string[]; softDeleteColumn?: string; maxViews?: number });
    readonly mode: string;
    getRowId: (p: any) => string;
    datasource(): any;
    attach(control: any, gridApi: GridApi, opts?: { refreshMs?: number; ref?: any }): () => void;
    watchGroups(groupBy: string[], aggregates: Record<string, string>): void;
    setSearch(model: any, gridApi?: GridApi): void;
    destroy(): Promise<void> | void;
  }
}

declare module '@wellsfargo-starui/dshub-provider/src/coldefs.mjs' {
  import type { ColDef } from 'ag-grid-community';
  export function buildColDefs(artifact: any, dataService?: any): ColDef[];
}
