// Dados de demonstração inteiramente fictícios.
// O histórico é gerado executando as próprias regras do sistema em uma linha do tempo
// simulada (relógio posicionado no passado), para que todos os registros sejam coerentes.
const path = require('path');
const { clock, hashPassword, permsFor, TZ } = require('./util');
const engine = require('./engine');
const crm = require('./svc-crm');
const ops = require('./svc-ops');
const fin = require('./svc-fin');
const team = require('./svc-team');
const DEFAULT_JOURNEYS = require('./journeys-default');

const TABLES = ['bonuses', 'bonus_rules', 'pdi_goals', 'team_reviews', 'team_profiles', 'journey_log', 'audit_log', 'events', 'communications', 'scheduled_messages', 'enrollments', 'journeys', 'payments', 'invoices', 'incomes', 'expenses',
  'time_entries', 'tasks', 'jobs', 'job_series', 'quote_items', 'quotes', 'opportunities', 'addresses', 'clients', 'sessions', 'users', 'crews', 'companies'];

function installJourneys(db, companyId) {
  const owner = db.get(`SELECT id FROM users WHERE company_id = ? AND role = 'owner'`, companyId);
  const assistant = db.get(`SELECT id FROM users WHERE company_id = ? AND role = 'assistant'`, companyId) || owner;
  for (const j of DEFAULT_JOURNEYS) {
    db.insert('journeys', {
      company_id: companyId, key: j.key, name: j.name, description: j.description, category: j.category, triggers: j.triggers,
      conditions: j.conditions, steps: j.steps, owner_id: j.owner_role === 'owner' ? owner.id : assistant.id, rules: j.rules, active: 1, updated_at: clock.iso(),
    });
  }
}

