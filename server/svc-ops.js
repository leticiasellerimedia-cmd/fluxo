// Agenda, execução, recorrência e registro de horas/custos.
const { HttpError, bad, clock, today, parse, v, audit, one, TZ } = require('./util');
const engine = require('./engine');
const crm = require('./svc-crm');

const C = (ctx) => ctx.company.id;
const now = () => clock.iso();
const STATUS_LABEL = { pending_schedule: 'Pendente de agendamento', scheduled: 'Agendado', in_progress: 'Em andamento', completed: 'Concluído', canceled: 'Cancelado' };
const FREQ_LABEL = { one_time: 'Avulso', weekly: 'Semanal', biweekly: 'Quinzenal', monthly: 'Mensal' };
const HORIZON = 6; // ocorrências futuras mantidas geradas por recorrência

const endOf = (j) => Date.parse(j.start_at) + j.duration_min * 60000;

function sanitize(ctx, job) {
  if (ctx.perms.finance || ctx.user.role !== 'field') return job;
  const { price, ...rest } = job; // equipe de campo não vê valores
  return rest;
}

function enrich(ctx, rows) {
  const tz = ctx.company.timezone;
  return rows.map((j) => ({
    ...j, checklist: parse(j.checklist, []),
    local_date: j.start_at ? TZ.localDate(j.start_at, tz) : null, local_time: j.start_at ? TZ.localTime(j.start_at, tz) : null,
  }));
}

const JOB_SELECT = `SELECT j.*, c.name AS client_name, c.phone AS client_phone, cr.name AS crew_name, cr.color AS crew_color,
  a.line1, a.line2, a.city, a.state, a.zip, a.access_notes, s.frequency AS series_frequency, s.active AS series_active
  FROM jobs j JOIN clients c ON c.id = j.client_id LEFT JOIN crews cr ON cr.id = j.crew_id
  LEFT JOIN addresses a ON a.id = j.address_id LEFT JOIN job_series s ON s.id = j.series_id`;

function fieldFilter(ctx) {
  if (ctx.user.role !== 'field') return { sql: '', params: [] };
  return { sql: ' AND j.crew_id = ?', params: [ctx.user.crew_id || -1] };
}

function listJobs(ctx, { from = null, to = null, status = null, client_id = null } = {}) {
  const f = fieldFilter(ctx);
  const rows = ctx.db.all(`${JOB_SELECT} WHERE j.company_id = ?${f.sql}
    AND (? IS NULL OR j.start_at >= ?) AND (? IS NULL OR j.start_at < ?) AND (? IS NULL OR j.status = ?) AND (? IS NULL OR j.client_id = ?)
    ORDER BY COALESCE(j.start_at, j.created_at)`, C(ctx), ...f.params, from, from, to, to, status, status, client_id, client_id);
  const list = enrich(ctx, rows);
  // Marca conflitos de horário entre serviços da mesma equipe.
  const active = list.filter((j) => j.start_at && j.crew_id && ['scheduled', 'in_progress'].includes(j.status));
  for (const a of active) {
    a.conflicts = active.filter((b) => b.id !== a.id && b.crew_id === a.crew_id && Date.parse(b.start_at) < endOf(a) && endOf(b) > Date.parse(a.start_at)).map((b) => b.id);
  }
  return list.map((j) => sanitize(ctx, j));
}

function assertFieldAccess(ctx, job) {
  if (ctx.user.role === 'field' && job.crew_id !== ctx.user.crew_id) throw new HttpError(404, 'Serviço não encontrado.');
}

function jobCosts(ctx, jobId) {
  const time = ctx.db.all(`SELECT t.*, u.name AS user_name FROM time_entries t LEFT JOIN users u ON u.id = t.user_id WHERE t.company_id = ? AND t.job_id = ? ORDER BY t.id`, C(ctx), jobId);
  const expenses = ctx.db.all('SELECT * FROM expenses WHERE company_id = ? AND job_id = ? ORDER BY id', C(ctx), jobId);
  const labor = time.reduce((s, t) => s + t.cost, 0);
  const other = expenses.reduce((s, e) => s + e.amount, 0);
  return { time, expenses, labor, other, total: labor + other, hours: time.reduce((s, t) => s + t.hours, 0), missing_rate: time.some((t) => t.cost_missing) };
}

