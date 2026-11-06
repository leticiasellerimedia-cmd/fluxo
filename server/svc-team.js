// Gestão de time: perfil, acompanhamento mensal pelo método configurado, PDI,
// indicadores automáticos (vindos da operação) e premiações monetárias.
// Acesso exclusivo do dono, aplicado no servidor pela permissão 'team'.
const { HttpError, bad, clock, today, parse, v, audit, one, TZ } = require('./util');
const engine = require('./engine');
const METHOD = require('./team-method');

const C = (ctx) => ctx.company.id;
const now = () => clock.iso();
const DIMS = METHOD.dimensions.map((d) => d.key);
const PDI_STATUS = ['not_started', 'in_progress', 'done', 'canceled'];

const METRICS = {
  avg_rating_gte: { label: 'Nota média dos clientes da equipe maior ou igual a', applies: 'field', unit: 'nota', needsThreshold: true },
  zero_complaints: { label: 'Nenhuma reclamação atribuída à equipe no mês', applies: 'field' },
  checklist_pct_gte: { label: 'Itens do checklist concluídos (%) maior ou igual a', applies: 'field', unit: '%', needsThreshold: true },
  hours_gte: { label: 'Horas trabalhadas no mês maior ou igual a', applies: 'field', unit: 'h', needsThreshold: true },
  tasks_on_time_pct_gte: { label: 'Tarefas concluídas no prazo (%) maior ou igual a', applies: 'assistant', unit: '%', needsThreshold: true },
  quotes_approved_gte: { label: 'Orçamentos aprovados no mês maior ou igual a', applies: 'assistant', needsThreshold: true },
  pdi_goal_done: { label: 'Concluiu pelo menos uma meta do PDI no mês', applies: 'all' },
};

function validMonth(m) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m || '')) throw bad('Mês inválido.'); return m; }
function monthOf(ctx, m) { return m ? validMonth(m) : today(ctx).slice(0, 7); }
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function monthLabel(m) { return `${MONTHS[Number(m.slice(5, 7)) - 1]} de ${m.slice(0, 4)}`; }
function prevMonth(m) { return TZ.addMonthsClamped(m + '-01', -1, 1).slice(0, 7); }
function range(ctx, m) {
  const first = m + '-01'; const next = TZ.addMonthsClamped(first, 1, 1);
  return { first, next, utc: [TZ.toUtc(first, '00:00', ctx.company.timezone), TZ.toUtc(next, '00:00', ctx.company.timezone)] };
}

function members(ctx) {
  return ctx.db.all(`SELECT u.id, u.name, u.email, u.role, u.crew_id, u.hourly_cost, cr.name AS crew_name, cr.color AS crew_color
    FROM users u LEFT JOIN crews cr ON cr.id = u.crew_id WHERE u.company_id = ? AND u.active = 1 AND u.role <> 'owner' ORDER BY u.role DESC, u.name`, C(ctx));
}
function member(ctx, id) {
  const m = members(ctx).find((x) => x.id === Number(id));
  if (!m) throw new HttpError(404, 'Pessoa do time não encontrada.');
  return m;
}

// Atribui uma avaliação ou reclamação à equipe do último serviço concluído do cliente antes dela.
function crewFor(ctx, clientId, atIso, jobId = null) {
  if (jobId) { const j = ctx.db.get('SELECT crew_id FROM jobs WHERE id = ? AND company_id = ?', jobId, C(ctx)); if (j) return j.crew_id; }
  const j = ctx.db.get(`SELECT crew_id FROM jobs WHERE company_id = ? AND client_id = ? AND status = 'completed' AND completed_at <= ? ORDER BY completed_at DESC LIMIT 1`, C(ctx), clientId, atIso);
  return j ? j.crew_id : null;
}