function seed(db) {
  const realNow = Date.now();
  clock.reset();
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of TABLES) db.exec(`DELETE FROM ${t}`);
  db.exec('PRAGMA foreign_keys = ON');
  const pw = hashPassword('demo123');
  const created = new Date(realNow - 40 * 86400000).toISOString();

  // ---------- Empresa A ----------
  const A = db.insert('companies', { name: 'Brightway Home Cleaning', timezone: 'America/New_York', locale: 'pt-BR', currency: 'USD', phone: '(407) 555-0100', email: 'hello@brightway.example', demo: 1, created_at: created });
  const azul = db.insert('crews', { company_id: A, name: 'Equipe Azul', color: '#2563eb' });
  const verde = db.insert('crews', { company_id: A, name: 'Equipe Verde', color: '#059669' });
  const mk = (company_id, name, email, role, crew_id = null, hourly_cost = 0) => db.insert('users', { company_id, name, email, role, crew_id, hourly_cost, password_hash: pw, permissions: '{}', created_at: created });
  const ana = mk(A, 'Ana Ribeiro', 'ana@brightway.demo', 'owner');
  const julia = mk(A, 'Julia Santos', 'julia@brightway.demo', 'assistant');
  const carla = mk(A, 'Carla Mendes', 'carla@brightway.demo', 'field', azul, 2200);
  const rosa = mk(A, 'Rosa Lima', 'rosa@brightway.demo', 'field', verde, 2200);
  mk(A, 'Bianca Alves', 'bianca@brightway.demo', 'field', azul, 0);
  installJourneys(db, A);

  // ---------- Empresa B (para validar o isolamento entre empresas) ----------
  const B = db.insert('companies', { name: 'Sparkle Bay Cleaning', timezone: 'America/Los_Angeles', locale: 'pt-BR', currency: 'USD', phone: '(415) 555-0190', email: 'team@sparklebay.example', demo: 1, created_at: created });
  db.insert('crews', { company_id: B, name: 'Crew 1', color: '#7c3aed' });
  const bOwner = mk(B, 'Diego Torres', 'diego@sparklebay.demo', 'owner');
  installJourneys(db, B);

  const company = db.get('SELECT * FROM companies WHERE id = ?', A);
  const tz = company.timezone;
  const ctxOf = (userId) => { const user = db.get('SELECT * FROM users WHERE id = ?', userId); return { db, company: db.get('SELECT * FROM companies WHERE id = ?', user.company_id), user, perms: permsFor(user) }; };
  const pub = { db, company, user: null, perms: {} };
  const ANA = ctxOf(ana); const JULIA = ctxOf(julia); const CARLA = ctxOf(carla); const ROSA = ctxOf(rosa);

  const T = TZ.localDate(realNow, tz);
  const D = (d) => TZ.addDays(T, d);
  const at = (d, hm) => Math.min(Date.parse(TZ.toUtc(D(d), hm, tz)), realNow - 60000);
  const plan = [];
  const step = (d, hm, fn) => plan.push({ t: at(d, hm), seq: plan.length, fn });
  const refs = {};
  const usd = (n) => Math.round(n * 100);

  const addr = (line1, city, zip, extra = {}) => ({ label: 'Residência', line1, city, state: 'FL', zip, ...extra });
  const lead = (ctx, key, data) => { const r = crm.createLead(ctx, { ...data, ignore_duplicates: true }); refs[key] = { ...r }; return r; };
  const quote = (ctx, key, items, { frequency = 'one_time', terms = { type: 'on_completion', due_days: 0 }, validDays = 14, notes = null, d = 0 } = {}) => {
    const r = refs[key];
    r.quote_id = crm.createQuote(ctx, { client_id: r.client_id, opportunity_id: r.opportunity_id, items, frequency, payment_terms: terms, valid_until: D(d + validDays), notes });
    return r.quote_id;
  };
  const approve = (ctx, key, via) => { const out = crm.approveQuote(ctx, refs[key].quote_id, { via }); refs[key].job_id = out.job_id; refs[key].deposit_id = out.deposit_invoice_id; };
  const schedule = (key, d, hm, crew, extra = {}) => ops.scheduleJob(JULIA, refs[key].job_id, { date: D(d), time: hm, crew_id: crew, duration_min: extra.duration || 180, frequency: extra.frequency || 'one_time', allow_past: true, force: true });
  const checkAll = (ctx, jobId) => { const j = db.get('SELECT checklist FROM jobs WHERE id = ?', jobId); JSON.parse(j.checklist).forEach((_, i) => ops.toggleChecklist(ctx, jobId, i, true)); };
  const execute = (ctx, key, { hours, supplies = 0, complete = true, jobId = null, costsComplete = false }) => {
    const id = jobId || refs[key].job_id;
    ops.jobAction(ctx, id, 'start');
    checkAll(ctx, id);
    ops.addTime(ctx, id, { hours });
    if (supplies) ops.addJobCost(ctx, id, { description: 'Produtos de limpeza', category: 'Produtos de limpeza', amount: usd(supplies) });
    if (complete) ops.jobAction(ctx, id, 'complete', { confirm: true });
    if (costsComplete) ops.setCostsComplete(ANA, id, true);
  };

  // Karen Davis: ciclo completo há ~3 semanas, paga; custos ainda não confirmados (pendência de dados).
  step(-30, '10:00', () => lead(JULIA, 'karen', { name: 'Karen Davis', phone: '(407) 555-0142', email: 'karen.davis@example.com', source: 'Google', service_interest: 'Deep clean', address: addr('1420 Lakeview Dr', 'Orlando', '32803'), preferences: 'Prefere visitas pela manhã. Tem um gato (não deixar sair).' }));
  step(-30, '11:00', () => crm.updateOpportunity(JULIA, refs.karen.opportunity_id, { stage: 'contacted' }));
  step(-29, '13:30', () => quote(JULIA, 'karen', [{ description: 'Deep clean - 3 quartos, 2 banheiros', quantity: 1, unit_price: usd(320) }], { d: -29 }));
  step(-29, '14:00', () => crm.sendQuote(JULIA, refs.karen.quote_id));
  step(-27, '18:20', () => approve(pub, 'karen', 'client'));
  step(-26, '09:10', () => schedule('karen', -20, '09:00', verde, { duration: 240 }));
  step(-20, '08:40', () => ops.jobAction(ROSA, refs.karen.job_id, 'on_the_way'));
  step(-20, '09:05', () => execute(ROSA, 'karen', { hours: 4, supplies: 0 }));
  step(-20, '13:30', () => fin.invoiceJob(ANA, refs.karen.job_id));
  step(-18, '15:00', () => fin.recordPayment(ANA, db.get(`SELECT id FROM invoices WHERE job_id = ? AND kind = 'final'`, refs.karen.job_id).id, { amount: usd(320), method: 'zelle', paid_date: D(-18) }));

  // Sarah Johnson: cliente quinzenal; visita de hoje agendada para a Equipe Azul.
  step(-22, '09:00', () => lead(JULIA, 'sarah', { name: 'Sarah Johnson', phone: '(407) 555-0117', email: 'sarah.j@example.com', source: 'Indicação', service_interest: 'Limpeza quinzenal', address: addr('88 Magnolia Ave', 'Winter Park', '32789', { access_notes: 'Chave no cofre da porta lateral, código 4471.' }), preferences: 'Usar produtos sem perfume.' }));
  step(-21, '10:00', () => quote(JULIA, 'sarah', [{ description: 'Standard clean (quinzenal)', details: 'Casa de 2 quartos, 2 banheiros', quantity: 1, unit_price: usd(165) }], { frequency: 'biweekly', d: -21 }));
  step(-21, '10:15', () => crm.sendQuote(JULIA, refs.sarah.quote_id));
  step(-20, '16:00', () => approve(JULIA, 'sarah', 'staff'));
  step(-19, '10:00', () => schedule('sarah', -14, '09:00', azul, { frequency: 'biweekly' }));
  step(-14, '08:40', () => ops.jobAction(CARLA, refs.sarah.job_id, 'on_the_way'));
  step(-14, '09:00', () => execute(CARLA, 'sarah', { hours: 3, supplies: 18, costsComplete: true }));
  step(-14, '12:30', () => fin.invoiceJob(ANA, refs.sarah.job_id));
  step(-13, '11:00', () => fin.recordPayment(ANA, db.get(`SELECT id FROM invoices WHERE job_id = ? AND kind = 'final'`, refs.sarah.job_id).id, { amount: usd(165), method: 'card_manual', paid_date: D(-13) }));

  // Thomas Wilson: orçamento recusado (perdido) e descadastro de SMS.
  step(-16, '09:30', () => lead(JULIA, 'thomas', { name: 'Thomas Wilson', phone: '(407) 555-0175', email: 'twilson@example.com', source: 'Thumbtack', service_interest: 'Standard clean', address: addr('2301 Bayhill Ct', 'Kissimmee', '34741') }));
  step(-15, '11:00', () => quote(JULIA, 'thomas', [{ description: 'Standard clean - 4 quartos', quantity: 1, unit_price: usd(250) }], { d: -15 }));
  step(-15, '11:10', () => crm.sendQuote(JULIA, refs.thomas.quote_id));
  step(-12, '10:30', () => crm.simulateInbound(JULIA, refs.thomas.client_id, { kind: 'optout', channel: 'sms', text: 'STOP' }));
  step(-11, '15:00', () => crm.declineQuote(JULIA, refs.thomas.quote_id, { reason: 'Preço acima do esperado' }));

  // Michael Brown: cobrança vencida com pagamento parcial.
  step(-13, '14:00', () => lead(JULIA, 'michael', { name: 'Michael Brown', phone: '(407) 555-0163', email: 'mbrown@example.com', source: 'Google', service_interest: 'Deep clean', address: addr('517 Orange Blossom Trl', 'Orlando', '32805') }));
  step(-12, '10:00', () => quote(JULIA, 'michael', [{ description: 'Deep clean - 4 quartos, 3 banheiros', quantity: 1, unit_price: usd(420) }], { terms: { type: 'on_completion', due_days: 7 }, d: -12 }));
  step(-12, '10:05', () => crm.sendQuote(JULIA, refs.michael.quote_id));
  step(-11, '20:10', () => approve(pub, 'michael', 'client'));
  step(-11, '21:00', () => schedule('michael', -10, '13:00', verde, { duration: 240 }));
  step(-10, '13:00', () => execute(ROSA, 'michael', { hours: 4, supplies: 25, costsComplete: true }));
  step(-10, '17:30', () => fin.invoiceJob(ANA, refs.michael.job_id));
  step(-5, '12:00', () => fin.recordPayment(ANA, db.get(`SELECT id FROM invoices WHERE job_id = ? AND kind = 'final'`, refs.michael.job_id).id, { amount: usd(200), method: 'check', paid_date: D(-5), note: 'Cliente pediu para pagar o restante na próxima semana' }));

  // Patricia Moore: nota baixa na pesquisa virou reclamação em aberto.
  step(-10, '09:00', () => lead(JULIA, 'patricia', { name: 'Patricia Moore', phone: '(407) 555-0128', email: 'pmoore@example.com', source: 'Facebook/Instagram', service_interest: 'Standard clean', address: addr('76 Cypress Point Ln', 'Orlando', '32819') }));
  step(-9, '10:00', () => quote(JULIA, 'patricia', [{ description: 'Standard clean - 2 quartos', quantity: 1, unit_price: usd(150) }], { d: -9 }));
  step(-9, '10:05', () => crm.sendQuote(JULIA, refs.patricia.quote_id));
  step(-9, '16:00', () => approve(pub, 'patricia', 'client'));
  step(-9, '17:00', () => schedule('patricia', -7, '10:00', azul));
  step(-7, '10:00', () => execute(CARLA, 'patricia', { hours: 3, supplies: 10, costsComplete: true }));
  step(-7, '13:30', () => fin.invoiceJob(ANA, refs.patricia.job_id));
  step(-7, '14:00', () => fin.recordPayment(ANA, db.get(`SELECT id FROM invoices WHERE job_id = ? AND kind = 'final'`, refs.patricia.job_id).id, { amount: usd(150), method: 'cash', paid_date: D(-7) }));
  step(-6, '10:40', () => crm.simulateInbound(JULIA, refs.patricia.client_id, { kind: 'rating', channel: 'sms', rating: 2, text: 'The guest bathroom was not cleaned.' }));

  // Robert Garcia: mudança com depósito pago; serviço em andamento hoje.
  step(-6, '15:00', () => lead(JULIA, 'robert', { name: 'Robert Garcia', phone: '(407) 555-0189', email: 'rgarcia@example.com', source: 'Facebook/Instagram', service_interest: 'Move-out cleaning', address: addr('4100 Conway Rd, Apt 12', 'Orlando', '32812', { access_notes: 'Portaria: avisar que é limpeza de mudança.' }) }));
  step(-5, '10:00', () => quote(JULIA, 'robert', [{ description: 'Move-out cleaning', details: 'Apartamento vazio, 2 quartos', quantity: 1, unit_price: usd(380) }], { terms: { type: 'deposit', deposit_percent: 25, due_days: 0 }, d: -5 }));
  step(-5, '10:10', () => crm.sendQuote(JULIA, refs.robert.quote_id));
  step(-4, '09:30', () => approve(pub, 'robert', 'client'));
  step(-4, '11:00', () => fin.recordPayment(ANA, refs.robert.deposit_id, { amount: usd(95), method: 'zelle', paid_date: D(-4) }));
  step(-4, '11:30', () => schedule('robert', 0, '08:00', verde, { duration: 300 }));
  step(0, '07:45', () => ops.jobAction(ROSA, refs.robert.job_id, 'on_the_way'));
  step(0, '08:05', () => { ops.jobAction(ROSA, refs.robert.job_id, 'start'); [0, 1, 2].forEach((i) => ops.toggleChecklist(ROSA, refs.robert.job_id, i, true)); });

  // David Miller: aprovado ontem com depósito pago; aguardando agendamento.
  step(-5, '16:00', () => lead(JULIA, 'david', { name: 'David Miller', phone: '(407) 555-0151', email: 'dmiller@example.com', source: 'Nextdoor', service_interest: 'Deep clean', address: addr('930 Park Lake St', 'Orlando', '32803') }));
  step(-4, '14:00', () => quote(JULIA, 'david', [{ description: 'Deep clean - 3 quartos', quantity: 1, unit_price: usd(320) }, { description: 'Interior da geladeira', quantity: 1, unit_price: usd(40) }], { terms: { type: 'deposit', deposit_percent: 30, due_days: 0 }, d: -4 }));
  step(-4, '14:10', () => crm.sendQuote(JULIA, refs.david.quote_id));
  step(-1, '15:00', () => approve(pub, 'david', 'client'));
  step(-1, '17:00', () => fin.recordPayment(ANA, refs.david.deposit_id, { amount: usd(108), method: 'venmo', paid_date: D(-1) }));

  // Emily Chen: concluído ontem, cobrança em aberto (não vencida).
  step(-4, '09:00', () => lead(JULIA, 'emily', { name: 'Emily Chen', phone: '(407) 555-0134', email: 'emily.chen@example.com', source: 'Site', service_interest: 'Standard clean', address: addr('3310 Edgewater Dr', 'Orlando', '32804') }));
  step(-3, '10:00', () => quote(JULIA, 'emily', [{ description: 'Standard clean - 2 quartos', quantity: 1, unit_price: usd(140) }], { terms: { type: 'on_completion', due_days: 7 }, d: -3 }));
  step(-3, '10:05', () => crm.sendQuote(JULIA, refs.emily.quote_id));
  step(-3, '12:00', () => approve(JULIA, 'emily', 'staff'));
  step(-3, '12:10', () => schedule('emily', -1, '13:00', azul));
  step(-1, '13:00', () => execute(CARLA, 'emily', { hours: 2.5, supplies: 12, costsComplete: true }));
  step(-1, '16:30', () => fin.invoiceJob(ANA, refs.emily.job_id));

  // Olivia Martinez: serviço avulso hoje à tarde. Brian Lee: serviço em dois dias.
  step(-4, '11:00', () => lead(JULIA, 'olivia', { name: 'Olivia Martinez', phone: '(407) 555-0198', email: 'olivia.m@example.com', source: 'Indicação', service_interest: 'Standard clean', address: addr('1205 Delaney Ave', 'Orlando', '32806') }));
  step(-4, '12:00', () => quote(JULIA, 'olivia', [{ description: 'Standard clean - 3 quartos', quantity: 1, unit_price: usd(175) }], { d: -4 }));
  step(-4, '12:05', () => crm.sendQuote(JULIA, refs.olivia.quote_id));
  step(-3, '09:00', () => approve(pub, 'olivia', 'client'));
  step(-3, '09:30', () => schedule('olivia', 0, '14:00', azul));
  step(-3, '15:00', () => lead(JULIA, 'brian', { name: 'Brian Lee', phone: '(407) 555-0111', email: 'brian.lee@example.com', source: 'Google', service_interest: 'Standard clean', address: addr('640 Mills Ave', 'Orlando', '32803') }));
  step(-3, '15:30', () => quote(JULIA, 'brian', [{ description: 'Standard clean - 2 quartos', quantity: 1, unit_price: usd(170) }, { description: 'Interior do forno', quantity: 1, unit_price: usd(40) }], { d: -3 }));
  step(-3, '15:35', () => crm.sendQuote(JULIA, refs.brian.quote_id));
  step(-2, '10:00', () => approve(JULIA, 'brian', 'staff'));
  step(-2, '10:20', () => schedule('brian', 2, '10:00', verde));

  // Linda Park: orçamento enviado, 1º follow-up já saiu, o próximo está agendado.
  step(-4, '10:00', () => lead(JULIA, 'linda', { name: 'Linda Park', phone: '(407) 555-0122', email: 'linda.park@example.com', source: 'Google', service_interest: 'Deep clean', address: addr('2150 Curry Ford Rd', 'Orlando', '32806') }));
  step(-4, '11:00', () => crm.updateOpportunity(JULIA, refs.linda.opportunity_id, { stage: 'contacted' }));
  step(-3, '11:00', () => quote(JULIA, 'linda', [{ description: 'Deep clean - 3 quartos, 2 banheiros', quantity: 1, unit_price: usd(290) }], { d: -3 }));
  step(-3, '11:10', () => crm.sendQuote(JULIA, refs.linda.quote_id));

  // Kevin Wright: respondeu ao follow-up; sequência pausada aguardando atendimento humano.
  step(-5, '13:00', () => lead(JULIA, 'kevin', { name: 'Kevin Wright', phone: '(407) 555-0146', email: 'kwright@example.com', source: 'Site', service_interest: 'Standard clean', address: addr('77 Lake Davis Dr', 'Orlando', '32806') }));
  step(-4, '09:00', () => quote(JULIA, 'kevin', [{ description: 'Standard clean - 3 quartos', quantity: 1, unit_price: usd(230) }], { d: -4 }));
  step(-4, '09:05', () => crm.sendQuote(JULIA, refs.kevin.quote_id));
  step(-1, '18:30', () => crm.simulateInbound(JULIA, refs.kevin.client_id, { kind: 'reply', channel: 'sms', text: 'Hi! Could you do a Saturday instead of a weekday?' }));

  // Mark Thompson: em atendimento, próxima ação atrasada. Jennifer Walsh: contato novo hoje.
  step(-2, '09:00', () => lead(JULIA, 'mark', { name: 'Mark Thompson', phone: '(407) 555-0157', email: 'mark.t@example.com', source: 'Thumbtack', service_interest: 'Limpeza de escritório pequeno', address: addr('101 S Orange Ave, Suite 400', 'Orlando', '32801'), notes: 'Escritório de 1.200 sq ft. Quer limpeza semanal às sextas após 6 PM.' }));
  step(-2, '11:00', () => crm.updateOpportunity(JULIA, refs.mark.opportunity_id, { stage: 'contacted', next_action_due: D(-1) }));
  step(0, '06:30', () => lead(JULIA, 'jennifer', { name: 'Jennifer Walsh', phone: '(407) 555-0109', email: 'jen.walsh@example.com', source: 'Google', service_interest: 'Standard clean', estimated_value: 18000 }));

  // Notas da pesquisa de satisfação (alimentam os indicadores do time).
  step(-19, '10:40', () => crm.simulateInbound(JULIA, refs.karen.client_id, { kind: 'rating', channel: 'sms', rating: 5, text: '5 - Rosa did an amazing job!' }));
  step(-13, '10:30', () => crm.simulateInbound(JULIA, refs.sarah.client_id, { kind: 'rating', channel: 'sms', rating: 5 }));
  step(0, '10:30', () => crm.simulateInbound(JULIA, refs.emily.client_id, { kind: 'rating', channel: 'sms', rating: 4 }));

  // Tarefas, despesas e receitas manuais.
  step(-1, '09:00', () => crm.createTask(JULIA, { title: 'Ligar para Mark e levantar metragem para o orçamento', assignee_id: julia, due_date: D(-1), client_id: refs.mark.client_id }));
  step(-1, '09:05', () => crm.createTask(ANA, { title: 'Repor produtos de limpeza da Equipe Azul', assignee_id: carla, due_date: D(0) }));
  step(-1, '09:10', () => crm.createTask(ANA, { title: 'Renovar o seguro de responsabilidade civil', assignee_id: ana, due_date: D(5), priority: 'high' }));
  step(-8, '18:00', () => fin.createExpense(ANA, { description: 'Gasolina - van da Equipe Azul', category: 'Combustível e deslocamento', amount: usd(68), date: D(-8) }));
  step(-10, '18:00', () => fin.createExpense(ANA, { description: 'Anúncios Google Local Services', category: 'Marketing', amount: usd(120), date: D(-10) }));
  step(-2, '18:00', () => fin.createExpense(ANA, { description: 'Software de agenda (mensalidade)', category: 'Software', amount: usd(29), date: D(-2) }));
  step(-9, '17:00', () => fin.createIncome(ANA, { description: 'Limpeza avulsa paga em dinheiro (sem orçamento)', amount: usd(90), date: D(-9), method: 'cash' }));

  // Empresa B: um cliente simples.
  const BCTX = ctxOf(bOwner);
  step(-3, '12:00', () => crm.createLead(BCTX, { name: 'Nora Jensen', phone: '(415) 555-0133', email: 'nora.j@example.com', source: 'Google', ignore_duplicates: true }));

  // Executa a linha do tempo em ordem, processando a fila de mensagens entre os passos.
  plan.sort((a, b) => a.t - b.t || a.seq - b.seq);
  const companies = [db.get('SELECT * FROM companies WHERE id = ?', A), db.get('SELECT * FROM companies WHERE id = ?', B)];
  const drain = (until) => { for (const c of companies) engine.processDue({ db, company: c, user: null, perms: {} }, { until, replay: true }); };
  try {
    for (const p of plan) {
      drain(p.t);
      clock.set(p.t);
      db.tx(() => p.fn());
    }
    drain(realNow - 1000);
  } finally {
    clock.reset();
  }
  seedTeam(db, ANA, { julia, carla, rosa, bianca: db.get(`SELECT id FROM users WHERE email = 'bianca@brightway.demo'`).id }, T);
  return { companyA: A, companyB: B };
}

