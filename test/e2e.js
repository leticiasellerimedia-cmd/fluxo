// Teste de ponta a ponta do fluxo principal e das regras obrigatórias, pela API real.
// Sobe o servidor com um banco temporário, executa o cenário e reinicia o servidor
// para confirmar a persistência. Uso: npm test
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const TZ = require('../public/shared/tz.js');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `fluxo-e2e-${process.pid}.db`);
let server;
let passed = 0;

function start() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'server.js')], { env: { ...process.env, PORT, DB_FILE: DB }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    server.stdout.on('data', (d) => { out += d; if (out.includes('rodando')) resolve(); });
    server.stderr.on('data', (d) => process.stderr.write(d));
    server.on('exit', (c) => { if (c) reject(new Error('servidor saiu ' + c)); });
    setTimeout(() => reject(new Error('timeout ao iniciar: ' + out)), 20000);
  });
}
const stop = () => new Promise((r) => { server.once('exit', r); server.kill(); });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  const ok = async (method, url, body) => { const r = await call(method, url, body); if (r.status !== 200) throw new Error(`${method} ${url} -> ${r.status}: ${JSON.stringify(r.data)}`); return r.data; };
  return { call, ok, login: (email) => ok('POST', '/api/login', { email, password: 'demo123' }) };
}

function check(cond, label) {
  if (!cond) throw new Error('FALHOU: ' + label);
  passed++; console.log('  ok  ' + label);
}