function directResult(ctx, job, costs) {
  const gaps = [];
  if (job.status !== 'completed') gaps.push('Serviço ainda não concluído');
  if (!costs.time.length) gaps.push('Nenhuma hora registrada');
  if (costs.missing_rate) gaps.push('Há horas sem custo/hora configurado para a pessoa');
  if (!job.costs_complete) gaps.push('Custos ainda não confirmados como completos');
  return {
    revenue: job.price, costs: costs.total, result: job.price - costs.total,
    complete: gaps.length === 0, gaps,
  };
}

function getJob(ctx, id) {
  const row = ctx.db.get(`${JOB_SELECT} WHERE j.id = ? AND j.company_id = ?`, Number(id), C(ctx));
  if (!row) throw new HttpError(404, 'Serviço não encontrado.');
  assertFieldAccess(ctx, row);
  const job = enrich(ctx, [row])[0];
  const users = crm.usersMap(ctx);
  const costs = jobCosts(ctx, job.id);
  const isField = ctx.user.role === 'field';
  const out = {
    ...job,
    client: ctx.db.get('SELECT id, name, phone, email, preferences FROM clients WHERE id = ? AND company_id = ?', job.client_id, C(ctx)),
    quote: job.quote_id ? ctx.db.get('SELECT id, number, payment_terms, frequency, status FROM quotes WHERE id = ? AND company_id = ?', job.quote_id, C(ctx)) : null,
    time_entries: costs.time.map((t) => (isField ? { id: t.id, hours: t.hours, user_name: t.user_name, note: t.note, created_at: t.created_at } : t)),
    expenses: isField ? costs.expenses.map((e) => ({ id: e.id, description: e.description, category: e.category, date: e.date })) : costs.expenses,
    hours: costs.hours,
    history: ctx.db.all(`SELECT * FROM audit_log WHERE company_id = ? AND entity_type = 'job' AND entity_id = ? ORDER BY id DESC`, C(ctx), job.id).map((h) => ({ ...h, user: h.user_id ? users[h.user_id]?.name : 'Sistema' })),
    crews: ctx.db.all('SELECT id, name FROM crews WHERE company_id = ?', C(ctx)),
  };
  if (out.quote) out.quote.payment_terms = parse(out.quote.payment_terms, {});
  if (!isField) {
    out.messages = ctx.db.all(`SELECT m.id, m.channel, m.send_at, m.status, m.status_reason, m.hold_reason, m.step_index, j.name AS journey_name FROM scheduled_messages m
      JOIN enrollments e ON e.id = m.enrollment_id JOIN journeys j ON j.id = m.journey_id WHERE m.company_id = ? AND e.entity_type = 'job' AND e.entity_id = ? ORDER BY m.send_at`, C(ctx), job.id);
    out.result = directResult(ctx, job, costs);
    out.costs = { labor: costs.labor, other: costs.other, total: costs.total };
  }
  if (ctx.perms.finance) {
    out.invoices = ctx.db.all('SELECT * FROM invoices WHERE company_id = ? AND job_id = ? ORDER BY id', C(ctx), job.id).map((i) => ({ ...i, balance: i.status === 'void' ? 0 : engine.balanceOf(ctx, i) }));
  }
  return sanitize(ctx, out);
}

function findConflicts(ctx, { crew_id, start_at, duration_min, exclude_ids = [] }) {
  if (!crew_id) return [];
  const s = Date.parse(start_at); const e = s + duration_min * 60000;
  const rows = ctx.db.all(`SELECT j.id, j.title, j.start_at, j.duration_min, c.name AS client_name FROM jobs j JOIN clients c ON c.id = j.client_id
    WHERE j.company_id = ? AND j.crew_id = ? AND j.status IN ('scheduled','in_progress') AND j.start_at >= ? AND j.start_at < ?`,
  C(ctx), crew_id, new Date(s - 86400000).toISOString(), new Date(e).toISOString());
  return enrich(ctx, rows.filter((r) => !exclude_ids.includes(r.id) && Date.parse(r.start_at) < e && endOf(r) > s));
}

