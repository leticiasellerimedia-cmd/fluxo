// Tarefas, jornadas/automações e configurações.
/* global S, ACT, FORMS, html, val, GET, POST, PATCH, routeDef, money, parseMoney, centsToInput, fmtDate, fmtDT, badge, MSG_STATUS, TASK_TYPE, CH, CAT, ROLE, empty, modal, closeModal, refresh, run, safe, go, icon, opts, staffOpts, userOpts, todayStr, showFormError, TZ, demoNote, R, setQuery, toast, formData, I18N_LOCALES */

// ---------- Tarefas ----------
async function viewTasks({ query }) {
  const status = query.status || 'open';
  const assignee = query.resp || '';
  const list = await GET(`/api/tasks?status=${status}${assignee ? `&assignee_id=${assignee}` : ''}`);
  const field = S.me.user.role === 'field';
  return {
    title: 'Tarefas',
    html: html`<div class="page-head"><div><h1>Tarefas</h1><div class="sub">Toda tarefa tem responsável, prazo e status.</div></div>
      ${S.me.perms.tasks ? html`<div class="btn-group"><button class="btn primary" data-act="new-task">${icon('plus')} Nova tarefa</button></div>` : ''}</div>
      <div class="cal-toolbar"><div class="seg"><button class="${status === 'open' ? 'active' : ''}" data-act="task-filter" data-k="status" data-v="open">Abertas</button><button class="${status === 'done' ? 'active' : ''}" data-act="task-filter" data-k="status" data-v="done">Concluídas</button></div>
        ${!field ? html`<select data-act-change="task-resp" style="width:auto" aria-label="Responsável">${opts(S.meta.users.map((u) => [u.id, u.name]), assignee, { blank: 'Todos os responsáveis' })}</select>` : ''}</div>
      <div class="card">${list.length ? html`<div class="list">${list.map(R.task)}</div>` : empty(status === 'open' ? 'Nenhuma tarefa aberta' : 'Nenhuma tarefa concluída')}</div>`,
    after(el) { const s = el.querySelector('[data-act-change=task-resp]'); if (s) s.addEventListener('change', () => setQuery({ resp: s.value })); },
  };
}
ACT['task-filter'] = (el) => setQuery({ [el.dataset.k]: el.dataset.v });
ACT['new-task'] = async (el) => {
  const clients = await GET('/api/clients');
  modal({ title: 'Nova tarefa', body: html`<form class="form" data-form="task" novalidate>
    <div class="field"><label class="req">O que precisa ser feito</label><input name="title" type="text"></div>
    <div class="form-row"><div class="field"><label class="req">Responsável</label><select name="assignee_id">${userOpts(S.me.user.id)}</select></div>
      <div class="field"><label class="req">Prazo</label><input name="due_date" type="date" value="${todayStr()}"></div></div>
    <div class="form-row"><div class="field"><label>Cliente</label><select name="client_id">${opts(clients.map((c) => [c.id, c.name]), el.dataset.client || '', { blank: 'Nenhum' })}</select></div>
      <div class="field"><label>Prioridade</label><select name="priority">${opts([['normal', 'Normal'], ['high', 'Alta'], ['low', 'Baixa']], 'normal')}</select></div></div>
    <button type="button" class="reveal" data-act="reveal" data-target="task-more">+ Descrição</button>
    <div id="task-more" class="hidden"><div class="field"><label>Descrição</label><textarea name="description"></textarea></div></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Criar tarefa</button></div></form>` });
};
FORMS.task = async (form, d) => { if (!d.title.trim()) return showFormError(form, 'Descreva a tarefa.'); await run(() => POST('/api/tasks', d), { form, ok: 'Tarefa criada.' }); closeModal(); refresh(); };

