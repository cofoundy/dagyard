// Migra el proyecto «dagyard» al modelo D12 (#90): el objetivo vivo, los pedidos de André (Mensajes 7 a 11) con su
// cita y una arista «nació de» para cada tarea. Los datos viven en migrate-d12.data.json. Idempotente: salta los nodos
// y orígenes que ya existen, así la segunda corrida no escribe nada. Nunca borra.
// Uso: node scripts/migrate-d12.mjs <url> [--dry-run]
// La clave de agente sale de DAGYARD_KEY o ~/.config/dagyard/agent-key, nunca de argv, y nunca se imprime.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatD12, migrateD12 } from './migrate-d12.lib.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rest = args.filter((a) => a !== '--dry-run');
const base = (rest[0] ?? '').replace(/\/+$/, '');
if (rest.length !== 1 || !/^https?:\/\//.test(base)) {
  console.error('Uso: node scripts/migrate-d12.mjs <url> [--dry-run]   p. ej. https://dagyard.<cuenta>.workers.dev');
  process.exit(2);
}

const keyPath = join(homedir(), '.config', 'dagyard', 'agent-key');
let key = process.env.DAGYARD_KEY?.trim();
if (!key) {
  try {
    key = readFileSync(keyPath, 'utf8').trim();
  } catch {
    console.error(`No encuentro la clave de agente: ni DAGYARD_KEY ni ${keyPath}`);
    process.exit(2);
  }
}

const data = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'migrate-d12.data.json'), 'utf8'));
// cada escritura con su Idempotency-Key: reintentar un 503 no la duplica
const call = (method, path, body) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      ...(body !== undefined && { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

try {
  const report = await migrateD12(call, data, { dryRun });
  process.stdout.write(formatD12(report, dryRun));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`dagyard: ${key ? msg.split(key).join('***') : msg}`);
  process.exit(1);
}