function occurrenceDate(series, idx) {
  if (series.frequency === 'weekly') return TZ.addDays(series.anchor_date, 7 * idx);
  if (series.frequency === 'biweekly') return TZ.addDays(series.anchor_date, 14 * idx);
  return TZ.addMonthsClamped(series.anchor_date, idx, Number(series.anchor_date.slice(8, 10)));
}

// Mantém um número fixo de visitas futuras geradas para cada recorrência ativa.
function topUpSeries(ctx, seriesId) {
  const s = one(ctx, 'job_series', seriesId);
  if (!s.active) return [];
  const tz = ctx.company.timezone;
  const future = ctx.db.get(`SELECT COUNT(*) AS n FROM jobs WHERE company_id = ? AND series_id = ? AND status = 'scheduled' AND start_at > ?`, C(ctx), s.id, now()).n;
  let maxIdx = ctx.db.get('SELECT MAX(occurrence_index) AS m FROM jobs WHERE company_id = ? AND series_id = ?', C(ctx), s.id).m ?? -1;
  const created = [];
  for (let k = future; k < HORIZON; k++) {
    maxIdx++;
    const date = occurrenceDate(s, maxIdx);
    const start_at = TZ.toUtc(date, s.time_local, tz);
    const template = ctx.db.get('SELECT * FROM jobs WHERE company_id = ? AND series_id = ? ORDER BY occurrence_index DESC', C(ctx), s.id);
    const id = ctx.db.insert('jobs', {
      company_id: C(ctx), client_id: s.client_id, address_id: s.address_id, quote_id: s.quote_id, opportunity_id: template?.opportunity_id,
      series_id: s.id, occurrence_index: maxIdx, title: s.title, status: 'scheduled', requested_frequency: s.frequency, start_at,
      duration_min: s.duration_min, crew_id: s.crew_id, price: s.price, instructions: s.instructions,
      checklist: parse(s.checklist, []).map((c) => ({ text: c.text, done: false })), schedule_version: 1, created_by: ctx.user?.id, created_at: now(), updated_at: now(),
    });
    engine.emit(ctx, 'job.scheduled', { entity_type: 'job', entity_id: id, client_id: s.client_id });
    created.push(id);
  }
  return created;
}