// ---------- Jornadas ----------
async function viewJourneys() {
  const list = await GET('/api/journeys');
  const cat = S.meta.automation;
  return {
    title: 'Jornadas',
    html: html`<div class="page-head"><div><h1>Jornadas do cliente</h1><div class="sub">Sequências automáticas, prontas e editáveis.</div></div>
      <div class="btn-group"><button class="btn" data-act="run-queue">Processar fila agora</button></div></div>
      ${demoNote('Os envios são simulados e registrados no histórico do cliente. E-mail, SMS e WhatsApp ainda não estão conectados (veja Configurações › Integrações).')}
      <div class="card card-pad mt"><div class="section-title">Regras obrigatórias (sempre aplicadas pelo sistema)</div>
        <div class="grid grid-2" style="gap:6px 20px">${cat.mandatory_rules.map((r) => html`<div class="small row top">${icon('check')}<span>${r}</span></div>`)}</div></div>
      <div class="grid grid-2 mt">${list.map((j) => html`<a class="card card-pad stack" href="#/jornadas/${j.id}" style="color:inherit;text-decoration:none">
        <div class="row between top"><div><h3>${j.name}</h3><div class="small muted">${j.description}</div></div>${j.active ? html`<span class="badge ok">ativa</span>` : html`<span class="badge">desativada</span>`}</div>
        <div class="row wrap">${badge(CAT, j.category)}<span class="badge">Gatilho: ${j.triggers.map((x) => cat.events[x]).join(' / ')}</span><span class="badge">${j.steps.length} etapa(s)</span></div>
        <div class="row wrap small muted"><span>${j.stats.pending} agendada(s)</span>·<span>${j.stats.sent} enviada(s)</span>·<span>${j.stats.active} ativa(s)</span>${j.stats.paused ? html`·<span style="color:var(--warn)">${j.stats.paused} pausada(s)</span>` : ''}${j.stats.blocked ? html`·<span style="color:var(--danger)">${j.stats.blocked} bloqueada(s)</span>` : ''}</div></a>`)}</div>`,
  };
}
ACT['run-queue'] = (el) => safe(run(async () => { const r = await POST('/api/automation/run'); toast(`${r.processed} etapa(s) vencida(s) processada(s), ${r.sent} enviada(s) em simulação.`); refresh(); }, { btn: el }));

