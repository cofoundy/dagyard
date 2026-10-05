/**
 * Esquema del DO `Store` (SQLite). Cada versión es una lista de sentencias; se aplican en orden y una
 * sola vez (tabla `_schema`). Para cambiar el esquema, agrega una versión nueva: nunca edites una aplicada.
 */
export const MIGRATIONS: string[][] = [
  // v1
  [
    `CREATE TABLE projects (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       stages TEXT NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE nodes (
       project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
       id TEXT NOT NULL,
       stage TEXT NOT NULL,
       title TEXT NOT NULL,
       status TEXT NOT NULL CHECK (status IN ('pending', 'working', 'blocked', 'done')),
       progress REAL NOT NULL DEFAULT 0,
       team TEXT,
       goal TEXT,
       report_url TEXT,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (project_id, id)
     )`,
    `CREATE TABLE edges (
       project_id TEXT NOT NULL,
       from_id TEXT NOT NULL,
       to_id TEXT NOT NULL,
       PRIMARY KEY (project_id, from_id, to_id),
       FOREIGN KEY (project_id, from_id) REFERENCES nodes(project_id, id) ON DELETE CASCADE,
       FOREIGN KEY (project_id, to_id) REFERENCES nodes(project_id, id) ON DELETE CASCADE
     )`,
    `CREATE TABLE blockers (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       node_id TEXT NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('decision', 'review', 'access')),
       question TEXT NOT NULL,
       options TEXT NOT NULL,
       access_label TEXT,
       status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
       resolution TEXT,
       resolved_by TEXT,
       resolved_at TEXT,
       access_value TEXT, -- AES-GCM con VAULT_KEY: nunca sale en snapshots ni eventos
       created_at TEXT NOT NULL,
       FOREIGN KEY (project_id, node_id) REFERENCES nodes(project_id, id) ON DELETE CASCADE
     )`,
    `CREATE INDEX blockers_project ON blockers(project_id, node_id)`,
    `CREATE TABLE messages (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       node_id TEXT NOT NULL,
       from_name TEXT NOT NULL,
       text TEXT NOT NULL,
       report_url TEXT,
       created_at TEXT NOT NULL,
       FOREIGN KEY (project_id, node_id) REFERENCES nodes(project_id, id) ON DELETE CASCADE
     )`,
    `CREATE INDEX messages_project ON messages(project_id, created_at)`,
    `CREATE TABLE events (
       project_id TEXT NOT NULL,
       seq INTEGER NOT NULL,
       type TEXT NOT NULL,
       actor TEXT NOT NULL,
       at TEXT NOT NULL,
       payload TEXT NOT NULL,
       PRIMARY KEY (project_id, seq)
     )`,
  ],
  // v2: sesiones del navegador (#12). La cookie lleva un id aleatorio; aquí solo su SHA-256.
  [
    `CREATE TABLE sessions (
       id_hash TEXT PRIMARY KEY,
       owner_fp TEXT NOT NULL, -- huella del OWNER_TOKEN con que se abrió: rotarlo invalida la sesión
       created_at TEXT NOT NULL,
       expires_at TEXT NOT NULL
     )`,
    `CREATE INDEX sessions_expires ON sessions(expires_at)`,
  ],
  // v3: detalle técnico de la tarea (#45): URL del issue o del PR
  [`ALTER TABLE nodes ADD COLUMN link TEXT`],
  // v4: claves de idempotencia (#54): repetir una escritura con la misma `Idempotency-Key` devuelve lo guardado
  [
    `CREATE TABLE idempotency (
       project_id TEXT NOT NULL,
       key TEXT NOT NULL,
       fp TEXT NOT NULL, -- huella de la escritura: la misma clave con otra escritura → 409
       value TEXT NOT NULL, -- JSON del valor que devolvió la primera vez
       events TEXT NOT NULL, -- JSON de sus eventos: se vuelven a repartir (el DO del proyecto ignora los ya enviados)
       created_at TEXT NOT NULL,
       PRIMARY KEY (project_id, key)
     )`,
    `CREATE INDEX idempotency_created ON idempotency(created_at)`,
  ],
  // v5: piso de los eventos (#74). La demo poda su log al re-sembrar; un `since` por debajo del piso recibe
  // `resync` en vez de un replay con hueco. Un proyecto que no es demo nunca se poda: su piso queda en 0.
  [`ALTER TABLE projects ADD COLUMN events_floor INTEGER NOT NULL DEFAULT 0`],
  // v6: idioma de los datos del proyecto (#77). NULL = guardado antes del campo; se lee como LEGACY_LANG ('es')
  // y nadie lo reescribe: solo cambia si un POST, PUT o PATCH manda `lang`.
  [`ALTER TABLE projects ADD COLUMN lang TEXT`],
  // v7: la fábrica en el tiempo (#75). Un equipo = un sitio de `/factory`, con las fechas del sitio (no las de la
  // escritura). Cada tarea gana cuándo arrancó (primera vez en `working`), cuándo quedó lista y qué equipo la tomó.
  [
    `CREATE TABLE teams (
       project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
       id TEXT NOT NULL,
       name TEXT NOT NULL,
       node_ids TEXT NOT NULL DEFAULT '[]', -- JSON: ids de tareas (pueden no existir todavía)
       requested_at TEXT,
       started_at TEXT,
       closed_at TEXT,
       outcome TEXT,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (project_id, id)
     )`,
    `ALTER TABLE nodes ADD COLUMN started_at TEXT`,
    `ALTER TABLE nodes ADD COLUMN done_at TEXT`,
    `ALTER TABLE nodes ADD COLUMN team_id TEXT`,
    // backfill desde el log: el primer evento de la tarea en `working` (un PUT no deja eventos por tarea: esas
    // quedan en null, y la UI infiere como con los datos viejos)
    `UPDATE nodes SET started_at = (
       SELECT MIN(e.at) FROM events e
        WHERE e.project_id = nodes.project_id AND e.type IN ('node.added', 'node.updated')
          AND json_extract(e.payload, '$.node.id') = nodes.id AND json_extract(e.payload, '$.node.status') = 'working'
     )`,
    // las que están `done`: la llegada a `done` más reciente (el primer `done` después del último evento que no lo era)
    `UPDATE nodes SET done_at = (
       SELECT MIN(e.at) FROM events e
        WHERE e.project_id = nodes.project_id AND e.type IN ('node.added', 'node.updated')
          AND json_extract(e.payload, '$.node.id') = nodes.id AND json_extract(e.payload, '$.node.status') = 'done'
          AND e.seq > COALESCE((
            SELECT MAX(f.seq) FROM events f
             WHERE f.project_id = nodes.project_id AND f.type IN ('node.added', 'node.updated')
               AND json_extract(f.payload, '$.node.id') = nodes.id AND json_extract(f.payload, '$.node.status') <> 'done'
          ), 0)
     ) WHERE status = 'done'`,
  ],
  // v8: el modelo del DAG (#90, D12). Cuatro tipos de nodo (los guardados antes son `task`), cuándo nació (el eje x;
  // los viejos: su `created_at`), la cita de un pedido y el cierre con motivo (los `done` existentes quedan cerrados
  // como `done`). «Nació de» va en su propia tabla: las aristas existentes ya son «necesita» y no cambian.
  [
    `ALTER TABLE nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'`,
    `ALTER TABLE nodes ADD COLUMN born_at TEXT`,
    `UPDATE nodes SET born_at = created_at`,
    `ALTER TABLE nodes ADD COLUMN quote TEXT`,
    `ALTER TABLE nodes ADD COLUMN quote_by TEXT`,
    `ALTER TABLE nodes ADD COLUMN closed_as TEXT`,
    `ALTER TABLE nodes ADD COLUMN closed_reason TEXT`,
    `ALTER TABLE nodes ADD COLUMN replaced_by TEXT`,
    `ALTER TABLE nodes ADD COLUMN closed_at TEXT`,
    `UPDATE nodes SET closed_as = 'done', closed_at = COALESCE(done_at, updated_at) WHERE status = 'done'`,
    `CREATE TABLE origins (
       project_id TEXT NOT NULL,
       from_id TEXT NOT NULL,
       to_id TEXT NOT NULL,
       why TEXT,
       created_at TEXT NOT NULL,
       PRIMARY KEY (project_id, from_id, to_id),
       FOREIGN KEY (project_id, from_id) REFERENCES nodes(project_id, id) ON DELETE CASCADE,
       FOREIGN KEY (project_id, to_id) REFERENCES nodes(project_id, id) ON DELETE CASCADE
     )`,
  ],
];

/**
 * Lleva el SQL a la versión `upTo` (por defecto, la última). Cada versión corre una sola vez, en orden; el llamador
 * la envuelve en una transacción. Los tests la usan para preparar una base vieja y migrarla.
 */
export function migrate(sql: SqlStorage, upTo = MIGRATIONS.length): void {
  sql.exec('CREATE TABLE IF NOT EXISTS _schema (version INTEGER NOT NULL)');
  const current = Number(sql.exec<{ v: number | null }>('SELECT MAX(version) AS v FROM _schema').one().v ?? 0);
  MIGRATIONS.forEach((stmts, i) => {
    if (i + 1 <= current || i + 1 > upTo) return;
    for (const s of stmts) sql.exec(s);
    sql.exec('INSERT INTO _schema (version) VALUES (?)', i + 1);
  });
}