// Agenda ou reagenda. Nunca escolhe data automaticamente: data, horário e equipe vêm do usuário.
function scheduleJob(ctx, id, data) {
  return ctx.db.tx(() => {
    const job = one(ctx, 'jobs', id, 'Serviço');
    if (!['pending_schedule', 'scheduled'].includes(job.status)) throw bad(`Serviço ${STATUS_LABEL[job.status].toLowerCase()} não pode ser agendado.`);
    const tz = ctx.company.timezone;
    const date = v.date(data.date, 'Data');
    const time = v.time(data.time, 'Horário');
    const duration = v.num(data.duration_min ?? job.duration_min, 'Duração (minutos)', { min: 30, max: 720 });
    const crew = data.crew_id ? one(ctx, 'crews', data.crew_id, 'Equipe') : null;
    if (!crew) throw bad('Atribua uma equipe ao serviço.');
    const start_at = TZ.toUtc(date, time, tz);
    if (Date.parse(start_at) < clock.now() - 3600000 && !data.allow_past) throw bad('A data e o horário escolhidos já passaram.');
    const scope = data.scope === 'following' ? 'following' : 'one';
    const conflicts = findConflicts(ctx, { crew_id: crew.id, start_at, duration_min: duration, exclude_ids: [job.id] });
    if (conflicts.length && !data.force) throw new HttpError(409, 'Conflito de horário com outro serviço da mesma equipe.', { conflicts });
    const user = ctx.user;
    const crewLabel = crew.name;
    const clientName = one(ctx, 'clients', job.client_id).name;

    if (job.status === 'pending_schedule') {
      const frequency = v.oneOf(data.frequency || 'one_time', ['one_time', 'weekly', 'biweekly', 'monthly'], 'Frequência');
      let seriesId = null;
      if (frequency !== 'one_time') {
        seriesId = ctx.db.insert('job_series', {
          company_id: C(ctx), client_id: job.client_id, address_id: job.address_id, quote_id: job.quote_id, frequency, anchor_date: date, time_local: time,
          duration_min: duration, crew_id: crew.id, price: job.price, title: job.title, instructions: job.instructions, checklist: job.checklist, active: 1, created_at: now(),
        });
      }
      ctx.db.update('jobs', job.id, C(ctx), { status: 'scheduled', start_at, duration_min: duration, crew_id: crew.id, series_id: seriesId, occurrence_index: seriesId ? 0 : null, requested_frequency: frequency, schedule_version: 1, updated_at: now() });
      audit(ctx, 'job', job.id, `Agendado para ${engine.usDate(TZ.localDate(start_at, tz))} ${engine.usTime(start_at, tz)} - ${crewLabel}${seriesId ? ` (recorrência ${FREQ_LABEL[frequency].toLowerCase()})` : ''}`, { from: 'pending_schedule', to: 'scheduled', client_id: job.client_id, details: conflicts.length ? 'Agendado apesar de conflito de horário (confirmado pelo usuário)' : null });
      engine.emit(ctx, 'job.scheduled', { entity_type: 'job', entity_id: job.id, client_id: job.client_id });
      if (seriesId) topUpSeries(ctx, seriesId);
      ctx.db.run(`UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ? WHERE company_id = ? AND job_id = ? AND type = 'scheduling' AND status IN ('open','in_progress')`, now(), user.id, C(ctx), job.id);
      const usDate = engine.usDate(date);
      crm.setNextAction(ctx, job.client_id, `Acompanhar a execução do serviço de ${usDate}`, date, user.id);
      return { job_id: job.id, series_id: seriesId, conflicts };
    }

    // Reagendamento
    const changed = [];
    if (scope === 'following' && job.series_id) {
      const s = one(ctx, 'job_series', job.series_id);
      const oldDate = TZ.localDate(job.start_at, tz);
      const delta = TZ.diffDays(oldDate, date);
      const newAnchor = s.frequency === 'monthly' && delta !== 0
        ? TZ.addMonthsClamped(date, -job.occurrence_index, Number(date.slice(8, 10))) : TZ.addDays(s.anchor_date, delta);
      ctx.db.update('job_series', s.id, C(ctx), { anchor_date: newAnchor, time_local: time, duration_min: duration, crew_id: crew.id });
      const s2 = one(ctx, 'job_series', s.id);
      const following = ctx.db.all(`SELECT * FROM jobs WHERE company_id = ? AND series_id = ? AND occurrence_index >= ? AND status = 'scheduled' ORDER BY occurrence_index`, C(ctx), s.id, job.occurrence_index);
      following.forEach((f, i) => {
        const st = TZ.toUtc(occurrenceDate(s2, f.occurrence_index), time, tz);
        ctx.db.update('jobs', f.id, C(ctx), { start_at: st, duration_min: duration, crew_id: crew.id, detached: 0, schedule_version: f.schedule_version + 1, updated_at: now() });
        audit(ctx, 'job', f.id, `Reagendado (esta e as próximas) para ${engine.usDate(TZ.localDate(st, tz))} ${engine.usTime(st, tz)} - ${crewLabel}`, { client_id: job.client_id });
        engine.emit(ctx, 'job.rescheduled', { entity_type: 'job', entity_id: f.id, client_id: job.client_id, key: `job.rescheduled:${f.id}:v${f.schedule_version + 1}`, payload: { bulk: i > 0 } });
        changed.push(f.id);
      });
    } else {
      ctx.db.update('jobs', job.id, C(ctx), { start_at, duration_min: duration, crew_id: crew.id, detached: job.series_id ? 1 : 0, schedule_version: job.schedule_version + 1, updated_at: now() });
      audit(ctx, 'job', job.id, `Reagendado${job.series_id ? ' (somente esta visita)' : ''} para ${engine.usDate(TZ.localDate(start_at, tz))} ${engine.usTime(start_at, tz)} - ${crewLabel}`, { client_id: job.client_id, details: conflicts.length ? 'Reagendado apesar de conflito (confirmado pelo usuário)' : null });
      engine.emit(ctx, 'job.rescheduled', { entity_type: 'job', entity_id: job.id, client_id: job.client_id, key: `job.rescheduled:${job.id}:v${job.schedule_version + 1}` });
      changed.push(job.id);
    }
    void clientName;
    return { job_id: job.id, changed, conflicts };
  });
}

