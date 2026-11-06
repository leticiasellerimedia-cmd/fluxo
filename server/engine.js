// Motor de eventos e jornadas.
// Cada evento de negócio é registrado uma única vez (chave de deduplicação), aplica as
// regras obrigatórias e inscreve o cliente nas jornadas cujo gatilho corresponde.
// As mensagens são pré-agendadas (visíveis na fila) e reavaliadas no momento do envio.
const { clock, parse, TZ } = require('./util');
const integrations = require('./integrations');

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000';

const EVENTS = {
  'lead.created': 'Novo contato cadastrado',
  'quote.sent': 'Orçamento enviado',
  'quote.approved': 'Orçamento aprovado',
  'quote.declined': 'Orçamento recusado',
  'opportunity.lost': 'Oportunidade perdida',
  'job.scheduled': 'Serviço agendado',
  'job.rescheduled': 'Serviço reagendado',
  'job.on_the_way': 'Equipe a caminho',
  'job.completed': 'Serviço concluído',
  'job.canceled': 'Serviço cancelado',
  'invoice.issued': 'Cobrança emitida',
  'invoice.paid': 'Cobrança paga integralmente',
  'invoice.voided': 'Cobrança anulada',
  'payment.recorded': 'Pagamento registrado',
  'client.replied': 'Cliente respondeu',
  'complaint.opened': 'Reclamação aberta',
  'complaint.resolved': 'Reclamação resolvida',
  'channel.optout': 'Descadastro de canal',
};

const ANCHORS = {
  event: 'Momento do evento',
  job_start: 'Início do serviço',
  invoice_due: 'Vencimento da cobrança',
  quote_valid_until: 'Validade do orçamento',
};

