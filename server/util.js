const crypto = require('crypto');
const TZ = require('../public/shared/tz.js');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg, extra) => new HttpError(400, msg, extra);

// Relógio central. Em produção usa o horário real; o seed da demonstração
// o posiciona em datas passadas para gerar um histórico coerente.
const clock = {
  fixed: null,
  now() { return this.fixed ?? Date.now(); },
  iso() { return new Date(this.now()).toISOString(); },
  set(ms) { this.fixed = ms; },
  reset() { this.fixed = null; },
};

function today(ctx) { return TZ.localDate(clock.now(), ctx.company.timezone); }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const test = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
const token = (n = 24) => crypto.randomBytes(n).toString('base64url');

const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// Validação simples e explícita, com mensagens claras em português.
const v = {
  str(val, label, { required = false, max = 500 } = {}) {
    const s = val == null ? '' : String(val).trim();
    if (required && !s) throw bad(`${label} é obrigatório.`, { field: label });
    if (s.length > max) throw bad(`${label} deve ter no máximo ${max} caracteres.`);
    return s || null;
  },
  email(val) {
    const s = v.str(val, 'E-mail', { max: 200 });
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('E-mail inválido.');
    return s ? s.toLowerCase() : null;
  },
  phone(val) {
    const s = v.str(val, 'Telefone', { max: 40 });
    if (!s) return null;
    const digits = s.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) throw bad('Telefone inválido. Use o formato (555) 123-4567.');
    const d = digits.slice(-10);
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  },
  cents(val, label, { min = 0, required = true } = {}) {
    if ((val === '' || val == null) && !required) return null;
    const n = Number(val);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw bad(`${label}: valor inválido.`);
    if (n < min) throw bad(`${label} deve ser maior${min > 0 ? '' : ' ou igual'} que ${min > 0 ? '$0.00' : 'zero'}.`);
    if (n > 100000000) throw bad(`${label}: valor acima do limite.`);
    return n;
  },
  num(val, label, { min = -Infinity, max = Infinity } = {}) {
    const n = Number(val);
    if (val === '' || val == null || !Number.isFinite(n)) throw bad(`${label}: informe um número.`);
    if (n < min || n > max) throw bad(`${label} deve estar entre ${min} e ${max}.`);
    return n;
  },
  date(val, label, { required = true } = {}) {
    if (!val && !required) return null;
    if (!TZ.isDate(val)) throw bad(`${label}: data inválida.`);
    return val;
  },
  time(val, label) { if (!TZ.isTime(val)) throw bad(`${label}: horário inválido.`); return val; },
  oneOf(val, list, label) { if (!list.includes(val)) throw bad(`${label}: opção inválida.`); return val; },
};

function audit(ctx, entity_type, entity_id, action, { from = null, to = null, details = null, client_id = null } = {}) {
  ctx.db.insert('audit_log', {
    company_id: ctx.company.id, user_id: ctx.user ? ctx.user.id : null, entity_type, entity_id, client_id,
    action, from_status: from, to_status: to, details, created_at: clock.iso(),
  });
}

// Busca um registro garantindo que pertence à empresa da sessão.
function one(ctx, table, id, label = 'Registro') {
  const row = ctx.db.get(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, Number(id), ctx.company.id);
  if (!row) throw new HttpError(404, `${label} não encontrado.`);
  return row;
}

const PERMS = ['clients', 'sales', 'schedule', 'tasks', 'journeys', 'finance', 'settings', 'field'];
const ROLE_DEFAULTS = {
  owner: Object.fromEntries(PERMS.map((p) => [p, true])),
  assistant: { clients: true, sales: true, schedule: true, tasks: true, journeys: true, finance: false, settings: false, field: false },
  field: { field: true },
};
// Somente estas permissões podem ser concedidas ou retiradas de uma assistente pelo dono.
const ASSISTANT_TOGGLES = ['clients', 'sales', 'schedule', 'tasks', 'journeys', 'finance'];

function permsFor(user) {
  if (user.role === 'owner') return { ...ROLE_DEFAULTS.owner };
  if (user.role === 'field') return { field: true };
  const custom = parse(user.permissions, {});
  const out = { ...ROLE_DEFAULTS.assistant };
  for (const k of ASSISTANT_TOGGLES) if (k in custom) out[k] = !!custom[k];
  out.settings = false;
  return out;
}

const round = (n) => Math.round(n);

module.exports = { HttpError, bad, clock, today, hashPassword, checkPassword, token, parse, v, audit, one, permsFor, ASSISTANT_TOGGLES, round, TZ };