function updateJob(ctx, id, data) {
  const job = one(ctx, 'jobs', id, 'Serviço');
  const patch = { updated_at: now() };
  if ('title' in data) patch.title = v.str(data.title, 'Título', { required: true, max: 120 });
  if ('instructions' in data) patch.instructions = v.str(data.instructions, 'Instruções', { max: 2000 });
  if ('checklist' in data) {
    if (!Array.isArray(data.checklist)) throw bad('Checklist inválido.');
    patch.checklist = data.checklist.map((c) => ({ text: v.str(c.text, 'Item do checklist', { required: true, max: 160 }), done: !!c.done }));
  }
  if ('price' in data) {
    if (!ctx.perms.finance) throw new HttpError(403, 'Sem permissão para alterar valores.');
    if (job.status === 'completed' && ctx.db.get(`SELECT id FROM invoices WHERE company_id = ? AND job_id = ? AND kind = 'final' AND status <> 'void'`, C(ctx), job.id)) throw bad('Este serviço já foi cobrado. Anule a cobrança antes de alterar o valor.');
    patch.price = v.cents(data.price, 'Valor contratado');
  }
  if ('duration_min' in data && job.status === 'pending_schedule') patch.duration_min = v.num(data.duration_min, 'Duração', { min: 30, max: 720 });
  if ('address_id' in data) { const a = one(ctx, 'addresses', data.address_id, 'Endereço'); if (a.client_id !== job.client_id) throw bad('Endereço de outro cliente.'); patch.address_id = a.id; }
  ctx.db.update('jobs', job.id, C(ctx), patch);
  if (data.scope === 'following' && job.series_id) {
    const sp = {};
    for (const k of ['title', 'instructions', 'checklist', 'price']) if (k in patch) sp[k] = patch[k];
    if (Object.keys(sp).length) {
      ctx.db.update('job_series', job.series_id, C(ctx), sp);
      const rest = { ...sp }; if (rest.checklist) rest.checklist = rest.checklist.map((c) => ({ ...c, done: false }));
      for (const f of ctx.db.all(`SELECT id FROM jobs WHERE company_id = ? AND series_id = ? AND occurrence_index > ? AND status = 'scheduled'`, C(ctx), job.series_id, job.occurrence_index)) ctx.db.update('jobs', f.id, C(ctx), rest);
    }
  }
  const what = Object.keys(patch).filter((k) => k !== 'updated_at').map((k) => ({ title: 'título', instructions: 'instruções', checklist: 'checklist', price: 'valor', duration_min: 'duração', address_id: 'endereço' }[k])).join(', ');
  audit(ctx, 'job', job.id, `Serviço atualizado: ${what}${data.scope === 'following' && job.series_id ? ' (esta e as próximas)' : ''}`, { client_id: job.client_id, details: 'price' in patch ? engine.usd(patch.price) : null });
  return job.id;
}

function toggleChecklist(ctx, id, index, done) {
  const job = one(ctx, 'jobs', id, 'Serviço');
  assertFieldAccess(ctx, job);
  if (['completed', 'canceled'].includes(job.status)) throw bad('Serviço encerrado: o checklist não pode ser alterado.');
  const list = parse(job.checklist, []);
  if (!list[index]) throw bad('Item do checklist não encontrado.');
  list[index].done = !!done;
  ctx.db.update('jobs', job.id, C(ctx), { checklist: list, updated_at: now() });
  return list;
}

