// Camada de dados: SQLite nativo do Node, esquema e utilitários.
// Valores monetários são armazenados em centavos (INTEGER) para evitar erros de arredondamento.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'America/New_York',
  locale TEXT NOT NULL DEFAULT 'pt-BR', currency TEXT NOT NULL DEFAULT 'USD', phone TEXT, email TEXT,
  demo INTEGER NOT NULL DEFAULT 1, seq_quote INTEGER NOT NULL DEFAULT 1000, seq_invoice INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crews (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL, color TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE, phone TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','assistant','field')), crew_id INTEGER REFERENCES crews(id),
  hourly_cost INTEGER NOT NULL DEFAULT 0, permissions TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), company_id INTEGER NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL,
  phone TEXT, email TEXT, source TEXT, preferences TEXT, notes TEXT, channels TEXT NOT NULL DEFAULT '{}',
  automation_paused INTEGER NOT NULL DEFAULT 0, automation_paused_by INTEGER, automation_paused_at TEXT,
  next_action TEXT, next_action_due TEXT, next_action_owner_id INTEGER REFERENCES users(id),
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_clients_company ON clients(company_id);
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  label TEXT, line1 TEXT NOT NULL, line2 TEXT, city TEXT, state TEXT, zip TEXT, access_notes TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL, stage TEXT NOT NULL CHECK (stage IN ('new','contacted','quote_sent','approved','lost')),
  owner_id INTEGER REFERENCES users(id), estimated_value INTEGER NOT NULL DEFAULT 0, next_action TEXT, next_action_due TEXT,
  source TEXT, lost_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  opportunity_id INTEGER REFERENCES opportunities(id), address_id INTEGER REFERENCES addresses(id), number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','sent','approved','declined')), title TEXT NOT NULL, notes TEXT,
  valid_until TEXT NOT NULL, payment_terms TEXT NOT NULL, frequency TEXT NOT NULL DEFAULT 'one_time',
  total INTEGER NOT NULL DEFAULT 0, public_token TEXT, sent_at TEXT, approved_at TEXT, approved_via TEXT, declined_at TEXT,
  decline_reason TEXT, created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quote_items (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, quote_id INTEGER NOT NULL REFERENCES quotes(id),
  description TEXT NOT NULL, details TEXT, quantity REAL NOT NULL, unit_price INTEGER NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_series (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, client_id INTEGER NOT NULL, address_id INTEGER, quote_id INTEGER,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly')), anchor_date TEXT NOT NULL, time_local TEXT NOT NULL,
  duration_min INTEGER NOT NULL, crew_id INTEGER, price INTEGER NOT NULL, title TEXT NOT NULL, instructions TEXT, checklist TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  address_id INTEGER REFERENCES addresses(id), quote_id INTEGER REFERENCES quotes(id), opportunity_id INTEGER,
  series_id INTEGER REFERENCES job_series(id), occurrence_index INTEGER, title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_schedule','scheduled','in_progress','completed','canceled')),
  requested_frequency TEXT NOT NULL DEFAULT 'one_time', start_at TEXT, duration_min INTEGER NOT NULL DEFAULT 180,
  crew_id INTEGER REFERENCES crews(id), price INTEGER NOT NULL DEFAULT 0, instructions TEXT, checklist TEXT NOT NULL DEFAULT '[]',
  costs_complete INTEGER NOT NULL DEFAULT 0, detached INTEGER NOT NULL DEFAULT 0, schedule_version INTEGER NOT NULL DEFAULT 0,
  on_the_way_at TEXT, started_at TEXT, completed_at TEXT, canceled_at TEXT, cancel_reason TEXT,
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_jobs_company_start ON jobs(company_id, start_at);
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, job_id INTEGER NOT NULL REFERENCES jobs(id), user_id INTEGER REFERENCES users(id),
  hours REAL NOT NULL, cost INTEGER NOT NULL DEFAULT 0, cost_missing INTEGER NOT NULL DEFAULT 0, note TEXT, created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, job_id INTEGER REFERENCES jobs(id), category TEXT NOT NULL,
  description TEXT NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL, created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incomes (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, client_id INTEGER REFERENCES clients(id), description TEXT NOT NULL,
  amount INTEGER NOT NULL, date TEXT NOT NULL, method TEXT, created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, client_id INTEGER NOT NULL REFERENCES clients(id),
  job_id INTEGER REFERENCES jobs(id), quote_id INTEGER REFERENCES quotes(id), number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit','final','standalone')), description TEXT, amount INTEGER NOT NULL,
  due_date TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','partial','paid','void')), source_key TEXT,
  issued_at TEXT NOT NULL, issued_date TEXT NOT NULL, paid_at TEXT, voided_at TEXT, created_by INTEGER,
  UNIQUE (company_id, source_key)
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  client_id INTEGER NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, paid_date TEXT NOT NULL, note TEXT,
  provider TEXT NOT NULL DEFAULT 'manual', created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, title TEXT NOT NULL, description TEXT,
  type TEXT NOT NULL DEFAULT 'general' CHECK (type IN ('general','followup','complaint','reply','scheduling','billing')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','canceled')),
  assignee_id INTEGER NOT NULL REFERENCES users(id), due_date TEXT NOT NULL, client_id INTEGER REFERENCES clients(id),
  job_id INTEGER REFERENCES jobs(id), quote_id INTEGER REFERENCES quotes(id), source_key TEXT,
  created_by INTEGER, created_at TEXT NOT NULL, completed_at TEXT, completed_by INTEGER,
  UNIQUE (company_id, source_key)
);
CREATE TABLE IF NOT EXISTS journeys (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  category TEXT NOT NULL CHECK (category IN ('operational','commercial','billing','relationship')),
  triggers TEXT NOT NULL, conditions TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]',
  owner_id INTEGER REFERENCES users(id), rules TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
  UNIQUE (company_id, key)
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, journey_id INTEGER NOT NULL REFERENCES journeys(id),
  client_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, dedupe_key TEXT NOT NULL,
  trigger_event TEXT, event_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed','stopped')), pause_reason TEXT, stop_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (company_id, journey_id, dedupe_key)
);
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  journey_id INTEGER NOT NULL, client_id INTEGER NOT NULL, step_index INTEGER NOT NULL, channel TEXT NOT NULL,
  subject TEXT, body TEXT NOT NULL, anchor TEXT NOT NULL, offset_minutes INTEGER NOT NULL, send_hour INTEGER,
  send_at TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','sent','blocked','canceled')),
  status_reason TEXT, hold_reason TEXT, communication_id INTEGER, dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (company_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS ix_sched_pending ON scheduled_messages(status, send_at);
CREATE TABLE IF NOT EXISTS communications (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, client_id INTEGER NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('out','in','note')),
  channel TEXT NOT NULL, to_address TEXT, subject TEXT, body TEXT NOT NULL, status TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 1,
  provider TEXT, kind TEXT, journey_id INTEGER, enrollment_id INTEGER, scheduled_message_id INTEGER,
  related_type TEXT, related_id INTEGER, created_by INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, type TEXT NOT NULL, entity_type TEXT, entity_id INTEGER,
  client_id INTEGER, dedupe_key TEXT NOT NULL, payload TEXT, user_id INTEGER, created_at TEXT NOT NULL,
  UNIQUE (company_id, dedupe_key)
);
CREATE TABLE IF NOT EXISTS journey_log (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, journey_id INTEGER, enrollment_id INTEGER, client_id INTEGER,
  action TEXT NOT NULL, details TEXT, user_id INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, user_id INTEGER, entity_type TEXT NOT NULL, entity_id INTEGER,
  client_id INTEGER, action TEXT NOT NULL, from_status TEXT, to_status TEXT, details TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_client ON audit_log(company_id, client_id);
`;

function clean(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  raw.exec(SCHEMA);
  const cache = new Map();
  const st = (sql) => { let p = cache.get(sql); if (!p) { p = raw.prepare(sql); cache.set(sql, p); } return p; };
  let depth = 0;
  const db = {
    raw,
    all: (sql, ...a) => st(sql).all(...a.map(clean)),
    get: (sql, ...a) => st(sql).get(...a.map(clean)),
    run: (sql, ...a) => st(sql).run(...a.map(clean)),
    exec: (sql) => raw.exec(sql),
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN IMMEDIATE');
      try { const r = fn(); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
      finally { depth--; }
    },
    insert(table, obj) {
      const k = Object.keys(obj);
      const r = st(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => clean(obj[x])));
      return Number(r.lastInsertRowid);
    },
    // Atualização sempre restrita à empresa: impede escrita entre empresas mesmo com id adulterado.
    update(table, id, companyId, obj) {
      const k = Object.keys(obj);
      if (!k.length) return 0;
      const r = st(`UPDATE ${table} SET ${k.map((x) => `${x} = ?`).join(', ')} WHERE id = ? AND company_id = ?`)
        .run(...k.map((x) => clean(obj[x])), id, companyId);
      return Number(r.changes);
    },
  };
  return db;
}

module.exports = { open };
