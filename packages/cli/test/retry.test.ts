import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, DagyardClient, RETRY_DELAYS_MS } from '../src/api.js';
import { EXIT, run } from '../src/cli.js';

type Step = number | 'network' | 'overloaded' | 'uncertain' | 'html503';
const UNAVAILABLE = { error: { code: 'unavailable', message: 'El servidor se está actualizando. Inténtalo de nuevo en unos segundos.' } };

/** Un fetch que responde en orden: un status (503 con el cuerpo de error, 2xx con `{ok}`) o un corte de red. */
function scripted(steps: Step[]) {
  const calls: Array<{ method: string; key: string | undefined }> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method ?? 'GET', key: headers['idempotency-key'] });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step === 'network') throw new TypeError('fetch failed');
    if (step === 'html503') return new Response('<html>503</html>', { status: 503, headers: { 'content-type': 'text/html' } });
    if (step === 'overloaded' || step === 'uncertain') {
      return new Response(JSON.stringify({ error: { code: step, message: step } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    const body = step >= 400 ? (step === 503 ? UNAVAILABLE : { error: { code: 'x', message: `status ${step}` } }) : { ok: true };
    return new Response(JSON.stringify(body), { status: step, headers: { 'content-type': 'application/json' } });
  });
  const slept: number[] = [];
  const client = new DagyardClient({
    baseUrl: 'https://d.dev',
    key: 'k',
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { client, calls, slept, fetch };
}

describe('reintentos del cliente (#54)', () => {
  it('un msg que recibe 503 se reintenta con la MISMA Idempotency-Key', async () => {
    const s = scripted([503, 503, 201]);
    await s.client.postMessage('p', 'n', { text: 'hola' });
    expect(s.calls).toHaveLength(3);
    expect(s.calls[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(s.calls.map((c) => c.key)).size).toBe(1);
    expect(s.slept).toHaveLength(RETRY_DELAYS_MS.length);
  });

  it('las esperas llevan jitter (×0,5 a ×1,5) y nunca suman más de 2 s', async () => {
    for (const r of [0, 0.999]) {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(r);
      try {
        const s = scripted([503, 503, 201]);
        await s.client.postMessage('p', 'n', { text: 'hola' });
        expect(s.slept).toEqual(RETRY_DELAYS_MS.map((ms) => Math.round(ms * (0.5 + r))));
        expect(s.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('un 503 que no viene del Worker (sin cuerpo de error, p. ej. del borde) también se reintenta', async () => {
    const s = scripted(['html503', 201]);
    await s.client.postMessage('p', 'n', { text: 'hola' });
    expect(s.calls).toHaveLength(2);
  });

  it.each(['overloaded', 'uncertain'] as const)('un 503 «%s» no se reintenta', async (code) => {
    const s = scripted([code, 201]);
    const err = await s.client.postMessage('p', 'n', { text: 'hola' }).catch((e: unknown) => e);
    expect((err as ApiRequestError).code).toBe(code);
    expect(s.calls).toHaveLength(1);
    expect(s.slept).toEqual([]);
  });

  it('un corte de red también se reintenta (la escritura pudo quedar: la clave la protege)', async () => {
    const s = scripted(['network', 201]);
    await s.client.postMessage('p', 'n', { text: 'hola' });
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]!.key).toBe(s.calls[1]!.key);
  });

  it('cada invocación lleva su propia clave', async () => {
    const s = scripted([201]);
    await s.client.postMessage('p', 'n', { text: 'uno' });
    await s.client.postMessage('p', 'n', { text: 'uno' });
    expect(s.calls[0]!.key).not.toBe(s.calls[1]!.key);
  });

  it('PUT y PATCH llevan clave y se reintentan; GET no lleva clave y se reintenta', async () => {
    for (const call of [
      (c: DagyardClient) => c.putProject('p', { name: 'P', nodes: [] }, { exclusive: true }),
      (c: DagyardClient) => c.updateNode('p', 'n', { status: 'done' }),
      (c: DagyardClient) => c.snapshot('p'),
    ]) {
      const s = scripted([503, 200]);
      await call(s.client);
      expect(s.calls).toHaveLength(2);
      if (s.calls[0]!.method === 'GET') expect(s.calls[0]!.key).toBeUndefined();
      else expect(s.calls[1]!.key).toBe(s.calls[0]!.key);
    }
  });

  it('agotados los intentos, el 503 llega al que llama como «unavailable»', async () => {
    const s = scripted([503]);
    const err = await s.client.postMessage('p', 'n', { text: 'hola' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(503);
    expect((err as ApiRequestError).code).toBe('unavailable');
    expect(s.calls).toHaveLength(RETRY_DELAYS_MS.length + 1);
  });

  it.each([500, 409, 404, 400, 502])('un %i no se reintenta', async (status) => {
    const s = scripted([status, 201]);
    await expect(s.client.postMessage('p', 'n', { text: 'hola' })).rejects.toBeInstanceOf(ApiRequestError);
    expect(s.calls).toHaveLength(1);
    expect(s.slept).toEqual([]);
  });

  it('`dagyard msg` sobrevive a un deploy: 503 y luego 201, exit 0', async () => {
    const s = scripted([503, 201]);
    let stderr = '';
    const code = await run(['msg', 'pagos', 'Ya quedó'], {
      cwd: mkdtempSync(join(tmpdir(), 'dagyard-cwd-')),
      stdout: () => {},
      stderr: (x) => (stderr += x),
      env: { LANG: 'es_PE.UTF-8', DAGYARD_URL: 'https://d.dev', DAGYARD_KEY: 'k', DAGYARD_PROJECT: 'demo', DAGYARD_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dagyard-cfg-')) },
      fetch: s.fetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    expect(stderr).toBe('');
    expect(code).toBe(EXIT.ok);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]!.key).toBe(s.calls[1]!.key);
  });
});

describe('wait sobrevive a un long-poll fallido (#94)', () => {
  const ERR = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: 'Algo falló de nuestro lado. Inténtalo de nuevo.' } }), { status, headers: { 'content-type': 'application/json' } });
  const RESOLVED = {
    blocker: { id: 'b1', projectId: 'demo', nodeId: 'pagos', kind: 'decision', question: '¿Sí?', options: ['Sí', 'No'], accessLabel: null, status: 'resolved', resolution: { choice: 'Sí' }, resolvedBy: 'owner', resolvedAt: '2026-10-04T21:05:00Z', createdAt: '2026-10-04T21:00:00Z' },
    value: null,
  };

  /** Corre `wait` contra un fetch que responde en orden; cada paso es una Response o un corte de red. */
  async function waitWith(steps: Array<Response | 'network'>, extra: string[] = []) {
    const urls: string[] = [];
    const slept: number[] = [];
    let stdout = '';
    let stderr = '';
    const fetch = vi.fn(async (url: string) => {
      urls.push(String(url));
      const step = steps[Math.min(urls.length - 1, steps.length - 1)]!;
      if (step === 'network') throw new TypeError('fetch failed');
      return step.clone();
    });
    const code = await run(['wait', 'pagos', '--blocker', 'b1', ...extra], {
      cwd: mkdtempSync(join(tmpdir(), 'dagyard-cwd-')),
      stdout: (x) => (stdout += x),
      stderr: (x) => (stderr += x),
      env: { LANG: 'es_PE.UTF-8', DAGYARD_URL: 'https://d.dev', DAGYARD_KEY: 'k', DAGYARD_PROJECT: 'demo', DAGYARD_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dagyard-cfg-')) },
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    return { code, stdout, stderr, urls, slept };
  }

  const ok = () => new Response(JSON.stringify(RESOLVED), { status: 200, headers: { 'content-type': 'application/json' } });

  it('un 500 «internal» suelto no corta la espera: devuelve la opción con exit 0', async () => {
    const r = await waitWith([ERR(500, 'internal'), ok()], ['--timeout', '1560']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toBe('Sí\n');
    expect(r.urls).toHaveLength(2);
    expect(r.urls.every((u) => u.includes('/api/projects/demo/blockers/b1/wait'))).toBe(true);
    expect(r.slept).toEqual([1000]);
  });

  it.each([
    ['overloaded', ERR(503, 'overloaded')],
    ['429', ERR(429, 'rate_limited')],
    ['corte de red', 'network' as const],
  ])('%s también se reintenta', async (_name, step) => {
    const r = await waitWith([step, step, ok()]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toBe('Sí\n');
  });

  it('el backoff crece hasta 10 s y vuelve a 1 s tras una vuelta buena', async () => {
    const noAnswer = () => new Response(null, { status: 204 });
    const e = () => ERR(500, 'internal');
    const r = await waitWith([e(), e(), e(), e(), e(), noAnswer(), e(), ok()]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.slept).toEqual([1000, 2000, 5000, 10_000, 10_000, 1000]);
  });

  it.each([
    [404, 'not_found'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [400, 'bad_request'],
  ])('un %i «%s» corta con exit 1, sin reintentar', async (status, code) => {
    const r = await waitWith([ERR(status, code), ok()]);
    expect(r.code).toBe(EXIT.api);
    expect(r.stderr).toContain(code);
    expect(r.urls).toHaveLength(1);
  });

  it('con el plazo vencido entre fallos sale con exit 2, nunca con exit 1', async () => {
    const now = vi.spyOn(Date, 'now');
    let clock = 0;
    now.mockImplementation(() => clock);
    try {
      const urls: string[] = [];
      const code = await run(['wait', 'pagos', '--blocker', 'b1', '--timeout', '3'], {
        cwd: mkdtempSync(join(tmpdir(), 'dagyard-cwd-')),
        stdout: () => {},
        stderr: () => {},
        env: { LANG: 'es_PE.UTF-8', DAGYARD_URL: 'https://d.dev', DAGYARD_KEY: 'k', DAGYARD_PROJECT: 'demo', DAGYARD_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dagyard-cfg-')) },
        fetch: (async (url: string) => {
          urls.push(url);
          return ERR(500, 'internal');
        }) as unknown as typeof globalThis.fetch,
        sleep: async (ms) => {
          clock += ms; // el reloj avanza lo que se duerme: el plazo se respeta
        },
      });
      expect(code).toBe(EXIT.timeout);
      expect(clock).toBe(3000); // la última espera se recorta al plazo: 1000 + 2000
      expect(urls).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });
});