function jobAction(ctx, id, action, data = {}) {
  return ctx.db.tx(() => {
    const job = one(ctx, 'jobs', id, 'Serviço');
    assertFieldAccess(ctx, job);
    const tz = ctx.company.timezone;
    if (action === 'on_the_way') {
      if (job.status !== 'scheduled') throw bad('Só é possível avisar "a caminho" em serviços agendados.');
      if (job.on_the_way_at) return { already: true };
      ctx.db.update('jobs', job.id, C(ctx), { on_the_way_at: now(), updated_at: now() });
      audit(ctx, 'job', job.id, 'Equipe a caminho (aviso ao cliente em simulação)', { client_id: job.client_id });
      engine.emit(ctx, 'job.on_the_way', { entity_type: 'job', entity_id: job.id, client_id: job.client_id });
      return { ok: true };
    }
    if (action === 'start') {
      if (job.status !== 'scheduled') throw bad('Só é possível iniciar serviços agendados.');
      ctx.db.update('jobs', job.id, C(ctx), { status: 'in_progress', started_at: now(), updated_at: now() });
      audit(ctx, 'job', job.id, 'Serviço iniciado', { from: 'scheduled', to: 'in_progress', client_id: job.client_id });
      return { ok: true };
    }
    if (action === 'complete') {
      if (!['scheduled', 'in_progress'].includes(job.status)) throw bad('Só é possível concluir serviços agendados ou em andamento.');
      if (Date.parse(job.start_at) > clock.now() + 12 * 3600000) throw bad('Este serviço está agendado para uma data futura. Reagende antes de concluir.');
      const pendingItems = parse(job.checklist, []).filter((c) => !c.done).length;
      const hours = ctx.db.get('SELECT COUNT(*) AS n FROM time_entries WHERE company_id = ? AND job_id = ?', C(ctx), job.id).n;
      const warnings = [];
      if (pendingItems) warnings.push(`${pendingItems} item(ns) do checklist sem marcar`);
      if (!hours) warnings.push('nenhuma hora registrada (o resultado do serviço ficará incompleto)');
      if (warnings.length && !data.confirm) throw new HttpError(409, 'Confirme a conclusão: ' + warnings.join('; ') + '.', { warnings, needs_confirm: true });
      ctx.db.update('jobs', job.id, C(ctx), { status: 'completed', completed_at: now(), started_at: job.started_at || now(), updated_at: now() });
      audit(ctx, 'job', job.id, 'Serviço concluído', { from: job.status, to: 'completed', client_id: job.client_id, details: warnings.length ? 'Concluído com pendências: ' + warnings.join('; ') : null });
      engine.emit(ctx, 'job.completed', { entity_type: 'job', entity_id: job.id, client_id: job.client_id });
      if (job.series_id) topUpSeries(ctx, job.series_id);
      const ownerId = ctx.db.get(`SELECT id FROM users WHERE company_id = ? AND role = 'owner' ORDER BY id`, C(ctx)).id;
      const finalExists = ctx.db.get(`SELECT id FROM invoices WHERE company_id = ? AND job_id = ? AND kind = 'final' AND status <> 'void'`, C(ctx), job.id);
      if (!finalExists) crm.setNextAction(ctx, job.client_id, `Gerar a cobrança do serviço de ${engine.usDate(TZ.localDate(job.start_at, tz))}`, today(ctx), ownerId);
      return { ok: true };
    }
    if (action === 'cancel') {
      if (!['pending_schedule', 'scheduled'].includes(job.status)) throw bad('Só é possível cancelar serviços ainda não iniciados.');
      if (ctx.user.role === 'field') throw new HttpError(403, 'A equipe de campo não pode cancelar serviços.');
      const reason = v.str(data.reason, 'Motivo do cancelamento', { required: true, max: 200 });
      const targets = data.scope === 'following' && job.series_id
        ? ctx.db.all(`SELECT * FROM jobs WHERE company_id = ? AND series_id = ? AND occurrence_index >= ? AND status = 'scheduled'`, C(ctx), job.series_id, job.occurrence_index)
        : [job];
      if (data.scope === 'following' && job.series_id) ctx.db.update('job_series', job.series_id, C(ctx), { active: 0 });
      for (const t of targets) {
        ctx.db.update('jobs', t.id, C(ctx), { status: 'canceled', canceled_at: now(), cancel_reason: reason, updated_at: now() });
        audit(ctx, 'job', t.id, `Serviço cancelado${targets.length > 1 ? ' (esta e as próximas; recorrência encerrada)' : ''}`, { from: t.status, to: 'canceled', client_id: t.client_id, details: reason });
        engine.emit(ctx, 'job.canceled', { entity_type: 'job', entity_id: t.id, client_id: t.client_id });
      }
      ctx.db.run(`UPDATE tasks SET status = 'canceled', completed_at = ? WHERE company_id = ? AND job_id = ? AND type = 'scheduling' AND status IN ('open','in_progress')`, now(), C(ctx), job.id);
      const openInv = ctx.db.get(`SELECT number FROM invoices WHERE company_id = ? AND job_id = ? AND status IN ('open','partial')`, C(ctx), job.id);
      return { canceled: targets.length, warning: openInv ? `A cobrança ${openInv.number} continua em aberto. Revise se deve ser anulada ou mantida.` : null };
    }
    throw bad('Ação inválida.');
  });
}