(async () => {
  await start();
  const ana = client(); await ana.login('ana@brightway.demo');
  const me = await ana.ok('GET', '/api/me');
  const tz = me.company.timezone;
  const meta = await ana.ok('GET', '/api/meta');
  const azul = meta.crews.find((c) => c.name === 'Equipe Azul').id;
  const verde = meta.crews.find((c) => c.name === 'Equipe Verde').id;
  const today = TZ.localDate(Date.now(), tz);

  console.log('\n1. Cadastrar um contato');
  const lead = await ana.ok('POST', '/api/leads', { name: 'Zoe Bennett', phone: '(407) 555-0999', email: 'zoe.bennett@example.com', source: 'Google', service_interest: 'Deep clean', address: { line1: '12 Test Ln', city: 'Orlando', state: 'FL', zip: '32801' } });
  check(lead.client_id && lead.opportunity_id, 'contato cria cliente e oportunidade de uma vez');
  const dup = await ana.call('POST', '/api/leads', { name: 'Zoe B.', phone: '407.555.0999' });
  check(dup.status === 409 && dup.data.duplicates.length === 1, 'aviso de duplicidade pelo telefone');
  let c = await ana.ok('GET', `/api/clients/${lead.client_id}`);
  check(c.next_action && c.next_action_due === today, 'próxima ação inicial definida para hoje');
  check(c.enrollments.length === 0 && c.messages.some((m) => m.journey_name === 'Confirmação de pedido recebido'), 'confirmação de pedido recebido enviada (simulação)');

  console.log('\n2. Criar e enviar orçamento (demonstração)');
  const bad = await ana.call('POST', '/api/quotes', { client_id: lead.client_id, items: [], valid_until: today });
  check(bad.status === 400, 'validação: orçamento sem serviços é recusado');
  const q = await ana.ok('POST', '/api/quotes', { client_id: lead.client_id, opportunity_id: lead.opportunity_id, items: [{ description: 'Deep clean', quantity: 1, unit_price: 30000 }, { description: 'Interior do forno', quantity: 1, unit_price: 4000 }], valid_until: TZ.addDays(today, 14), payment_terms: { type: 'deposit', deposit_percent: 20, due_days: 7 }, frequency: 'one_time' });
  const sent = await ana.ok('POST', `/api/quotes/${q.id}/send`);
  let quote = await ana.ok('GET', `/api/quotes/${q.id}`);
  check(quote.status === 'sent' && quote.total === 34000 && quote.address, 'orçamento enviado, total calculado e endereço do cliente aproveitado');
  check(quote.followups.length === 3 && quote.followups.every((m) => m.status === 'pending'), '3 follow-ups programados');
  const opps = await ana.ok('GET', '/api/opportunities');
  check(opps.find((o) => o.id === lead.opportunity_id).stage === 'quote_sent', 'funil avança para "orçamento enviado"');

  console.log('\n3. Simular aprovação pelo cliente');
  const pub = await ana.ok('GET', `/api/public/quotes/${sent.public_token}`);
  check(pub.quote.total === 34000 && !pub.client.email, 'página pública mostra o orçamento sem expor dados internos');
  await ana.ok('POST', `/api/public/quotes/${sent.public_token}/approve`);
  await ana.ok('POST', `/api/public/quotes/${sent.public_token}/approve`); // repetido
  quote = await ana.ok('GET', `/api/quotes/${q.id}`);
  check(quote.status === 'approved' && quote.job && quote.job.status === 'pending_schedule', 'aprovação cria serviço pendente de agendamento (sem data automática)');
  check(quote.followups.every((m) => m.status === 'canceled'), 'aprovação encerra os follow-ups');
  const jobsOfQuote = (await ana.ok('GET', `/api/jobs?client_id=${lead.client_id}`));
  check(jobsOfQuote.length === 1, 'aprovação repetida não duplica o serviço');
  let invs = await ana.ok('GET', `/api/invoices?client_id=${lead.client_id}`);
  check(invs.length === 1 && invs[0].kind === 'deposit' && invs[0].amount === 6800, 'depósito de 20% gerado conforme o combinado');
  const jobId = quote.job.id;

  console.log('\n4. Agendar e atribuir equipe');
  const tomorrow = TZ.addDays(today, 2); // fora da janela de 24h do lembrete
  await ana.ok('POST', `/api/jobs/${jobId}/schedule`, { date: tomorrow, time: '10:00', crew_id: azul, duration_min: 180 });
  const other = await ana.ok('POST', '/api/jobs', { client_id: lead.client_id, title: 'Teste conflito', price: 10000 });
  const conflict = await ana.call('POST', `/api/jobs/${other.id}/schedule`, { date: tomorrow, time: '11:00', crew_id: azul, duration_min: 120 });
  check(conflict.status === 409 && conflict.data.conflicts.length >= 1, 'conflito de horário detectado');
  await ana.ok('POST', `/api/jobs/${other.id}/action`, { action: 'cancel', reason: 'teste' });

  console.log('\n5. Lembrete na jornada');
  let job = await ana.ok('GET', `/api/jobs/${jobId}`);
  const reminder = job.messages.find((m) => m.journey_name === 'Lembrete antes do serviço');
  check(reminder && reminder.status === 'pending' && Math.abs(Date.parse(reminder.send_at) - (Date.parse(job.start_at) - 86400000)) < 1000, 'lembrete agendado 24h antes do serviço');
  const confirmMsg = job.messages.find((m) => m.journey_name === 'Confirmação de agendamento');
  check(confirmMsg && confirmMsg.status === 'sent', 'confirmação de agendamento enviada (simulação)');
  const journeys = await ana.ok('GET', '/api/journeys');
  const rj = await ana.ok('GET', `/api/journeys/${journeys.find((j) => j.key === 'service_reminder').id}`);
  check(rj.queue.some((m) => m.id === reminder.id), 'lembrete visível na fila da jornada');
  await ana.ok('POST', `/api/jobs/${jobId}/schedule`, { date: TZ.addDays(today, 3), time: '13:00', crew_id: azul, duration_min: 180 });
  job = await ana.ok('GET', `/api/jobs/${jobId}`);
  const r2 = job.messages.find((m) => m.id === reminder.id);
  check(r2.status === 'pending' && Math.abs(Date.parse(r2.send_at) - (Date.parse(job.start_at) - 86400000)) < 1000, 'reagendamento atualiza o lembrete');
  // Trazemos o serviço para daqui a 1 hora para poder executá-lo agora.
  const soon = Date.now() + 3600000;
  await ana.ok('POST', `/api/jobs/${jobId}/schedule`, { date: TZ.localDate(soon, tz), time: TZ.localTime(soon - (soon % 900000), tz), crew_id: azul, duration_min: 180, force: true });
  job = await ana.ok('GET', `/api/jobs/${jobId}`);
  check(job.messages.find((m) => m.id === reminder.id).status === 'canceled', 'lembrete cancelado quando o novo horário não deixa tempo');

  console.log('\n6. Executar, concluir e registrar custos (equipe de campo)');
  const carla = client(); await carla.login('carla@brightway.demo');
  check((await carla.call('GET', '/api/finance/summary')).status === 403, 'equipe de campo sem acesso ao financeiro (servidor)');
  const fj = await carla.ok('GET', `/api/jobs/${jobId}`);
  check(fj.price === undefined && fj.invoices === undefined, 'equipe de campo não vê valores do serviço');
  const verdeJob = (await ana.ok('GET', '/api/jobs')).find((j) => j.crew_id === verde);
  check((await carla.call('GET', `/api/jobs/${verdeJob.id}`)).status === 404, 'equipe de campo só acessa serviços da própria equipe');
  await carla.ok('POST', `/api/jobs/${jobId}/action`, { action: 'on_the_way' });
  await carla.ok('POST', `/api/jobs/${jobId}/action`, { action: 'on_the_way' });
  c = await ana.ok('GET', `/api/clients/${lead.client_id}`);
  check(c.messages.filter((m) => m.journey_name === 'Aviso de equipe a caminho').length === 1, '"a caminho" repetido não duplica mensagem');
  await carla.ok('POST', `/api/jobs/${jobId}/action`, { action: 'start' });
  const noConfirm = await carla.call('POST', `/api/jobs/${jobId}/action`, { action: 'complete' });
  check(noConfirm.status === 409 && noConfirm.data.needs_confirm, 'conclusão com pendências pede confirmação');
  await carla.ok('POST', `/api/jobs/${jobId}/time`, { hours: 3 });
  await carla.ok('POST', `/api/jobs/${jobId}/costs`, { description: 'Produto para forno', amount: 1500, category: 'Produtos de limpeza' });
  await carla.ok('POST', `/api/jobs/${jobId}/action`, { action: 'complete', confirm: true });
  job = await ana.ok('GET', `/api/jobs/${jobId}`);
  check(job.status === 'completed' && job.costs.total === 6600 + 1500, 'custos: 3h x $22 + $15 de material');
  check(!job.result.complete && job.result.gaps.length, 'resultado aparece como incompleto até confirmar os custos');

  console.log('\n7. Gerar cobrança conforme combinado');
  const inv = await ana.ok('POST', `/api/jobs/${jobId}/invoice`);
  const inv2 = await ana.ok('POST', `/api/jobs/${jobId}/invoice`);
  check(inv2.duplicate && inv2.id === inv.id, 'cobrança não é duplicada');
  let invoice = await ana.ok('GET', `/api/invoices/${inv.id}`);
  check(invoice.amount === 34000 - 6800 && invoice.due_date === TZ.addDays(today, 7), 'cobrança final desconta o depósito e vence em 7 dias');
  check(invoice.reminders.some((m) => m.status === 'pending'), 'lembretes de pagamento programados');

  console.log('\n8. Registrar pagamento');
  const over = await ana.call('POST', `/api/invoices/${inv.id}/payments`, { amount: 999999, method: 'zelle' });
  check(over.status === 400, 'pagamento acima do saldo é recusado');
  await ana.ok('POST', `/api/invoices/${inv.id}/payments`, { amount: 10000, method: 'zelle' });
  invoice = await ana.ok('GET', `/api/invoices/${inv.id}`);
  check(invoice.status === 'partial' && invoice.balance === 17200 && invoice.reminders.some((m) => m.status === 'pending'), 'pagamento parcial mantém lembretes');
  await ana.ok('POST', `/api/invoices/${inv.id}/payments`, { amount: 17200, method: 'check' });
  invoice = await ana.ok('GET', `/api/invoices/${inv.id}`);
  check(invoice.status === 'paid' && invoice.reminders.every((m) => m.status !== 'pending'), 'pagamento integral encerra lembretes de cobrança');
  c = await ana.ok('GET', `/api/clients/${lead.client_id}`);
  check(/Acompanhar o pagamento/.test(c.next_action), 'com o depósito ainda em aberto, a próxima ação continua sendo cobrar');
  await ana.ok('POST', `/api/invoices/${invs[0].id}/payments`, { amount: 6800, method: 'venmo' });

  console.log('\n9. Financeiro e histórico do cliente');
  await ana.ok('POST', `/api/jobs/${jobId}/costs-complete`, { complete: true });
  const fin = await ana.ok('GET', '/api/finance/summary');
  const row = fin.jobs.find((j) => j.id === jobId);
  check(row && row.complete && row.result === 34000 - 8100, 'resultado direto do serviço = receita - custos diretos');
  check(fin.received.payments.some((p) => p.invoice_id === inv.id), 'pagamento aparece no recebido do mês');
  c = await ana.ok('GET', `/api/clients/${lead.client_id}`);
  const actions = c.history.map((h) => h.action).join(' | ');
  check(['Orçamento', 'aprovado', 'Agendado', 'Serviço concluído', 'Pagamento registrado'].every((k) => actions.includes(k)), 'histórico do cliente registra as mudanças de status');
  check(c.history.some((h) => h.user === 'Carla Mendes'), 'histórico identifica o responsável por cada mudança');

  console.log('\n10. Próxima ação de pós-serviço');
  check(/Pós-serviço/.test(c.next_action) && c.next_action_owner, `próxima ação: "${c.next_action}"`);
  check(c.enrollments.some((e) => e.journey_name === 'Lembrete de nova contratação') && c.enrollments.some((e) => e.journey_name === 'Pesquisa de satisfação'), 'pesquisa e lembrete de recontratação programados');

  console.log('\nRegras obrigatórias');
  const lead2 = await ana.ok('POST', '/api/leads', { name: 'Yara Collins', phone: '(407) 555-0888', email: 'yara@example.com', ignore_duplicates: true });
  const q2 = await ana.ok('POST', '/api/quotes', { client_id: lead2.client_id, items: [{ description: 'Standard clean', quantity: 1, unit_price: 15000 }], valid_until: TZ.addDays(today, 10), payment_terms: { type: 'on_completion', due_days: 0 } });
  await ana.ok('POST', `/api/quotes/${q2.id}/send`);
  await ana.ok('POST', `/api/clients/${lead2.client_id}/simulate-inbound`, { kind: 'reply', channel: 'sms', text: 'Can you come on Saturday?' });
  let c2 = await ana.ok('GET', `/api/clients/${lead2.client_id}`);
  check(c2.enrollments.some((e) => e.status === 'paused' && e.pause_reason === 'client_replied') && c2.tasks.some((tk) => tk.type === 'reply'), 'resposta do cliente pausa a sequência comercial e cria tarefa');
  await ana.ok('POST', `/api/clients/${lead2.client_id}/takeover`, { paused: false });
  c2 = await ana.ok('GET', `/api/clients/${lead2.client_id}`);
  check(c2.enrollments.every((e) => e.status === 'active'), 'retomar atendimento reativa a sequência');
  await ana.ok('POST', `/api/clients/${lead2.client_id}/simulate-inbound`, { kind: 'complaint', channel: 'sms', text: 'Unhappy with the call' });
  c2 = await ana.ok('GET', `/api/clients/${lead2.client_id}`);
  const complaint = c2.tasks.find((tk) => tk.type === 'complaint');
  check(complaint && c2.enrollments.some((e) => e.pause_reason === 'complaint'), 'reclamação abre tarefa e pausa ofertas comerciais');
  await ana.ok('PATCH', `/api/tasks/${complaint.id}`, { status: 'done' });
  c2 = await ana.ok('GET', `/api/clients/${lead2.client_id}`);
  check(c2.enrollments.every((e) => e.status === 'active'), 'resolução da reclamação retoma as ofertas');
  await ana.ok('POST', `/api/clients/${lead2.client_id}/simulate-inbound`, { kind: 'optout', channel: 'sms' });
  const qd = await ana.ok('GET', `/api/quotes/${q2.id}`);
  check(qd.followups.filter((m) => m.channel === 'sms').every((m) => m.status === 'blocked') && qd.followups.some((m) => m.channel === 'email' && m.status === 'pending'), 'descadastro de SMS bloqueia só o canal SMS');
  await ana.ok('POST', `/api/clients/${lead2.client_id}/takeover`, { paused: true });
  c2 = await ana.ok('GET', `/api/clients/${lead2.client_id}`);
  check(c2.automation_paused && c2.enrollments.every((e) => e.status === 'paused'), 'assumir atendimento pausa as automações do cliente');
  const ap = await ana.ok('POST', `/api/quotes/${q2.id}/approve`);
  await ana.ok('POST', `/api/jobs/${ap.job_id}/schedule`, { date: TZ.addDays(today, 5), time: '09:00', crew_id: verde, duration_min: 120 });
  await ana.ok('POST', `/api/jobs/${ap.job_id}/action`, { action: 'cancel', reason: 'Cliente viajou' });
  const cj = await ana.ok('GET', `/api/jobs/${ap.job_id}`);
  check(cj.messages.every((m) => m.status !== 'pending'), 'cancelamento interrompe as mensagens do serviço');

  console.log('\nRecorrência');
  const q3 = await ana.ok('POST', '/api/quotes', { client_id: lead2.client_id, items: [{ description: 'Standard clean', quantity: 1, unit_price: 14000 }], valid_until: TZ.addDays(today, 10), payment_terms: { type: 'on_completion', due_days: 0 }, frequency: 'weekly' });
  const a3 = await ana.ok('POST', `/api/quotes/${q3.id}/approve`);
  const first = TZ.addDays(today, 3);
  await ana.ok('POST', `/api/jobs/${a3.job_id}/schedule`, { date: first, time: '15:00', crew_id: verde, duration_min: 120, frequency: 'weekly', force: true });
  let series = (await ana.ok('GET', `/api/jobs?client_id=${lead2.client_id}`)).filter((j) => j.series_id && j.status === 'scheduled');
  check(series.length === 6 && series.map((j) => j.local_date).join() === [0, 7, 14, 21, 28, 35].map((n) => TZ.addDays(first, n)).join(), 'recorrência semanal gera as próximas visitas');
  await ana.ok('POST', `/api/jobs/${series[2].id}/schedule`, { date: TZ.addDays(first, 15), time: '16:00', crew_id: verde, duration_min: 120, scope: 'following', force: true });
  series = (await ana.ok('GET', `/api/jobs?client_id=${lead2.client_id}`)).filter((j) => j.series_id && j.status === 'scheduled');
  check(series[1].local_time === '15:00' && series[2].local_time === '16:00' && series[5].local_date === TZ.addDays(first, 36), '"esta e as próximas" altera somente a partir da visita escolhida');
  await ana.ok('POST', `/api/jobs/${series[0].id}/schedule`, { date: first, time: '08:00', crew_id: verde, duration_min: 120, scope: 'one', force: true });
  series = (await ana.ok('GET', `/api/jobs?client_id=${lead2.client_id}`)).filter((j) => j.series_id && j.status === 'scheduled');
  check(series[0].local_time === '08:00' && series[1].local_time === '15:00', '"somente esta" altera uma única ocorrência');

  console.log('\nPermissões e isolamento entre empresas');
  const julia = client(); await julia.login('julia@brightway.demo');
  check((await julia.call('GET', '/api/finance/summary')).status === 403, 'assistente sem permissão financeira por padrão');
  check((await julia.call('GET', `/api/clients/${lead.client_id}`)).data.invoices === null, 'assistente não recebe cobranças na ficha do cliente');
  const diego = client(); await diego.login('diego@sparklebay.demo');
  check((await diego.call('GET', `/api/clients/${lead.client_id}`)).status === 404, 'outra empresa não lê cliente alheio');
  check((await diego.call('PATCH', `/api/clients/${lead.client_id}`, { name: 'Hack' })).status === 404, 'outra empresa não altera cliente alheio');
  check((await diego.call('GET', `/api/jobs/${jobId}`)).status === 404, 'outra empresa não lê serviço alheio');
  check((await diego.call('POST', `/api/invoices/${inv.id}/payments`, { amount: 100 })).status === 404, 'outra empresa não registra pagamento em cobrança alheia');
  check(!(await diego.ok('GET', '/api/clients')).some((x) => x.name === 'Zoe Bennett'), 'listas mostram apenas dados da própria empresa');
  check((await client().call('GET', '/api/today')).status === 401, 'API exige sessão');

  console.log('\nGestão de time (somente o dono)');
  check((await julia.call('GET', '/api/team')).status === 403, 'assistente não acessa a gestão de time');
  check((await carla.call('GET', '/api/team')).status === 403, 'equipe de campo não acessa a gestão de time');
  const teamOv = await ana.ok('GET', '/api/team');
  check(teamOv.members.length === 4 && !teamOv.members.some((m) => m.role === 'owner') && teamOv.method.dimensions.length === 5, 'time lista as 4 pessoas com as 5 dimensões MAGIC');
  const carlaId = teamOv.members.find((m) => m.name === 'Carla Mendes').id;
  check((await diego.call('GET', `/api/team/members/${carlaId}`)).status === 404, 'outra empresa não vê pessoas deste time');
  const thisMonth = today.slice(0, 7);
  const badReview = await ana.call('POST', '/api/team/reviews', { user_id: carlaId, month: thisMonth, manager_scores: { M: 4, A: 4 } });
  check(badReview.status === 400, 'acompanhamento exige nota em todas as dimensões');
  await ana.ok('POST', '/api/team/reviews', { user_id: carlaId, month: thisMonth, manager_scores: { M: 4, A: 5, G: 3, I: 4, C: 4 }, self_scores: { M: 4, A: 3, G: 1, I: 4, C: 4 }, agreements: 'Teste' });
  await ana.ok('POST', '/api/team/reviews', { user_id: carlaId, month: thisMonth, manager_scores: { M: 4, A: 5, G: 3, I: 4, C: 4 }, self_scores: { M: 4, A: 3, G: 1, I: 4, C: 4 }, agreements: 'Atualizado' });
  let cm = await ana.ok('GET', `/api/team/members/${carlaId}`);
  check(cm.reviews.filter((r) => r.month === thisMonth).length === 1 && cm.review.agreements === 'Atualizado', 'um acompanhamento por pessoa por mês (atualiza em vez de duplicar)');
  check(cm.flags.some((f) => /divergentes/.test(f.text)), 'sinaliza diferença entre a visão do dono e a do colaborador');
  check(cm.metrics.hours >= 3 && cm.metrics.kind === 'field', 'indicadores do mês vêm da operação (horas registradas)');
  const g = await ana.ok('POST', '/api/team/pdi', { user_id: carlaId, title: 'Meta teste', dimension: 'G', due_date: TZ.addDays(today, 10) });
  await ana.ok('PATCH', `/api/team/pdi/${g.id}`, { status: 'done' });
  cm = await ana.ok('GET', `/api/team/members/${carlaId}`);
  const pdiRule = cm.suggestions.find((s) => /PDI/.test(s.name));
  check(pdiRule && pdiRule.ok === true, 'meta de PDI concluída torna a pessoa elegível à premiação');
  const ratingRule = cm.suggestions.find((s) => /Nota/.test(s.name));
  const notOk = cm.suggestions.find((s) => s.ok !== true);
  if (notOk) check((await ana.call('POST', '/api/team/bonuses', { user_id: carlaId, month: thisMonth, rule_id: notOk.rule_id })).status === 400, 'não aprova premiação sem o critério atingido');
  void ratingRule;
  const bon = await ana.ok('POST', '/api/team/bonuses', { user_id: carlaId, month: thisMonth, rule_id: pdiRule.rule_id });
  const bon2 = await ana.ok('POST', '/api/team/bonuses', { user_id: carlaId, month: thisMonth, rule_id: pdiRule.rule_id });
  check(bon2.duplicate && bon2.id === bon.id, 'a mesma regra não gera premiação duplicada no mês');
  const finBefore = await ana.ok('GET', '/api/finance/summary');
  await ana.ok('POST', `/api/team/bonuses/${bon.id}/pay`, { paid_date: today });
  await ana.ok('POST', `/api/team/bonuses/${bon.id}/pay`, { paid_date: today });
  const finAfter = await ana.ok('GET', '/api/finance/summary');
  check(finAfter.expenses.total - finBefore.expenses.total === 2500 && finAfter.expenses.items.some((e) => e.category === 'Bônus e premiações'), 'premiação paga entra uma única vez como despesa no Financeiro');
  const rep = await ana.ok('GET', '/api/team/report');
  check(rep.people.length === 4 && rep.totals.bonuses_paid >= 2500, 'relatório mensal do time consolida acompanhamentos, PDI e premiações');

  console.log('\nPersistência após reinício');
  await stop(); await start();
  const ana2 = client(); await ana2.login('ana@brightway.demo');
  const after = await ana2.ok('GET', `/api/clients/${lead.client_id}`);
  check(after.invoices.some((i) => i.id === inv.id && i.status === 'paid') && after.history.length === c.history.length, 'dados persistem após reiniciar o servidor');

  console.log(`\n${passed} verificações passaram.`);
  await stop();
  if (!process.env.KEEP) for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
})().catch(async (e) => {
  console.error('\n' + e.message, DB);
  if (server) await stop().catch(() => {});
  process.exit(1);
});
