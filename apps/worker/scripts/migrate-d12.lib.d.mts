// Tipos de migrate-d12.lib.mjs para el test del Worker.
export interface D12Data {
  project: string;
  goals: Array<{ id: string; title: string; bornAt?: string }>;
  requests: Array<{ id: string; title: string; bornAt?: string; quote: string; quoteBy?: string; from: string; why?: string }>;
  origins: Array<{ from: string; to: string; why?: string }>;
}
export interface D12Report {
  goals: number;
  requests: number;
  origins: number;
  skipped: number;
  missing: string[];
  orphans: string[];
}
export function migrateD12(
  call: (method: string, path: string, body?: unknown) => Promise<Response>,
  data: D12Data,
  opts?: { project?: string; dryRun?: boolean },
): Promise<D12Report>;
export function formatD12(r: D12Report, dryRun?: boolean): string;