const CHANNELS = { preferred: 'Melhor canal disponível', email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp' };

// Regras obrigatórias: aplicadas pelo motor, não podem ser desligadas na interface.
const MANDATORY_RULES = [
  'Aprovação ou recusa do orçamento encerra os follow-ups daquele orçamento.',
  'Resposta do cliente pausa as sequências comerciais e abre tarefa de atendimento.',
  'Pagamento integral (ou anulação) encerra os lembretes daquela cobrança.',
  'Reagendamento recalcula os lembretes do serviço.',
  'Cancelamento interrompe as mensagens do serviço cancelado.',
  'Reclamação abre tarefa e pausa ofertas comerciais até a resolução.',
  'Descadastro bloqueia os envios do canal correspondente.',
  'Atendimento assumido por uma pessoa pausa todas as automações do cliente.',
  'O mesmo evento nunca gera mensagens ou cobranças duplicadas.',
];

const CONDITIONS = {
  has_contact: { label: 'Cliente tem telefone ou e-mail', check: (c) => !!(c.client.phone || c.client.email) },
  quote_still_open: { label: 'Orçamento ainda aguardando resposta', check: (c) => !c.quote || c.quote.status === 'sent' },
  first_in_series_or_single: {
    label: 'Serviço avulso, 1ª visita da recorrência ou reagendamento',
    check: (c) => (c.trigger === 'job.rescheduled' ? !(c.payload && c.payload.bulk) : (!c.job || !c.job.series_id || c.job.occurrence_index === 0)),
  },
  job_not_recurring: { label: 'Serviço não recorrente', check: (c) => !c.job || !c.job.series_id },
  no_upcoming_job: {
    label: 'Cliente sem serviço futuro agendado',
    check: (c) => !c.ctx.db.get(`SELECT id FROM jobs WHERE company_id = ? AND client_id = ? AND status = 'scheduled' AND start_at > ?`, c.ctx.company.id, c.client.id, clock.iso()),
  },
  invoice_unpaid: { label: 'Cobrança com saldo em aberto', check: (c) => !c.invoice || (c.invoice.status === 'open' || c.invoice.status === 'partial') },
  no_open_complaint: { label: 'Sem reclamação em aberto', check: (c) => !hasOpenComplaint(c.ctx, c.client.id) },
};

const PAUSE_LABELS = { human: 'Atendimento assumido por uma pessoa', client_replied: 'Cliente respondeu', complaint: 'Reclamação em aberto' };

function hasOpenComplaint(ctx, clientId) {
  return !!ctx.db.get(`SELECT id FROM tasks WHERE company_id = ? AND client_id = ? AND type = 'complaint' AND status IN ('open','in_progress')`, ctx.company.id, clientId);
}

function log(ctx, journey_id, enrollment_id, client_id, action, details) {
  ctx.db.insert('journey_log', {
    company_id: ctx.company.id, journey_id, enrollment_id, client_id, action, details,
    user_id: ctx.user ? ctx.user.id : null, created_at: clock.iso(),
  });
}

function balanceOf(ctx, invoice) {
  const paid = ctx.db.get('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE company_id = ? AND invoice_id = ?', ctx.company.id, invoice.id).s;
  return invoice.amount - paid;
}

// Carrega cliente e registros relacionados à entidade da inscrição.
function loadContext(ctx, entity_type, entity_id, client_id, trigger) {
  const g = (t, id) => (id ? ctx.db.get(`SELECT * FROM ${t} WHERE id = ? AND company_id = ?`, id, ctx.company.id) : null);
  const c = { ctx, trigger, client: g('clients', client_id), job: null, quote: null, invoice: null, address: null, crew: null };
  if (entity_type === 'job') c.job = g('jobs', entity_id);
  if (entity_type === 'quote') c.quote = g('quotes', entity_id);
  if (entity_type === 'invoice') { c.invoice = g('invoices', entity_id); if (c.invoice) { c.job = g('jobs', c.invoice.job_id); c.quote = g('quotes', c.invoice.quote_id); } }
  if (entity_type === 'opportunity') { const o = g('opportunities', entity_id); if (o) c.quote = ctx.db.get(`SELECT * FROM quotes WHERE company_id = ? AND opportunity_id = ? ORDER BY id DESC`, ctx.company.id, o.id) || null; }
  if (c.job) { c.address = g('addresses', c.job.address_id); c.crew = g('crews', c.job.crew_id); }
  else if (c.quote) c.address = g('addresses', c.quote.address_id);
  if (!c.address && c.client) c.address = ctx.db.get('SELECT * FROM addresses WHERE company_id = ? AND client_id = ? ORDER BY id', ctx.company.id, c.client.id) || null;
  return c;
}

const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function usDate(dateStr) { const [y, m, d] = dateStr.split('-'); return `${m}/${d}/${y}`; }
function usTime(iso, tz) {
  const [h, m] = TZ.localTime(iso, tz).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function render(tpl, c) {
  const tz = c.ctx.company.timezone;
  const vars = {
    empresa: c.ctx.company.name,
    cliente: c.client.name,
    cliente_primeiro_nome: c.client.name.split(' ')[0],
    data_servico: c.job && c.job.start_at ? usDate(TZ.localDate(c.job.start_at, tz)) : '(data a definir)',
    hora_servico: c.job && c.job.start_at ? usTime(c.job.start_at, tz) : '(horário a definir)',
    endereco: c.address ? [c.address.line1, c.address.city].filter(Boolean).join(', ') : '(endereço não informado)',
    equipe: c.crew ? c.crew.name : 'our team',
    orcamento_numero: c.quote ? c.quote.number : '',
    orcamento_valor: c.quote ? usd(c.quote.total) : '',
    link_orcamento: c.quote && c.quote.public_token ? `${PUBLIC_URL}/q/${c.quote.public_token}` : '',
    cobranca_numero: c.invoice ? c.invoice.number : '',
    valor_aberto: c.invoice ? usd(balanceOf(c.ctx, c.invoice)) : '',
    vencimento: c.invoice ? usDate(c.invoice.due_date) : '',
  };
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function consent(client, channel) {
  const ch = parse(client.channels, {})[channel];
  if (!ch || !ch.allowed) return { ok: false, reason: `Canal ${CHANNELS[channel]} não autorizado pelo cliente` };
  if (ch.optout_at) return { ok: false, reason: `Cliente descadastrado do canal ${CHANNELS[channel]}` };
  return { ok: true };
}
function contactFor(client, channel) { return channel === 'email' ? client.email : client.phone; }

function resolveChannel(client, channel) {
  if (channel !== 'preferred') return channel;
  for (const ch of ['email', 'sms', 'whatsapp']) if (contactFor(client, ch) && consent(client, ch).ok) return ch;
  return client.email ? 'email' : 'sms';
}

// Calcula o horário de envio de uma etapa. Retorna null quando o momento já passou
// para âncoras de agenda (ex.: lembrete de 24h para um serviço marcado para daqui a 2h).
function computeSendAt(ctx, step, c, eventAt) {
  const tz = ctx.company.timezone;
  let base;
  if (step.anchor === 'job_start') { if (!c.job || !c.job.start_at) return null; base = Date.parse(c.job.start_at); }
  else if (step.anchor === 'invoice_due') { if (!c.invoice) return null; base = Date.parse(TZ.toUtc(c.invoice.due_date, '09:00', tz)); }
  else if (step.anchor === 'quote_valid_until') { if (!c.quote) return null; base = Date.parse(TZ.toUtc(c.quote.valid_until, '09:00', tz)); }
  else base = Date.parse(eventAt);
  let t = base + (Number(step.offset_minutes) || 0) * 60000;
  if (step.send_hour != null && step.send_hour !== '') {
    t = Date.parse(TZ.toUtc(TZ.localDate(t, tz), TZ.pad(Number(step.send_hour)) + ':00', tz));
  }
  const now = clock.now();
  if (t < now) {
    if (step.anchor === 'event') t = now;
    else return null;
  }
  return new Date(t).toISOString();
}

function journeyOf(ctx, id) { return ctx.db.get('SELECT * FROM journeys WHERE id = ? AND company_id = ?', id, ctx.company.id); }

function enroll(ctx, journey, ev) {
  const c = loadContext(ctx, ev.entity_type, ev.entity_id, ev.client_id, ev.type);
  if (!c.client) return null;
  c.payload = ev.payloadObj;
  const conds = parse(journey.conditions, []);
  const failed = conds.find((k) => CONDITIONS[k] && !CONDITIONS[k].check(c));
  if (failed) { log(ctx, journey.id, null, c.client.id, 'skipped', `Inscrição não criada: condição "${CONDITIONS[failed].label}" não atendida (${EVENTS[ev.type] || ev.type}).`); return null; }

  // Lembretes de serviço são únicos por serviço; os demais, por evento.
  const dedupe = journey.key === 'service_reminder' ? `job:${ev.entity_id}` : ev.dedupe_key;
  let status = 'active'; let pause_reason = null;
  if (c.client.automation_paused) { status = 'paused'; pause_reason = 'human'; }
  else if (journey.category === 'commercial' && hasOpenComplaint(ctx, c.client.id)) { status = 'paused'; pause_reason = 'complaint'; }
  const now = clock.iso();
  const ins = ctx.db.run(`INSERT OR IGNORE INTO enrollments (company_id, journey_id, client_id, entity_type, entity_id, dedupe_key, trigger_event, event_at, status, pause_reason, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ctx.company.id, journey.id, c.client.id, ev.entity_type, ev.entity_id, dedupe, ev.type, ev.created_at, status, pause_reason, now, now);
  if (!Number(ins.changes)) return null; // já inscrito por este evento: não duplica
  const enrollmentId = Number(ins.lastInsertRowid);
  log(ctx, journey.id, enrollmentId, c.client.id, 'enrolled', `Inscrição criada por "${EVENTS[ev.type] || ev.type}"${status === 'paused' ? ` (pausada: ${PAUSE_LABELS[pause_reason]})` : ''}.`);

  const steps = parse(journey.steps, []);
  steps.forEach((step, i) => {
    const sendAt = computeSendAt(ctx, step, c, ev.created_at);
    const channel = resolveChannel(c.client, step.channel);
    const base = {
      company_id: ctx.company.id, enrollment_id: enrollmentId, journey_id: journey.id, client_id: c.client.id, step_index: i,
      channel, subject: step.subject || null, body: step.body, anchor: step.anchor, offset_minutes: Number(step.offset_minutes) || 0,
      send_hour: step.send_hour === '' || step.send_hour == null ? null : Number(step.send_hour),
      dedupe_key: `enr:${enrollmentId}:step:${i}`, created_at: now, updated_at: now,
    };
    if (!sendAt) {
      ctx.db.insert('scheduled_messages', { ...base, send_at: now, status: 'canceled', status_reason: 'Horário da etapa já havia passado no momento da inscrição' });
    } else {
      ctx.db.insert('scheduled_messages', { ...base, send_at: sendAt, status: 'pending' });
    }
  });
  finishIfDone(ctx, enrollmentId);
  return enrollmentId;
}

function finishIfDone(ctx, enrollmentId) {
  const e = ctx.db.get('SELECT * FROM enrollments WHERE id = ? AND company_id = ?', enrollmentId, ctx.company.id);
  if (!e || e.status !== 'active') return;
  const pending = ctx.db.get(`SELECT COUNT(*) AS n FROM scheduled_messages WHERE company_id = ? AND enrollment_id = ? AND status = 'pending'`, ctx.company.id, enrollmentId).n;
  if (!pending) {
    ctx.db.update('enrollments', enrollmentId, ctx.company.id, { status: 'completed', updated_at: clock.iso() });
    log(ctx, e.journey_id, e.id, e.client_id, 'completed', 'Sequência concluída: todas as etapas foram processadas.');
  }
}

function stopEnrollments(ctx, where, params, reason) {
  const rows = ctx.db.all(`SELECT e.* FROM enrollments e JOIN journeys j ON j.id = e.journey_id WHERE e.company_id = ? AND e.status IN ('active','paused') AND ${where}`, ctx.company.id, ...params);
  for (const e of rows) {
    ctx.db.update('enrollments', e.id, ctx.company.id, { status: 'stopped', stop_reason: reason, updated_at: clock.iso() });
    ctx.db.run(`UPDATE scheduled_messages SET status = 'canceled', status_reason = ?, updated_at = ? WHERE company_id = ? AND enrollment_id = ? AND status = 'pending'`, reason, clock.iso(), ctx.company.id, e.id);
    log(ctx, e.journey_id, e.id, e.client_id, 'stopped', `Sequência encerrada: ${reason}.`);
  }
  return rows.length;
}

function pauseEnrollments(ctx, where, params, reason) {
  const rows = ctx.db.all(`SELECT e.* FROM enrollments e JOIN journeys j ON j.id = e.journey_id WHERE e.company_id = ? AND e.status = 'active' AND ${where}`, ctx.company.id, ...params);
  for (const e of rows) {
    ctx.db.update('enrollments', e.id, ctx.company.id, { status: 'paused', pause_reason: reason, updated_at: clock.iso() });
    log(ctx, e.journey_id, e.id, e.client_id, 'paused', `Sequência pausada: ${PAUSE_LABELS[reason] || reason}.`);
  }
  return rows;
}

function resumeEnrollments(ctx, where, params) {
  const rows = ctx.db.all(`SELECT e.* FROM enrollments e WHERE e.company_id = ? AND e.status = 'paused' AND ${where}`, ctx.company.id, ...params);
  const later = new Date(clock.now() + 3600000).toISOString();
  for (const e of rows) {
    ctx.db.update('enrollments', e.id, ctx.company.id, { status: 'active', pause_reason: null, updated_at: clock.iso() });
    // Etapas que venceram durante a pausa saem em 1 hora, e não imediatamente.
    const moved = ctx.db.run(`UPDATE scheduled_messages SET send_at = ?, hold_reason = NULL, updated_at = ? WHERE company_id = ? AND enrollment_id = ? AND status = 'pending' AND send_at < ?`, later, clock.iso(), ctx.company.id, e.id, clock.iso());
    ctx.db.run(`UPDATE scheduled_messages SET hold_reason = NULL WHERE company_id = ? AND enrollment_id = ? AND status = 'pending'`, ctx.company.id, e.id);
    log(ctx, e.journey_id, e.id, e.client_id, 'resumed', `Sequência retomada${Number(moved.changes) ? `; ${moved.changes} etapa(s) atrasada(s) reprogramada(s) para daqui a 1 hora` : ''}.`);
    finishIfDone(ctx, e.id);
  }
  return rows.length;
}

// Recalcula o horário das etapas pendentes ligadas a um serviço (ex.: após reagendamento).
function recomputeJob(ctx, jobId) {
  const rows = ctx.db.all(`SELECT m.*, e.client_id AS cid, e.event_at FROM scheduled_messages m JOIN enrollments e ON e.id = m.enrollment_id
    WHERE m.company_id = ? AND m.status = 'pending' AND e.entity_type = 'job' AND e.entity_id = ? AND m.anchor = 'job_start'`, ctx.company.id, jobId);
  for (const m of rows) {
    const c = loadContext(ctx, 'job', jobId, m.cid);
    const sendAt = computeSendAt(ctx, m, c, m.event_at);
    if (sendAt) {
      ctx.db.update('scheduled_messages', m.id, ctx.company.id, { send_at: sendAt, updated_at: clock.iso() });
      log(ctx, m.journey_id, m.enrollment_id, m.client_id, 'rescheduled', `Lembrete recalculado para o novo horário do serviço.`);
    } else {
      ctx.db.update('scheduled_messages', m.id, ctx.company.id, { status: 'canceled', status_reason: 'Novo horário não deixa tempo para o lembrete', updated_at: clock.iso() });
      log(ctx, m.journey_id, m.enrollment_id, m.client_id, 'message_canceled', 'Lembrete cancelado: o novo horário não deixa tempo para o envio.');
      finishIfDone(ctx, m.enrollment_id);
    }
  }
  // Lembretes que haviam sido cancelados por falta de tempo voltam a valer se o serviço foi adiado.
  const canceled = ctx.db.all(`SELECT m.*, e.client_id AS cid, e.event_at, e.status AS est FROM scheduled_messages m JOIN enrollments e ON e.id = m.enrollment_id
    WHERE m.company_id = ? AND m.status = 'canceled' AND m.status_reason LIKE 'Novo horário%' AND e.entity_type = 'job' AND e.entity_id = ? AND m.anchor = 'job_start'`, ctx.company.id, jobId);
  for (const m of canceled) {
    const c = loadContext(ctx, 'job', jobId, m.cid);
    const sendAt = computeSendAt(ctx, m, c, m.event_at);
    if (sendAt) {
      ctx.db.update('scheduled_messages', m.id, ctx.company.id, { status: 'pending', status_reason: null, send_at: sendAt, updated_at: clock.iso() });
      if (m.est === 'completed') ctx.db.update('enrollments', m.enrollment_id, ctx.company.id, { status: 'active', updated_at: clock.iso() });
    }
  }
}

function createTask(ctx, t) {
  const now = clock.iso();
  const r = ctx.db.run(`INSERT OR IGNORE INTO tasks (company_id, title, description, type, priority, status, assignee_id, due_date, client_id, job_id, quote_id, source_key, created_by, created_at)
    VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?,?)`, ctx.company.id, t.title, t.description || null, t.type || 'general', t.priority || 'normal',
  t.assignee_id, t.due_date, t.client_id || null, t.job_id || null, t.quote_id || null, t.source_key || null, ctx.user ? ctx.user.id : null, now);
  return Number(r.changes) ? Number(r.lastInsertRowid) : null;
}

function defaultAssignee(ctx, preferredRole = 'assistant') {
  const u = ctx.db.get(`SELECT id FROM users WHERE company_id = ? AND role = ? AND active = 1 ORDER BY id`, ctx.company.id, preferredRole)
    || ctx.db.get(`SELECT id FROM users WHERE company_id = ? AND role = 'owner' ORDER BY id`, ctx.company.id);
  return u ? u.id : null;
}

function applyRules(ctx, ev) {
  const p = ev.payloadObj || {};
  switch (ev.type) {
    case 'quote.approved':
    case 'quote.declined':
      stopEnrollments(ctx, `e.entity_type = 'quote' AND e.entity_id = ?`, [ev.entity_id], ev.type === 'quote.approved' ? 'orçamento aprovado' : 'orçamento recusado');
      break;
    case 'opportunity.lost':
      stopEnrollments(ctx, `e.entity_type = 'quote' AND e.entity_id IN (SELECT id FROM quotes WHERE opportunity_id = ?)`, [ev.entity_id], 'oportunidade marcada como perdida');
      break;
    case 'invoice.paid':
    case 'invoice.voided':
      stopEnrollments(ctx, `e.entity_type = 'invoice' AND e.entity_id = ?`, [ev.entity_id], ev.type === 'invoice.paid' ? 'pagamento integral recebido' : 'cobrança anulada');
      break;
    case 'job.rescheduled':
      recomputeJob(ctx, ev.entity_id);
      break;
    case 'job.canceled':
      stopEnrollments(ctx, `e.entity_type = 'job' AND e.entity_id = ?`, [ev.entity_id], 'serviço cancelado');
      break;
    case 'client.replied': {
      const paused = pauseEnrollments(ctx, `e.client_id = ? AND j.category = 'commercial' AND json_extract(j.rules, '$.pause_on_reply') = 1`, [ev.client_id], 'client_replied');
      const client = ctx.db.get('SELECT * FROM clients WHERE id = ? AND company_id = ?', ev.client_id, ctx.company.id);
      const journey = paused[0] ? journeyOf(ctx, paused[0].journey_id) : null;
      const assignee = (journey && journey.owner_id) || client.next_action_owner_id || defaultAssignee(ctx);
      createTask(ctx, {
        title: `Responder ${client.name}`, type: 'reply', priority: 'high', assignee_id: assignee,
        due_date: TZ.localDate(clock.now(), ctx.company.timezone), client_id: client.id,
        description: `Mensagem recebida: "${p.text || ''}"${paused.length ? `. ${paused.length} sequência(s) comercial(is) pausada(s) até o atendimento.` : ''}`,
        source_key: `reply:${ev.dedupe_key}`,
      });
      break;
    }
    case 'complaint.opened':
      pauseEnrollments(ctx, `e.client_id = ? AND j.category = 'commercial'`, [ev.client_id], 'complaint');
      break;
    case 'complaint.resolved':
      if (!hasOpenComplaint(ctx, ev.client_id)) resumeEnrollments(ctx, `e.client_id = ? AND e.pause_reason = 'complaint'`, [ev.client_id]);
      break;
    case 'channel.optout': {
      const rows = ctx.db.all(`SELECT * FROM scheduled_messages WHERE company_id = ? AND client_id = ? AND channel = ? AND status = 'pending'`, ctx.company.id, ev.client_id, p.channel);
      for (const m of rows) {
        ctx.db.update('scheduled_messages', m.id, ctx.company.id, { status: 'blocked', status_reason: `Cliente descadastrado do canal ${CHANNELS[p.channel]}`, updated_at: clock.iso() });
        log(ctx, m.journey_id, m.enrollment_id, m.client_id, 'message_blocked', `Etapa bloqueada por descadastro (${CHANNELS[p.channel]}).`);
        finishIfDone(ctx, m.enrollment_id);
      }
      break;
    }
    default: break;
  }
}

// Registra o evento uma única vez; eventos repetidos são ignorados.
function emit(ctx, type, { entity_type = null, entity_id = null, client_id = null, key = null, payload = null } = {}) {
  const dedupe_key = key || `${type}:${entity_type}:${entity_id}`;
  const created_at = clock.iso();
  const r = ctx.db.run(`INSERT OR IGNORE INTO events (company_id, type, entity_type, entity_id, client_id, dedupe_key, payload, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ctx.company.id, type, entity_type, entity_id, client_id, dedupe_key, payload ? JSON.stringify(payload) : null, ctx.user ? ctx.user.id : null, created_at);
  if (!Number(r.changes)) return { duplicate: true };
  const ev = { id: Number(r.lastInsertRowid), type, entity_type, entity_id, client_id, dedupe_key, created_at, payloadObj: payload };
  applyRules(ctx, ev);
  const journeys = ctx.db.all(`SELECT j.* FROM journeys j, json_each(j.triggers) t WHERE j.company_id = ? AND j.active = 1 AND t.value = ?`, ctx.company.id, type);
  for (const j of journeys) enroll(ctx, j, ev);
  return { duplicate: false, event_id: ev.id };
}

function setMsg(ctx, m, fields, action, details) {
  ctx.db.update('scheduled_messages', m.id, ctx.company.id, { ...fields, updated_at: clock.iso() });
  if (action) log(ctx, m.journey_id, m.enrollment_id, m.client_id, action, details);
}

function hold(ctx, m, reason) {
  if (m.hold_reason !== reason) setMsg(ctx, m, { hold_reason: reason }, 'held', `Etapa ${m.step_index + 1} aguardando: ${reason}.`);
  return { outcome: 'held', reason };
}

// Avalia e envia (em simulação) uma etapa agendada.
function deliver(ctx, m) {
  const e = ctx.db.get('SELECT * FROM enrollments WHERE id = ? AND company_id = ?', m.enrollment_id, ctx.company.id);
  const journey = journeyOf(ctx, m.journey_id);
  if (!e || e.status === 'stopped' || e.status === 'completed') { setMsg(ctx, m, { status: 'canceled', status_reason: 'Sequência encerrada' }); return { outcome: 'canceled' }; }
  const c = loadContext(ctx, e.entity_type, e.entity_id, e.client_id, e.trigger_event);
  if (e.status === 'paused') return hold(ctx, m, PAUSE_LABELS[e.pause_reason] || 'sequência pausada');
  if (c.client.automation_paused) return hold(ctx, m, PAUSE_LABELS.human);
  if (journey.category === 'commercial' && hasOpenComplaint(ctx, c.client.id)) {
    pauseEnrollments(ctx, `e.id = ?`, [e.id], 'complaint');
    return hold(ctx, m, PAUSE_LABELS.complaint);
  }
  if (c.job && c.job.status === 'canceled') { stopEnrollments(ctx, 'e.id = ?', [e.id], 'serviço cancelado'); return { outcome: 'canceled' }; }
  const conds = parse(journey.conditions, []);
  const failed = conds.find((k) => CONDITIONS[k] && !CONDITIONS[k].check(c));
  if (failed) {
    setMsg(ctx, m, { status: 'canceled', status_reason: `Condição não atendida: ${CONDITIONS[failed].label}` }, 'message_canceled', `Etapa ${m.step_index + 1} não enviada: ${CONDITIONS[failed].label}.`);
    finishIfDone(ctx, e.id);
    return { outcome: 'canceled' };
  }
  const cs = consent(c.client, m.channel);
  const to = contactFor(c.client, m.channel);
  if (!cs.ok || !to) {
    const reason = !cs.ok ? cs.reason : `Cliente sem ${m.channel === 'email' ? 'e-mail' : 'telefone'} cadastrado`;
    setMsg(ctx, m, { status: 'blocked', status_reason: reason }, 'message_blocked', `Etapa ${m.step_index + 1} bloqueada: ${reason}.`);
    finishIfDone(ctx, e.id);
    return { outcome: 'blocked', reason };
  }
  const subject = m.subject ? render(m.subject, c) : null;
  const body = render(m.body, c);
  const res = integrations.sendMessage(m.channel, { to, subject, body });
  const related = e.entity_type;
  const commId = ctx.db.insert('communications', {
    company_id: ctx.company.id, client_id: c.client.id, direction: 'out', channel: m.channel, to_address: to, subject, body,
    status: res.simulated ? 'simulated' : 'sent', simulated: res.simulated ? 1 : 0, provider: res.provider, kind: 'automation',
    journey_id: journey.id, enrollment_id: e.id, scheduled_message_id: m.id, related_type: related, related_id: e.entity_id,
    created_by: null, created_at: clock.iso(),
  });
  setMsg(ctx, m, { status: 'sent', hold_reason: null, communication_id: commId }, 'message_sent', `Etapa ${m.step_index + 1} enviada (simulação) por ${CHANNELS[m.channel]} para ${to}.`);
  finishIfDone(ctx, e.id);
  return { outcome: 'sent', communication_id: commId };
}

function processDue(ctx, { until = clock.now(), replay = false } = {}) {
  const rows = ctx.db.all(`SELECT * FROM scheduled_messages WHERE company_id = ? AND status = 'pending' AND send_at <= ? ORDER BY send_at, id`, ctx.company.id, new Date(until).toISOString());
  let sent = 0;
  for (const m of rows) {
    if (replay) clock.set(Date.parse(m.send_at));
    const fresh = ctx.db.get('SELECT * FROM scheduled_messages WHERE id = ?', m.id);
    if (fresh.status !== 'pending') continue;
    const r = ctx.db.tx(() => deliver(ctx, fresh));
    if (r.outcome === 'sent') sent++;
  }
  return { processed: rows.length, sent };
}

function catalog() {
  return {
    events: EVENTS, anchors: ANCHORS, channels: CHANNELS, mandatory_rules: MANDATORY_RULES,
    conditions: Object.fromEntries(Object.entries(CONDITIONS).map(([k, x]) => [k, x.label])), pause_labels: PAUSE_LABELS,
  };
}

module.exports = {
  emit, processDue, deliver, pauseEnrollments, resumeEnrollments, stopEnrollments, createTask, defaultAssignee,
  hasOpenComplaint, balanceOf, catalog, log, consent, PAUSE_LABELS, CONDITIONS, render, loadContext, usd, usDate, usTime,
};