function metrics(ctx, m, month) {
  const r = range(ctx, month);
  const cid = C(ctx);
  const out = { month, kind: m.role, partial: month === today(ctx).slice(0, 7) };
  out.pdi_completed = ctx.db.get(`SELECT COUNT(*) AS n FROM pdi_goals WHERE company_id = ? AND user_id = ? AND status = 'done' AND completed_at >= ? AND completed_at < ?`, cid, m.id, ...r.utc).n;
  if (m.role === 'field') {
    const te = ctx.db.get(`SELECT COALESCE(SUM(t.hours),0) AS h, COUNT(DISTINCT t.job_id) AS jobs FROM time_entries t JOIN jobs j ON j.id = t.job_id
      WHERE t.company_id = ? AND t.user_id = ? AND j.start_at >= ? AND j.start_at < ?`, cid, m.id, ...r.utc);
    out.hours = te.h; out.jobs_worked = te.jobs;
    const crewJobs = m.crew_id ? ctx.db.all(`SELECT checklist FROM jobs WHERE company_id = ? AND crew_id = ? AND status = 'completed' AND start_at >= ? AND start_at < ?`, cid, m.crew_id, ...r.utc) : [];
    out.crew_jobs = crewJobs.length;
    let items = 0; let done = 0;
    for (const j of crewJobs) for (const c of parse(j.checklist, [])) { items++; if (c.done) done++; }
    out.checklist_pct = items ? Math.round((done / items) * 100) : null;
    const ratings = ctx.db.all(`SELECT client_id, subject, created_at FROM communications WHERE company_id = ? AND kind = 'inbound_rating' AND created_at >= ? AND created_at < ?`, cid, ...r.utc)
      .map((x) => ({ n: Number(String(x.subject || '').replace(/\D/g, '')), crew: crewFor(ctx, x.client_id, x.created_at) }))
      .filter((x) => x.n >= 1 && x.n <= 5 && m.crew_id && x.crew === m.crew_id);
    out.ratings_count = ratings.length;
    out.avg_rating = ratings.length ? Math.round((ratings.reduce((s, x) => s + x.n, 0) / ratings.length) * 10) / 10 : null;
    out.complaints = ctx.db.all(`SELECT client_id, job_id, created_at FROM tasks WHERE company_id = ? AND type = 'complaint' AND created_at >= ? AND created_at < ?`, cid, ...r.utc)
      .filter((tk) => m.crew_id && crewFor(ctx, tk.client_id, tk.created_at, tk.job_id) === m.crew_id).length;
  } else {
    const done = ctx.db.all(`SELECT due_date, completed_at FROM tasks WHERE company_id = ? AND assignee_id = ? AND status = 'done' AND completed_at >= ? AND completed_at < ?`, cid, m.id, ...r.utc);
    out.tasks_done = done.length;
    out.tasks_on_time_pct = done.length ? Math.round((done.filter((tk) => TZ.localDate(tk.completed_at, ctx.company.timezone) <= tk.due_date).length / done.length) * 100) : null;
    out.overdue_open = ctx.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE company_id = ? AND assignee_id = ? AND status IN ('open','in_progress') AND due_date < ?`, cid, m.id, today(ctx)).n;
    const q = ctx.db.all(`SELECT status FROM quotes WHERE company_id = ? AND created_by = ? AND sent_at >= ? AND sent_at < ?`, cid, m.id, ...r.utc);
    out.quotes_sent = q.length;
    out.quotes_approved = q.filter((x) => x.status === 'approved').length;
  }
  return out;
}

// Avalia uma regra: true (atingiu), false (não atingiu) ou null (dados insuficientes para afirmar).
function evaluate(rule, mt) {
  const t = rule.threshold;
  switch (rule.metric) {
    case 'avg_rating_gte': return mt.ratings_count ? { ok: mt.avg_rating >= t, value: `nota ${mt.avg_rating} (${mt.ratings_count} avaliação(ões))` } : { ok: null, value: 'nenhuma avaliação de cliente no mês' };
    case 'zero_complaints': return mt.crew_jobs ? { ok: mt.complaints === 0, value: `${mt.complaints} reclamação(ões) em ${mt.crew_jobs} serviço(s)` } : { ok: null, value: 'nenhum serviço concluído pela equipe' };
    case 'checklist_pct_gte': return mt.checklist_pct == null ? { ok: null, value: 'sem checklists no mês' } : { ok: mt.checklist_pct >= t, value: `${mt.checklist_pct}% dos itens` };
    case 'hours_gte': return { ok: mt.hours >= t, value: `${mt.hours}h` };
    case 'tasks_on_time_pct_gte': return mt.tasks_done ? { ok: mt.tasks_on_time_pct >= t, value: `${mt.tasks_on_time_pct}% de ${mt.tasks_done} tarefa(s)` } : { ok: null, value: 'nenhuma tarefa concluída no mês' };
    case 'quotes_approved_gte': return { ok: mt.quotes_approved >= t, value: `${mt.quotes_approved} aprovado(s) de ${mt.quotes_sent} enviado(s)` };
    case 'pdi_goal_done': return { ok: mt.pdi_completed > 0, value: `${mt.pdi_completed} meta(s) concluída(s)` };
    default: return { ok: null, value: 'regra desconhecida' };
  }
}

function rulesFor(ctx, m) {
  return ctx.db.all('SELECT * FROM bonus_rules WHERE company_id = ? AND active = 1 ORDER BY id', C(ctx)).filter((r) => r.applies_to === 'all' || r.applies_to === m.role);
}
const ruleKey = (ruleId, userId, month) => `rule:${ruleId}:user:${userId}:${month}`;

function suggestions(ctx, m, month, mt) {
  return rulesFor(ctx, m).map((rule) => {
    const ev = evaluate(rule, mt);
    const existing = ctx.db.get('SELECT id, status FROM bonuses WHERE company_id = ? AND source_key = ?', C(ctx), ruleKey(rule.id, m.id, month));
    return { rule_id: rule.id, name: rule.name, amount: rule.amount, ok: ev.ok, value: ev.value, bonus_id: existing?.id || null, bonus_status: existing?.status || null };
  });
}

const avg = (scores) => { if (!scores) return null; const vals = DIMS.map((k) => scores[k]).filter((x) => x); return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null; };
function reviewOut(r) { if (!r) return null; const ms = parse(r.manager_scores, {}); const ss = parse(r.self_scores, null); return { ...r, manager_scores: ms, self_scores: ss, notes: parse(r.notes, {}), avg: avg(ms), self_avg: avg(ss) }; }

function flags(ctx, m, month, review, prev, pdi, latest = null) {
  const out = [];
  const t = today(ctx);
  const isCurrent = month === t.slice(0, 7);
  if (!review && (!isCurrent || Number(t.slice(8, 10)) >= 20)) out.push({ tone: 'warn', text: 'Acompanhamento do mês pendente' });
  // Sem acompanhamento no mês, os alertas usam o último registrado (e dizem de quando é).
  const base = review || latest;
  if (base) {
    const when = review ? '' : ` (último acompanhamento: ${monthLabel(base.month)})`;
    const low = METHOD.dimensions.filter((d) => base.manager_scores[d.key] <= 2);
    if (low.length) out.push({ tone: 'danger', text: `Dimensão crítica: ${low.map((d) => d.label).join(', ')}${when}` });
    if (review && prev && review.avg != null && prev.avg != null && review.avg - prev.avg <= -0.8) out.push({ tone: 'danger', text: `Queda no engajamento (${prev.avg} → ${review.avg})` });
    if (base.self_scores) {
      const gaps = METHOD.dimensions.filter((d) => base.self_scores[d.key] && Math.abs(base.self_scores[d.key] - base.manager_scores[d.key]) >= 2);
      if (gaps.length) out.push({ tone: 'warn', text: `Percepções divergentes: ${gaps.map((d) => d.label).join(', ')}${when}` });
    }
  }
  const late = pdi.filter((g) => ['not_started', 'in_progress'].includes(g.status) && g.due_date < t).length;
  if (late) out.push({ tone: 'warn', text: `${late} meta(s) do PDI atrasada(s)` });
  if (!pdi.some((g) => ['not_started', 'in_progress'].includes(g.status))) out.push({ tone: '', text: 'Sem PDI ativo' });
  return out;
}

function overview(ctx, { month } = {}) {
  const mo = monthOf(ctx, month);
  const pm = prevMonth(mo);
  const list = members(ctx).map((m) => {
    const review = reviewOut(ctx.db.get('SELECT * FROM team_reviews WHERE company_id = ? AND user_id = ? AND month = ?', C(ctx), m.id, mo));
    const prev = reviewOut(ctx.db.get('SELECT * FROM team_reviews WHERE company_id = ? AND user_id = ? AND month = ?', C(ctx), m.id, pm));
    const latest = review ? null : reviewOut(ctx.db.get('SELECT * FROM team_reviews WHERE company_id = ? AND user_id = ? AND month < ? ORDER BY month DESC LIMIT 1', C(ctx), m.id, mo));
    const pdi = ctx.db.all('SELECT * FROM pdi_goals WHERE company_id = ? AND user_id = ?', C(ctx), m.id);
    const mt = metrics(ctx, m, mo);
    const sug = suggestions(ctx, m, mo, mt);
    const bonuses = ctx.db.all(`SELECT * FROM bonuses WHERE company_id = ? AND user_id = ? AND month = ? AND status <> 'canceled'`, C(ctx), m.id, mo);
    const profile = ctx.db.get('SELECT position FROM team_profiles WHERE company_id = ? AND user_id = ?', C(ctx), m.id);
    let weakest = null;
    const base = review || latest;
    if (base) { const w = METHOD.dimensions.reduce((a, d) => (base.manager_scores[d.key] < base.manager_scores[a.key] ? d : a)); weakest = w.label; }
    return {
      ...m, position: profile?.position || null, review, latest, prev_avg: prev?.avg ?? null, weakest, metrics: mt,
      pdi_active: pdi.filter((g) => ['not_started', 'in_progress'].includes(g.status)).length,
      bonus_total: bonuses.reduce((s, b) => s + b.amount, 0), eligible_pending: sug.filter((s) => s.ok === true && !s.bonus_id).length,
      flags: flags(ctx, m, mo, review, prev, pdi, latest),
    };
  });
  return { month: mo, method: METHOD, members: list };
}

function memberDetail(ctx, id, { month } = {}) {
  const m = member(ctx, id);
  const mo = monthOf(ctx, month);
  const reviews = ctx.db.all('SELECT * FROM team_reviews WHERE company_id = ? AND user_id = ? ORDER BY month DESC', C(ctx), m.id).map(reviewOut);
  const review = reviews.find((r) => r.month === mo) || null;
  const prev = reviews.find((r) => r.month < mo) || null;
  const pdi = ctx.db.all(`SELECT * FROM pdi_goals WHERE company_id = ? AND user_id = ? ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'not_started' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, due_date`, C(ctx), m.id);
  const mt = metrics(ctx, m, mo);
  return {
    member: m, month: mo, method: METHOD, metric_catalog: METRICS,
    profile: ctx.db.get('SELECT * FROM team_profiles WHERE company_id = ? AND user_id = ?', C(ctx), m.id) || {},
    review, prev_review: prev, reviews, pdi,
    metrics: mt, prev_metrics: metrics(ctx, m, prevMonth(mo)),
    suggestions: suggestions(ctx, m, mo, mt),
    bonuses: ctx.db.all('SELECT b.*, r.name AS rule_name FROM bonuses b LEFT JOIN bonus_rules r ON r.id = b.rule_id WHERE b.company_id = ? AND b.user_id = ? ORDER BY b.month DESC, b.id DESC', C(ctx), m.id),
    flags: flags(ctx, m, mo, review, prev, pdi, review ? null : prev),
  };
}

function teamReport(ctx, { month } = {}) {
  const ov = overview(ctx, { month });
  const people = ov.members.map((m) => memberDetail(ctx, m.id, { month: ov.month }));
  const paid = ctx.db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM bonuses WHERE company_id = ? AND month = ? AND status = 'paid'`, C(ctx), ov.month).s;
  const approved = ctx.db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM bonuses WHERE company_id = ? AND month = ? AND status = 'approved'`, C(ctx), ov.month).s;
  const reviewed = ov.members.filter((m) => m.review);
  const dimAvg = Object.fromEntries(DIMS.map((k) => {
    const vals = reviewed.map((m) => m.review.manager_scores[k]).filter(Boolean);
    return [k, vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null];
  }));
  return { ...ov, people, totals: { bonuses_paid: paid, bonuses_approved: approved, reviewed: reviewed.length, members: ov.members.length, dim_avg: dimAvg }, generated_at: now(), company: ctx.company.name };
}

function scores(obj, label, { required }) {
  if (!obj || DIMS.every((k) => obj[k] === '' || obj[k] == null)) { if (required) throw bad(`Preencha as notas de ${label}.`); return null; }
  const out = {};
  for (const d of METHOD.dimensions) {
    const n = Number(obj[d.key]);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw bad(`${label}: dê uma nota de 1 a 5 para ${d.label}.`);
    out[d.key] = n;
  }
  return out;
}

function saveReview(ctx, data) {
  const m = member(ctx, data.user_id);
  const month = validMonth(data.month);
  if (month > today(ctx).slice(0, 7)) throw bad('Não é possível registrar acompanhamento de um mês futuro.');
  const row = {
    manager_scores: scores(data.manager_scores, 'avaliação do gestor', { required: true }),
    self_scores: scores(data.self_scores, 'visão do colaborador', { required: false }),
    notes: Object.fromEntries(DIMS.map((k) => [k, v.str((data.notes || {})[k], 'Observação', { max: 1000 })])),
    highlights: v.str(data.highlights, 'Destaques', { max: 2000 }),
    attention: v.str(data.attention, 'Pontos de atenção', { max: 2000 }),
    agreements: v.str(data.agreements, 'Combinados', { max: 2000 }),
    updated_at: now(),
  };
  const ex = ctx.db.get('SELECT id FROM team_reviews WHERE company_id = ? AND user_id = ? AND month = ?', C(ctx), m.id, month);
  if (ex) ctx.db.update('team_reviews', ex.id, C(ctx), row);
  else ctx.db.insert('team_reviews', { company_id: C(ctx), user_id: m.id, month, ...row, created_by: ctx.user.id, created_at: now() });
  audit(ctx, 'team_member', m.id, `Acompanhamento ${ex ? 'atualizado' : 'registrado'} (${month}) - ${m.name}`, { details: `média ${avg(row.manager_scores)}` });
  return { ok: true };
}

function saveProfile(ctx, id, data) {
  const m = member(ctx, id);
  const row = {
    position: v.str(data.position, 'Função', { max: 80 }),
    hire_date: data.hire_date ? v.date(data.hire_date, 'Data de admissão') : null,
    employment_type: data.employment_type ? v.oneOf(data.employment_type, ['w2', '1099', 'other'], 'Vínculo') : null,
    motivators: v.str(data.motivators, 'O que motiva', { max: 1000 }),
    career_goals: v.str(data.career_goals, 'Objetivos', { max: 1000 }),
    strengths: v.str(data.strengths, 'Pontos fortes', { max: 1000 }),
    notes: v.str(data.notes, 'Observações', { max: 2000 }),
    updated_at: now(),
  };
  const ex = ctx.db.get('SELECT id FROM team_profiles WHERE company_id = ? AND user_id = ?', C(ctx), m.id);
  if (ex) ctx.db.update('team_profiles', ex.id, C(ctx), row); else ctx.db.insert('team_profiles', { company_id: C(ctx), user_id: m.id, ...row });
  return { ok: true };
}

function createGoal(ctx, data) {
  const m = member(ctx, data.user_id);
  const id = ctx.db.insert('pdi_goals', {
    company_id: C(ctx), user_id: m.id, title: v.str(data.title, 'Objetivo', { required: true, max: 160 }),
    dimension: data.dimension ? v.oneOf(data.dimension, DIMS, 'Dimensão') : null,
    actions: v.str(data.actions, 'Ações', { max: 2000 }), success_criteria: v.str(data.success_criteria, 'Como saber que deu certo', { max: 500 }),
    due_date: v.date(data.due_date, 'Prazo'), status: 'not_started', created_by: ctx.user.id, created_at: now(), updated_at: now(),
  });
  audit(ctx, 'team_member', m.id, `Meta de PDI criada - ${m.name}`, { details: data.title });
  return id;
}

function updateGoal(ctx, id, data) {
  const g = one(ctx, 'pdi_goals', id, 'Meta');
  const patch = { updated_at: now() };
  if ('title' in data) patch.title = v.str(data.title, 'Objetivo', { required: true, max: 160 });
  if ('actions' in data) patch.actions = v.str(data.actions, 'Ações', { max: 2000 });
  if ('success_criteria' in data) patch.success_criteria = v.str(data.success_criteria, 'Como saber que deu certo', { max: 500 });
  if ('due_date' in data) patch.due_date = v.date(data.due_date, 'Prazo');
  if ('progress_note' in data) patch.progress_note = v.str(data.progress_note, 'Andamento', { max: 1000 });
  if ('status' in data) {
    patch.status = v.oneOf(data.status, PDI_STATUS, 'Status');
    patch.completed_at = patch.status === 'done' ? (g.completed_at || now()) : null;
  }
  ctx.db.update('pdi_goals', g.id, C(ctx), patch);
  if (patch.status && patch.status !== g.status) audit(ctx, 'team_member', g.user_id, `Meta de PDI "${g.title}": ${g.status} → ${patch.status}`, {});
  return g.id;
}

function createBonus(ctx, data) {
  return ctx.db.tx(() => {
    const m = member(ctx, data.user_id);
    const month = validMonth(data.month);
    if (data.rule_id) {
      const rule = one(ctx, 'bonus_rules', data.rule_id, 'Regra');
      if (!rulesFor(ctx, m).some((r) => r.id === rule.id)) throw bad('Esta regra não se aplica a esta pessoa.');
      const ev = evaluate(rule, metrics(ctx, m, month));
      if (ev.ok !== true) throw bad(`Critério não atingido: ${ev.value}.`);
      const key = ruleKey(rule.id, m.id, month);
      const ex = ctx.db.get('SELECT id FROM bonuses WHERE company_id = ? AND source_key = ?', C(ctx), key);
      if (ex) return { id: ex.id, duplicate: true };
      const id = ctx.db.insert('bonuses', { company_id: C(ctx), user_id: m.id, month, amount: rule.amount, reason: `${rule.name} (${ev.value})`, rule_id: rule.id, status: 'approved', source_key: key, created_by: ctx.user.id, created_at: now() });
      audit(ctx, 'team_member', m.id, `Premiação aprovada: ${engine.usd(rule.amount)} - ${m.name}`, { details: rule.name });
      return { id };
    }
    const amount = v.cents(data.amount, 'Valor', { min: 1 });
    const reason = v.str(data.reason, 'Motivo', { required: true, max: 300 });
    const id = ctx.db.insert('bonuses', { company_id: C(ctx), user_id: m.id, month, amount, reason, status: 'approved', source_key: `manual:${m.id}:${now()}`, created_by: ctx.user.id, created_at: now() });
    audit(ctx, 'team_member', m.id, `Premiação manual aprovada: ${engine.usd(amount)} - ${m.name}`, { details: reason });
    return { id };
  });
}

// Pagar uma premiação registra automaticamente a despesa no financeiro (uma única vez).
function payBonus(ctx, id, data) {
  return ctx.db.tx(() => {
    const b = one(ctx, 'bonuses', id, 'Premiação');
    if (b.status === 'paid') return { already: true };
    if (b.status !== 'approved') throw bad('Somente premiações aprovadas podem ser pagas.');
    const m = member(ctx, b.user_id);
    const date = v.date(data.paid_date || today(ctx), 'Data do pagamento');
    if (date > today(ctx)) throw bad('A data do pagamento não pode estar no futuro.');
    const expenseId = require('./svc-fin').createExpense(ctx, { description: `Premiação ${b.month}: ${m.name} - ${b.reason}`.slice(0, 200), category: 'Bônus e premiações', amount: b.amount, date });
    ctx.db.update('bonuses', b.id, C(ctx), { status: 'paid', paid_date: date, expense_id: expenseId });
    audit(ctx, 'team_member', m.id, `Premiação paga: ${engine.usd(b.amount)} - ${m.name}`, { details: 'Registrada como despesa no financeiro' });
    return { ok: true, expense_id: expenseId };
  });
}

function cancelBonus(ctx, id) {
  const b = one(ctx, 'bonuses', id, 'Premiação');
  if (b.status === 'paid') throw bad('Premiação já paga não pode ser cancelada. Ajuste no financeiro, se necessário.');
  ctx.db.update('bonuses', b.id, C(ctx), { status: 'canceled', source_key: `${b.source_key}:canceled:${b.id}` });
  audit(ctx, 'team_member', b.user_id, `Premiação cancelada: ${engine.usd(b.amount)}`, {});
  return { ok: true };
}

function listRules(ctx) { return { rules: ctx.db.all('SELECT * FROM bonus_rules WHERE company_id = ? ORDER BY id', C(ctx)), catalog: METRICS }; }
function saveRule(ctx, id, data) {
  const metric = v.oneOf(data.metric, Object.keys(METRICS), 'Critério');
  const def = METRICS[metric];
  const row = {
    name: v.str(data.name, 'Nome da regra', { required: true, max: 100 }), metric,
    applies_to: def.applies === 'all' ? v.oneOf(data.applies_to || 'all', ['field', 'assistant', 'all'], 'Para quem') : def.applies,
    threshold: def.needsThreshold ? v.num(data.threshold, 'Meta', { min: 0, max: 1000 }) : null,
    amount: v.cents(data.amount, 'Valor do prêmio', { min: 1 }), active: data.active === undefined ? 1 : (data.active ? 1 : 0),
  };
  if (metric === 'avg_rating_gte' && (row.threshold < 1 || row.threshold > 5)) throw bad('A nota média deve estar entre 1 e 5.');
  if (/pct/.test(metric) && row.threshold > 100) throw bad('O percentual deve ser no máximo 100.');
  if (id) { one(ctx, 'bonus_rules', id, 'Regra'); ctx.db.update('bonus_rules', Number(id), C(ctx), row); return Number(id); }
  return ctx.db.insert('bonus_rules', { company_id: C(ctx), ...row, created_at: now() });
}

module.exports = { METHOD, METRICS, overview, memberDetail, teamReport, saveReview, saveProfile, createGoal, updateGoal, createBonus, payBonus, cancelBonus, listRules, saveRule, metrics, members };