function offsetParts(min) {
  const abs = Math.abs(min); const unit = abs % 1440 === 0 && abs ? 'd' : abs % 60 === 0 ? 'h' : 'm';
  const n = unit === 'd' ? abs / 1440 : unit === 'h' ? abs / 60 : abs;
  return { n, unit, dir: min < 0 ? 'before' : 'after' };
}
function stepEditor(s, i, cat) {
  const o = offsetParts(s.offset_minutes);
  return html`<div class="step-card" data-step>
    <div class="row between"><strong>Etapa ${i + 1}</strong><button type="button" class="btn ghost sm" data-act="rm-step">Remover</button></div>
    <div class="form-row three">
      <div class="field"><label>Prazo</label><div class="row"><input type="number" name="n" min="0" value="${o.n}" style="width:80px"><select name="unit">${opts([['m', 'minutos'], ['h', 'horas'], ['d', 'dias']], o.unit)}</select></div></div>
      <div class="field"><label>Quando</label><select name="dir">${opts([['after', 'depois de'], ['before', 'antes de']], o.dir)}</select></div>
      <div class="field"><label>Referência</label><select name="anchor">${opts(Object.entries(cat.anchors), s.anchor)}</select></div></div>
    <div class="form-row"><div class="field"><label>Horário de envio</label><select name="send_hour">${opts([['', 'Exato (sem ajuste)'], ...[7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((h) => [h, `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'} (horário da empresa)`])], s.send_hour ?? '')}</select></div>
      <div class="field"><label>Canal</label><select name="channel">${opts(Object.entries(cat.channels), s.channel)}</select></div></div>
    <div class="field"><label>Assunto (e-mail)</label><input type="text" name="subject" value="${s.subject || ''}"></div>
    <div class="field"><label>Mensagem</label><textarea name="body">${s.body}</textarea></div></div>`;
}
let jTab = 'config';
async function viewJourney({ params, query }) {
  const j = await GET(`/api/journeys/${params.id}`);
  if (query.tab) jTab = query.tab;
  const cat = S.meta.automation;
  const LOG = { enrolled: 'info', message_sent: 'ok', message_blocked: 'danger', stopped: 'danger', paused: 'warn', held: 'warn', resumed: 'info', completed: 'ok', skipped: '', rescheduled: 'info', message_canceled: '', edited: '', forced: 'warn' };
  const pending = j.queue.filter((m) => m.status === 'pending');
  const bodies = {
    config: () => html`<form class="form" data-form="journey" data-id="${j.id}" novalidate>
      <div class="card card-pad form">
        <div class="form-row"><div class="field"><label>Nome</label><input type="text" name="name" value="${j.name}"></div>
          <div class="field"><label>Responsável pelo acompanhamento</label><select name="owner_id">${staffOpts(j.owner_id)}</select></div></div>
        <label class="check"><input type="checkbox" name="active" ${j.active ? 'checked' : ''}> Jornada ativa (novos eventos geram inscrições)</label>
        <div class="field"><label>Evento que inicia a sequência</label><div class="row wrap">${j.triggers.map((x) => html`<span class="badge info">${cat.events[x]}</span>`)}</div><div class="help">O gatilho é fixo nos modelos desta versão.</div></div>
        <div class="field"><label>Condições para execução</label><div class="stack tight">${Object.entries(cat.conditions).map(([k, l]) => html`<label class="check"><input type="checkbox" name="conditions" value="${k}" data-multi="1" ${j.conditions.includes(k) ? 'checked' : ''}> ${l}</label>`)}</div><div class="help">Verificadas na inscrição e de novo no momento de cada envio.</div></div>
        <div class="field"><label>Regras de pausa e encerramento</label>
          <label class="check"><input type="checkbox" name="pause_on_reply" ${j.rules.pause_on_reply ? 'checked' : ''}> Pausar quando o cliente responder e criar tarefa de atendimento</label>
          <div class="help">Além das regras obrigatórias, que não podem ser desligadas.</div></div>
      </div>
      <div class="stack" id="steps">${j.steps.map((s, i) => stepEditor(s, i, cat))}</div>
      <div class="row wrap"><button type="button" class="btn sm" data-act="add-step">${icon('plus')} Adicionar etapa</button>
        <span class="small muted placeholders">Variáveis: ${['cliente_primeiro_nome', 'cliente', 'empresa', 'data_servico', 'hora_servico', 'endereco', 'equipe', 'orcamento_numero', 'orcamento_valor', 'link_orcamento', 'cobranca_numero', 'valor_aberto', 'vencimento'].map((v) => html`<code>{{${v}}}</code> `)}</span></div>
      <div class="callout info small">Alterações valem para novas inscrições. Mensagens já agendadas mantêm o conteúdo da época da inscrição.</div>
      <div class="form-actions"><button class="btn primary" type="submit">Salvar jornada</button></div></form>`,
    queue: () => html`<div class="card">${j.queue.length ? html`<div class="table-wrap"><table class="table responsive"><thead><tr><th>Cliente</th><th>Etapa</th><th>Envio</th><th>Status</th><th></th></tr></thead><tbody>
      ${j.queue.map((m) => html`<tr><td data-l="Cliente"><a href="#/clientes/${m.client_id}">${m.client_name}</a></td><td data-l="Etapa">${m.step_index + 1} · ${CH[m.channel]}</td><td data-l="Envio" class="nowrap">${fmtDT(m.send_at)}</td>
        <td data-l="Status">${badge(MSG_STATUS, m.status)}${m.hold_reason && m.status === 'pending' ? html`<div class="small muted">Aguardando: ${m.hold_reason}</div>` : m.status_reason ? html`<div class="small muted">${m.status_reason}</div>` : ''}${m.enrollment_status === 'paused' && m.status === 'pending' ? html`<div class="small" style="color:var(--warn)">Sequência pausada</div>` : ''}</td>
        <td class="right">${m.status === 'pending' ? html`<div class="btn-group" style="justify-content:flex-end"><button class="btn sm" data-act="send-now" data-id="${m.id}">Enviar agora (simulação)</button>${m.enrollment_status === 'active' ? html`<button class="btn sm" data-act="enr" data-op="pause" data-id="${m.enrollment_id}">Pausar</button>` : html`<button class="btn sm" data-act="enr" data-op="resume" data-id="${m.enrollment_id}">Retomar</button>`}</div>` : ''}</td></tr>`)}</tbody></table></div>` : empty('Nenhuma mensagem nesta jornada ainda')}</div>`,
    log: () => html`<div class="card card-pad">${j.log.length ? html`<div class="timeline">${j.log.map((l) => html`<div class="tl-item ${LOG[l.action] || ''}"><span class="tl-dot"></span><div><div>${l.client_name ? html`<a href="#/clientes/${l.client_id}">${l.client_name}</a>: ` : ''}${l.details}</div><div class="small muted">${fmtDT(l.created_at)} · ${l.user}</div></div></div>`)}</div>` : empty('Sem ações registradas')}</div>`,
  };
  return {
    title: j.name,
    html: html`<div class="crumbs"><a href="#/jornadas">Jornadas</a> / ${j.name}</div>
      <div class="page-head"><div><h1>${j.name}</h1><div class="sub">${j.description}</div><div class="row wrap mt">${badge(CAT, j.category)}${j.active ? html`<span class="badge ok">ativa</span>` : html`<span class="badge">desativada</span>`}<span class="badge demo">envios simulados</span></div></div></div>
      <div class="tabs">${[['config', 'Configuração'], ['queue', `Fila (${pending.length} agendada${pending.length === 1 ? '' : 's'})`], ['log', 'Histórico de ações']].map(([k, l]) => html`<button class="tab ${jTab === k ? 'active' : ''}" data-act="j-tab" data-k="${k}">${l}</button>`)}</div>
      ${bodies[jTab]()}`,
  };
}
ACT['j-tab'] = (el) => { jTab = el.dataset.k; refresh(); };
ACT['send-now'] = (el) => safe(run(async () => { const r = await POST(`/api/scheduled-messages/${el.dataset.id}/send-now`); toast({ sent: 'Mensagem enviada em simulação e registrada no histórico do cliente.', held: `Não enviada: ${r.reason}.`, blocked: `Bloqueada: ${r.reason}.`, canceled: 'Etapa cancelada pelas regras da jornada.' }[r.outcome], r.outcome === 'sent' ? '' : 'error'); refresh(); }, { btn: el }));
ACT['add-step'] = () => { const box = document.getElementById('steps'); if (box.children.length >= 8) return toast('Máximo de 8 etapas.', 'error'); box.insertAdjacentHTML('beforeend', val(stepEditor({ anchor: 'event', offset_minutes: 1440, send_hour: 10, channel: 'sms', subject: '', body: 'Hi {{cliente_primeiro_nome}}, ' }, box.children.length, S.meta.automation))); };
ACT['rm-step'] = (el) => { const box = document.getElementById('steps'); if (box.children.length <= 1) return toast('A jornada precisa de pelo menos uma etapa.', 'error'); el.closest('[data-step]').remove(); };
FORMS.journey = async (form, d) => {
  const mult = { m: 1, h: 60, d: 1440 };
  const steps = [...form.querySelectorAll('[data-step]')].map((s) => {
    const g = (n) => s.querySelector(`[name=${n}]`).value;
    const mins = Number(g('n')) * mult[g('unit')] * (g('dir') === 'before' ? -1 : 1);
    return { anchor: g('anchor'), offset_minutes: mins, send_hour: g('send_hour'), channel: g('channel'), subject: g('subject'), body: g('body') };
  });
  if (steps.some((s) => !s.body.trim())) return showFormError(form, 'Todas as etapas precisam de uma mensagem.');
  if (steps.some((s) => s.anchor === 'event' && s.offset_minutes < 0)) return showFormError(form, 'Etapas baseadas no momento do evento só podem ser "depois de".');
  await run(() => PATCH(`/api/journeys/${form.dataset.id}`, { name: d.name, owner_id: d.owner_id, active: d.active, conditions: d.conditions || [], rules: { pause_on_reply: d.pause_on_reply }, steps }), { form, ok: 'Jornada salva.' });
  refresh();
};

// ---------- Configurações ----------
const TZS = [['America/New_York', 'Eastern (New York, Miami, Orlando)'], ['America/Chicago', 'Central (Chicago, Houston, Dallas)'], ['America/Denver', 'Mountain (Denver)'], ['America/Phoenix', 'Arizona (Phoenix, sem horário de verão)'], ['America/Los_Angeles', 'Pacific (Los Angeles, San Francisco)'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii']];
const PERM_LABEL = { clients: 'Clientes', sales: 'Comercial e orçamentos', schedule: 'Agenda', tasks: 'Tarefas', journeys: 'Jornadas', finance: 'Financeiro' };
async function viewSettings() {
  const s = await GET('/api/settings');
  return {
    title: 'Configurações',
    html: html`<div class="page-head"><div><h1>Configurações</h1></div></div>
      <div class="grid grid-2">
        <form class="card card-pad form" data-form="company" novalidate><h2>Empresa</h2>
          <div class="field"><label>Nome</label><input type="text" name="name" value="${s.company.name}"></div>
          <div class="form-row"><div class="field"><label>Telefone</label><input type="tel" name="phone" value="${s.company.phone || ''}"></div><div class="field"><label>E-mail</label><input type="email" name="email" value="${s.company.email || ''}"></div></div>
          <div class="field"><label>Fuso horário</label><select name="timezone">${opts(TZS, s.company.timezone)}</select><div class="help">Usado em agenda, lembretes, vencimentos e "hoje".</div></div>
          <div class="field"><label>Idioma da interface</label><select name="locale">${opts(I18N_LOCALES.map((l) => [l.code, `${l.label} (${l.status})`]), s.company.locale)}</select><div class="help">Moeda: USD. Datas: MM/DD/YYYY.</div></div>
          <div class="form-actions"><button class="btn primary" type="submit">Salvar</button></div></form>
        <div class="card card-pad stack"><h2>Integrações</h2>
          ${s.integrations.map((i) => html`<div class="row between top" style="border-bottom:1px solid var(--border);padding-bottom:10px"><div><strong>${i.label}</strong><div class="small muted">Sugestão: ${i.suggested}</div></div><span class="badge demo">${i.status} · simulação</span></div>`)}
          <p class="small muted">Os pontos de integração estão preparados no servidor (server/integrations.js e o endpoint de webhook). Conectar um provedor exige contas e credenciais da empresa.</p></div>
      </div>
      <div class="card mt-lg"><div class="card-head"><h2>Usuários e permissões</h2><span class="small muted">Permissões aplicadas no servidor</span></div>
        <div class="list">${s.users.map((u) => html`<div class="list-item" style="align-items:flex-start;flex-wrap:wrap">
          <div class="grow" style="min-width:200px"><div class="title">${u.name}</div><div class="meta">${u.email} · ${ROLE[u.role]}${u.crew_id ? ` · ${s.crews.find((c) => c.id === u.crew_id)?.name}` : ''}</div></div>
          ${u.role === 'assistant' ? html`<div class="row wrap" style="gap:12px">${s.assistant_toggles.map((k) => html`<label class="check small"><input type="checkbox" data-act="perm" data-user="${u.id}" data-k="${k}" ${u.permissions[k] ? 'checked' : ''}> ${PERM_LABEL[k]}</label>`)}</div>` : ''}
          ${u.role === 'field' ? html`<form class="row" data-form="hourly" data-id="${u.id}" novalidate><label class="small muted" for="hc-${u.id}">Custo/hora (US$)</label><input id="hc-${u.id}" name="hourly_cost" type="text" inputmode="decimal" value="${centsToInput(u.hourly_cost)}" style="width:100px">${!u.hourly_cost ? html`<span class="badge warn">não configurado</span>` : ''}<button class="btn sm" type="submit">Salvar</button></form>` : ''}
          ${u.role === 'owner' ? html`<span class="badge">acesso geral</span>` : ''}
          ${u.role === 'field' ? html`<span class="small muted" style="width:100%">Vê apenas os serviços da sua equipe, instruções e registro da execução. Sem acesso a valores ou financeiro.</span>` : ''}</div>`)}</div></div>
      ${S.me.company.demo ? html`<div class="card card-pad mt-lg stack"><h2>Dados de demonstração</h2><p class="small muted">Recria a empresa fictícia com clientes e serviços em diferentes etapas. Apaga tudo o que foi registrado durante os testes.</p><div><button class="btn danger" data-act="reset-demo">Restaurar dados de demonstração</button></div></div>` : ''}`,
  };
}
FORMS.company = async (form, d) => { await run(() => PATCH('/api/settings/company', d), { form, ok: 'Configurações salvas.' }); await window.loadSessionPublic(); location.reload(); };
FORMS.hourly = async (form, d) => { const c = parseMoney(d.hourly_cost); if (c === null || Number.isNaN(c)) return showFormError(form, 'Valor inválido.'); await run(() => PATCH(`/api/settings/users/${form.dataset.id}`, { hourly_cost: c }), { form, ok: 'Custo/hora salvo. Vale para novos registros de horas.' }); refresh(); };
ACT.perm = (el) => safe(run(() => PATCH(`/api/settings/users/${el.dataset.user}`, { permissions: { [el.dataset.k]: el.checked } }), { ok: 'Permissão atualizada.' }).catch(() => { el.checked = !el.checked; }));
ACT['reset-demo'] = (el) => { if (!confirm('Restaurar os dados de demonstração? Tudo o que foi registrado nos testes será apagado.')) return; safe(run(async () => { await POST('/api/demo/reset'); location.hash = '#/entrar'; location.reload(); }, { btn: el })); };

routeDef('/tarefas', viewTasks, { perm: ['tasks', 'field'] });
routeDef('/jornadas', viewJourneys, { perm: ['journeys'] });
routeDef('/jornadas/:id', viewJourney, { perm: ['journeys'] });
routeDef('/config', viewSettings, { perm: ['settings'] });
void money; void fmtDate; void TASK_TYPE; void go; void TZ; void formData;