function addTime(ctx, id, data) {
  const job = one(ctx, 'jobs', id, 'Serviço');
  assertFieldAccess(ctx, job);
  if (!['in_progress', 'completed', 'scheduled'].includes(job.status)) throw bad('Registre horas apenas em serviços agendados, em andamento ou concluídos.');
  const hours = v.num(data.hours, 'Horas', { min: 0.25, max: 24 });
  const people = data.user_id ? [one(ctx, 'users', data.user_id, 'Pessoa')] : [ctx.user];
  const u = people[0];
  if (ctx.user.role === 'field' && u.id !== ctx.user.id && u.crew_id !== ctx.user.crew_id) throw new HttpError(403, 'Registre horas apenas para você ou sua equipe.');
  const cost = Math.round(hours * u.hourly_cost);
  ctx.db.insert('time_entries', { company_id: C(ctx), job_id: job.id, user_id: u.id, hours, cost, cost_missing: u.hourly_cost ? 0 : 1, note: v.str(data.note, 'Observação', { max: 200 }), created_by: ctx.user.id, created_at: now() });
  audit(ctx, 'job', job.id, `Horas registradas: ${hours}h (${u.name})`, { client_id: job.client_id, details: u.hourly_cost ? null : 'Custo/hora não configurado para esta pessoa' });
  return { ok: true };
}

function addJobCost(ctx, id, data) {
  const job = one(ctx, 'jobs', id, 'Serviço');
  assertFieldAccess(ctx, job);
  const fin = require('./svc-fin');
  const expId = fin.createExpense(ctx, { ...data, job_id: job.id }, { fromJob: true });
  audit(ctx, 'job', job.id, `Custo direto registrado: ${data.description}`, { client_id: job.client_id, details: engine.usd(Number(data.amount)) });
  return expId;
}

function setCostsComplete(ctx, id, complete) {
  const job = one(ctx, 'jobs', id, 'Serviço');
  ctx.db.update('jobs', job.id, C(ctx), { costs_complete: complete ? 1 : 0, updated_at: now() });
  audit(ctx, 'job', job.id, complete ? 'Custos confirmados como completos' : 'Custos marcados como incompletos', { client_id: job.client_id });
}

function createJob(ctx, data) {
  const client = one(ctx, 'clients', data.client_id, 'Cliente');
  const title = v.str(data.title, 'Serviço', { required: true, max: 120 });
  const price = v.cents(data.price, 'Valor contratado');
  let address_id = null;
  if (data.address_id) { const a = one(ctx, 'addresses', data.address_id, 'Endereço'); if (a.client_id !== client.id) throw bad('Endereço de outro cliente.'); address_id = a.id; }
  else { const a = ctx.db.get('SELECT id FROM addresses WHERE company_id = ? AND client_id = ? ORDER BY id', C(ctx), client.id); address_id = a?.id || null; }
  const id = ctx.db.insert('jobs', {
    company_id: C(ctx), client_id: client.id, address_id, title, status: 'pending_schedule', duration_min: 180, price,
    instructions: v.str(data.instructions, 'Instruções', { max: 2000 }), checklist: crm.DEFAULT_CHECKLIST(title), created_by: ctx.user.id, created_at: now(), updated_at: now(),
  });
  audit(ctx, 'job', id, 'Serviço criado manualmente (sem orçamento)', { to: 'pending_schedule', client_id: client.id, details: engine.usd(price) });
  return id;
}

module.exports = { STATUS_LABEL, FREQ_LABEL, listJobs, getJob, findConflicts, scheduleJob, updateJob, toggleChecklist, jobAction, addTime, addJobCost, setCostsComplete, createJob, jobCosts, directResult, topUpSeries };