function seedTeam(db, ANA, u, T) {
  const ctx = { ...ANA, user: db.get('SELECT * FROM users WHERE id = ?', ANA.user.id) };
  const M1 = TZ.addMonthsClamped(T.slice(0, 7) + '-01', -1, 1).slice(0, 7);
  const M2 = TZ.addMonthsClamped(T.slice(0, 7) + '-01', -2, 1).slice(0, 7);
  const sc = (M, A, G, I, C) => ({ M, A, G, I, C });
  db.tx(() => {
    team.saveProfile(ctx, u.julia, { position: 'Assistente virtual (VA)', hire_date: '2025-08-04', employment_type: '1099', motivators: 'Flexibilidade de horário e chance de crescer na área comercial.', career_goals: 'Assumir a gestão comercial da empresa.', strengths: 'Organizada, rápida no follow-up, ótima escrita em inglês.' });
    team.saveProfile(ctx, u.carla, { position: 'Líder da Equipe Azul', hire_date: '2024-03-11', employment_type: 'w2', motivators: 'Reconhecimento pelo padrão de qualidade e renda extra por desempenho.', career_goals: 'Supervisionar as duas equipes.', strengths: 'Referência de qualidade; os clientes recorrentes pedem por ela.' });
    team.saveProfile(ctx, u.rosa, { position: 'Líder da Equipe Verde', hire_date: '2025-01-20', employment_type: 'w2', motivators: 'Estabilidade e um ambiente de equipe tranquilo.', career_goals: 'Melhorar o inglês para atender clientes sozinha.', strengths: 'Pontual, cuidadosa, excelente com mudanças (move-out).' });
    team.saveProfile(ctx, u.bianca, { position: 'Auxiliar de limpeza', hire_date: '2026-09-15', employment_type: 'w2', motivators: 'Ainda conhecendo: perguntar na próxima conversa.', career_goals: '', strengths: 'Aprende rápido.' });
    const rv = (user_id, month, ms, ss, extra = {}) => team.saveReview(ctx, { user_id, month, manager_scores: ms, self_scores: ss, ...extra });
    rv(u.julia, M2, sc(4, 3, 3, 4, 4), sc(4, 2, 4, 4, 4));
    rv(u.julia, M1, sc(4, 4, 4, 4, 4), sc(4, 2, 4, 4, 5), { notes: { A: 'Ela sente que precisa pedir aprovação para tudo no comercial.' }, highlights: 'Zerou os follow-ups atrasados na segunda quinzena.', attention: 'Diferença grande entre a minha visão e a dela sobre autonomia.', agreements: 'Julia aprova sozinha descontos de até 10% nos orçamentos.' });
    rv(u.carla, M2, sc(4, 4, 3, 4, 4), null);
    rv(u.carla, M1, sc(4, 4, 2, 3, 4), sc(4, 4, 2, 3, 3), { notes: { G: 'Disse que está "no mesmo lugar" há dois anos.' }, highlights: 'Nenhuma reclamação de clientes recorrentes.', attention: 'Risco de saída se não enxergar crescimento.', agreements: 'Montar o PDI de supervisão até o dia 10.' });
    rv(u.rosa, M2, sc(5, 4, 4, 5, 4), null);
    rv(u.rosa, M1, sc(5, 4, 4, 5, 5), sc(5, 4, 3, 5, 5), { highlights: 'Elogio espontâneo da cliente Karen Davis.', agreements: 'Pesquisar curso de inglês com horário compatível.' });
    rv(u.bianca, M1, sc(3, 2, 3, 3, 2), sc(4, 3, 4, 3, 3), { notes: { C: 'Ainda não se sente parte da equipe; pouco contato com a liderança.' }, attention: 'Período de adaptação: risco de desistência nos primeiros 90 dias.', agreements: 'Conversa quinzenal com o dono até completar 90 dias.' });
    const goal = (user_id, title, dimension, due, status, actions, success_criteria) => {
      const id = team.createGoal(ctx, { user_id, title, dimension, due_date: TZ.addDays(T, due), actions, success_criteria });
      if (status !== 'not_started') team.updateGoal(ctx, id, { status });
    };
    goal(u.carla, 'Preparar-se para supervisionar as duas equipes', 'G', 60, 'in_progress', 'Acompanhar a dona em 2 avaliações de qualidade por mês; treinar a Bianca no padrão de deep clean.', 'Fazer 4 avaliações de qualidade sozinha, com nota média dos clientes de pelo menos 4.5.');
    goal(u.bianca, 'Dominar o checklist de deep clean', 'G', 20, 'in_progress', 'Executar 3 deep cleans acompanhada pela Carla.', 'Checklist 100% completo em 3 serviços seguidos.');
    goal(u.bianca, 'Conversa quinzenal com o dono', 'C', -3, 'not_started', 'Agendar 15 minutos a cada 15 dias até completar 90 dias de empresa.', 'Duas conversas realizadas por mês.');
    goal(u.julia, 'Assumir o funil comercial de ponta a ponta', 'A', 45, 'in_progress', 'Definir com a dona os limites de desconto e as regras de aprovação.', 'Taxa de aprovação de orçamentos acima de 50% sem envolver a dona.');
    goal(u.julia, 'Zerar os follow-ups atrasados', 'I', -2, 'done', 'Revisar a tela Hoje duas vezes por dia.', 'Nenhum follow-up atrasado por 2 semanas.');
    goal(u.rosa, 'Curso de inglês para atendimento', 'G', 90, 'not_started', 'Escolher curso noturno ou online; empresa reembolsa 50%.', 'Conseguir atender um cliente novo sozinha.');
    const rule = (name, applies_to, metric, threshold, dollars) => team.saveRule(ctx, null, { name, applies_to, metric, threshold, amount: dollars * 100 });
    const rRating = rule('Nota dos clientes', 'field', 'avg_rating_gte', 4.5, 50);
    rule('Zero reclamações', 'field', 'zero_complaints', null, 40);
    rule('Checklist impecável', 'field', 'checklist_pct_gte', 95, 30);
    rule('Tarefas em dia', 'assistant', 'tasks_on_time_pct_gte', 90, 60);
    rule('Evolução no PDI', 'all', 'pdi_goal_done', null, 25);
    const zero = db.get(`SELECT id FROM bonus_rules WHERE company_id = ? AND metric = 'zero_complaints'`, ctx.company.id).id;
    try { const b = team.createBonus(ctx, { user_id: u.rosa, month: M1, rule_id: zero }); team.payBonus(ctx, b.id, { paid_date: T.slice(0, 7) + '-01' }); } catch (e) { /* critério não atingido nesta data */ }
    try { team.createBonus(ctx, { user_id: u.rosa, month: M1, rule_id: rRating }); } catch (e) { /* critério não atingido nesta data */ }
  });
}

module.exports = { seed, installJourneys };

if (require.main === module) {
  const db = require('./db').open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'fluxo.db'));
  seed(db);
  console.log('Dados de demonstração carregados.');
}
