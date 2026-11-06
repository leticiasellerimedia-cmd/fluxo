// Agenda (dia/semana), agendamento com verificação de conflitos, execução e custos.
/* global S, ACT, FORMS, html, val, GET, POST, PATCH, routeDef, money, parseMoney, centsToInput, fmtDate, fmtDay, fmtDayLong, fmtTime, fmtTimeStr, fmtDT, badge, JOB_STATUS, INV_STATUS, MSG_STATUS, CH, FREQ, empty, modal, closeModal, refresh, run, safe, go, icon, opts, crewOpts, todayStr, showFormError, TZ, demoNote, localDateOf, durationLabel, hours, setQuery, R, toast, formData, userOpts */

const DURATIONS = [60, 90, 120, 150, 180, 210, 240, 300, 360, 480].map((m) => [m, durationLabel(m)]);

async function viewSchedule({ query }) {
  const view = query.v || (window.innerWidth < 860 ? 'dia' : 'semana');
  const day = TZ.isDate(query.d) ? query.d : todayStr();
  const crew = query.equipe || '';
  const tz = S.me.company.timezone;
  const from = view === 'semana' ? TZ.startOfWeek(day) : day;
  const days = view === 'semana' ? 7 : 1;
  const range = [TZ.toUtc(from, '00:00', tz), TZ.toUtc(TZ.addDays(from, days), '00:00', tz)];
  const [jobs, pending] = await Promise.all([
    GET(`/api/jobs?from=${range[0]}&to=${range[1]}`),
    S.me.perms.schedule ? GET('/api/jobs?status=pending_schedule') : Promise.resolve([]),
  ]);
  const list = jobs.filter((j) => j.status !== 'pending_schedule' && (!crew || String(j.crew_id) === crew));
  const step = view === 'semana' ? 7 : 1;
  const chip = (j) => html`<a class="chip ${j.conflicts && j.conflicts.length ? 'conflict' : ''} ${j.status === 'completed' ? 'done' : ''} ${j.status === 'canceled' ? 'canceled' : ''}" style="--c:${j.crew_color || '#94a3b8'}" href="#/servicos/${j.id}">
    <div class="t">${fmtTime(j.start_at)} · ${j.client_name}</div><div class="muted">${j.crew_name || 'sem equipe'} · ${durationLabel(j.duration_min)}</div>
    ${j.conflicts && j.conflicts.length ? html`<div style="color:var(--danger-strong);font-weight:600">Conflito de horário</div>` : ''}${j.status !== 'scheduled' ? html`<div>${JOB_STATUS[j.status][0]}</div>` : ''}</a>`;
  let body;
  if (view === 'semana') {
    body = html`<div class="week">${[...Array(7)].map((_, i) => {
      const d = TZ.addDays(from, i);
      const dj = list.filter((j) => localDateOf(j.start_at) === d);
      return html`<div class="day-col ${d === todayStr() ? 'today' : ''} ${dj.length ? '' : 'empty-day'}"><div class="day-head"><span>${fmtDay(d)}</span><span class="muted">${dj.length || ''}</span></div><div class="day-body">${dj.length ? dj.map(chip) : html`<div class="small muted" style="padding:4px">Livre</div>`}</div></div>`;
    })}</div>${!list.length ? html`<div class="card mt">${empty('Nenhum serviço nesta semana')}</div>` : ''}`;
  } else {
    const crews = S.meta.crews.filter((c) => !crew || String(c.id) === crew);
    body = html`<div class="crew-cols">${crews.map((c) => {
      const cj = list.filter((j) => j.crew_id === c.id);
      return html`<div class="card"><div class="card-head"><h3><span class="dot" style="background:${c.color}"></span> ${c.name}</h3><span class="small muted">${cj.length} serviço(s) · ${durationLabel(cj.reduce((s, j) => s + j.duration_min, 0) || 0)}</span></div>
        <div class="card-body stack tight">${cj.length ? cj.map((j) => html`<a class="job-card" style="--c:${c.color}" href="#/servicos/${j.id}"><div class="row between"><strong>${fmtTime(j.start_at)} - ${fmtTime(new Date(Date.parse(j.start_at) + j.duration_min * 60000).toISOString())}</strong>${badge(JOB_STATUS, j.status)}</div><div>${j.client_name} · ${j.title}</div><div class="small muted">${j.line1 || ''}${j.city ? `, ${j.city}` : ''}</div>${j.conflicts && j.conflicts.length ? html`<span class="badge danger">conflito de horário</span>` : ''}</a>`) : html`<div class="small muted">Sem serviços neste dia.</div>`}</div></div>`;
    })}</div>`;
  }
  return {
    title: 'Agenda',
    html: html`<div class="page-head"><div><h1>Agenda</h1><div class="sub">${view === 'semana' ? `Semana de ${fmtDate(from)} a ${fmtDate(TZ.addDays(from, 6))}` : fmtDayLong(day)} · fuso ${tz}</div></div>
      ${S.me.perms.schedule ? html`<div class="btn-group"><button class="btn" data-act="new-job">${icon('plus')} Serviço sem orçamento</button></div>` : ''}</div>
      ${pending.length ? html`<div class="card mb"><div class="card-head"><h2>Aguardando agendamento <span class="muted">(${pending.length})</span></h2><span class="small muted">Confirme a data com o cliente antes de agendar</span></div>
        <div class="list">${pending.map((j) => html`<div class="list-item"><div class="grow"><a class="title" href="#/servicos/${j.id}">${j.client_name}</a><div class="meta">${j.title} · ${FREQ[j.requested_frequency]}${j.price != null ? ` · ${money(j.price)}` : ''}</div></div><button class="btn sm primary" data-act="schedule" data-id="${j.id}">Agendar</button></div>`)}</div></div>` : ''}
      <div class="cal-toolbar">
        <div class="seg"><button data-act="cal-nav" data-d="${TZ.addDays(day, -step)}" aria-label="Anterior">${icon('chevL')}</button><button data-act="cal-nav" data-d="${todayStr()}">Hoje</button><button data-act="cal-nav" data-d="${TZ.addDays(day, step)}" aria-label="Próximo">${icon('chevR')}</button></div>
        <div class="seg"><button class="${view === 'dia' ? 'active' : ''}" data-act="cal-view" data-v="dia">Dia</button><button class="${view === 'semana' ? 'active' : ''}" data-act="cal-view" data-v="semana">Semana</button></div>
        <input type="date" value="${day}" data-act-change="cal-date" style="width:auto" aria-label="Ir para data">
        ${S.me.user.role !== 'field' ? html`<select data-act-change="cal-crew" style="width:auto" aria-label="Filtrar equipe">${opts(S.meta.crews.map((c) => [c.id, c.name]), crew, { blank: 'Todas as equipes' })}</select>` : ''}
      </div>
      ${body}`,
    after(el) {
      el.querySelector('[data-act-change=cal-date]').addEventListener('change', (e) => setQuery({ d: e.target.value }));
      const c = el.querySelector('[data-act-change=cal-crew]'); if (c) c.addEventListener('change', (e) => setQuery({ equipe: e.target.value }));
    },
  };
}
ACT['cal-nav'] = (el) => setQuery({ d: el.dataset.d });
ACT['cal-view'] = (el) => setQuery({ v: el.dataset.v });

// ---------- Agendar / reagendar ----------
ACT.schedule = async (el) => {
  const j = await GET(`/api/jobs/${el.dataset.id}`);
  const re = j.status === 'scheduled';
  const date = re ? j.local_date : TZ.addDays(todayStr(), 1);
  modal({ title: re ? 'Reagendar serviço' : 'Agendar serviço', body: html`<form class="form" data-form="schedule" data-id="${j.id}" novalidate>
    <div class="callout info small"><strong>${j.client_name}</strong> · ${j.title}${j.line1 ? ` · ${j.line1}` : ''}<br>O sistema não escolhe datas: use a data e o horário confirmados com o cliente.</div>
    <div class="form-row"><div class="field"><label class="req">Data</label><input name="date" type="date" value="${date}" min="${todayStr()}"></div>
      <div class="field"><label class="req">Horário de início</label><input name="time" type="time" value="${re ? j.local_time : '09:00'}" step="900"></div></div>
    <div class="form-row"><div class="field"><label class="req">Equipe responsável</label><select name="crew_id">${crewOpts(j.crew_id)}</select></div>
      <div class="field"><label>Duração estimada</label><select name="duration_min">${opts(DURATIONS, j.duration_min)}</select></div></div>
    ${!re ? html`<div class="field"><label>Recorrência</label><div class="radio-cards">${Object.entries(FREQ).map(([k, l]) => html`<label class="radio-card"><input type="radio" name="frequency" value="${k}" ${j.requested_frequency === k ? 'checked' : ''}>${l}</label>`)}</div>
      ${j.requested_frequency !== 'one_time' ? html`<div class="help">O orçamento aprovado propôs frequência ${FREQ[j.requested_frequency].toLowerCase()}.</div>` : ''}</div>` : ''}
    ${re && j.series_id ? html`<div class="field"><label>Aplicar a</label><div class="radio-cards"><label class="radio-card"><input type="radio" name="scope" value="one" checked>Somente esta visita</label><label class="radio-card"><input type="radio" name="scope" value="following">Esta e as próximas</label></div></div>` : ''}
    <div id="avail"></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">${re ? 'Salvar novo horário' : 'Agendar'}</button></div></form>` });
  const form = document.querySelector('form[data-form=schedule]');
  const check = async () => {
    const d = formData(form); const box = form.querySelector('#avail');
    if (!d.crew_id || !TZ.isDate(d.date) || !TZ.isTime(d.time)) { box.innerHTML = ''; return; }
    try {
      const tz = S.me.company.timezone;
      const [conf, dayJobs] = await Promise.all([POST(`/api/jobs/${j.id}/conflicts`, d), GET(`/api/jobs?from=${TZ.toUtc(d.date, '00:00', tz)}&to=${TZ.toUtc(TZ.addDays(d.date, 1), '00:00', tz)}`)]);
      const crewDay = dayJobs.filter((x) => String(x.crew_id) === String(d.crew_id) && x.id !== j.id && ['scheduled', 'in_progress'].includes(x.status));
      box.innerHTML = val(html`${conf.length ? html`<div class="callout danger stack tight"><strong>Conflito de horário</strong>${conf.map((c) => html`<div class="small">${fmtTime(c.start_at)} (${durationLabel(c.duration_min)}) · ${c.client_name} · ${c.title}</div>`)}
        <label class="check"><input type="checkbox" name="force"> Agendar mesmo assim (ficará sinalizado na agenda)</label></div>`
    : html`<div class="callout ok small">Equipe disponível neste horário.</div>`}
        <div class="small muted mt">Agenda da equipe em ${fmtDate(d.date)}: ${crewDay.length ? crewDay.map((x) => `${fmtTime(x.start_at)} ${x.client_name} (${durationLabel(x.duration_min)})`).join(' · ') : 'nenhum outro serviço'}</div>`);
    } catch { box.innerHTML = ''; }
  };
  form.addEventListener('change', (e) => { if (e.target.name !== 'force') check(); });
  if (re || j.crew_id) check();
};
FORMS.schedule = async (form, d) => {
  if (!d.date || !d.time) return showFormError(form, 'Informe data e horário.');
  if (!d.crew_id) return showFormError(form, 'Selecione a equipe responsável.');
  try {
    await run(() => POST(`/api/jobs/${form.dataset.id}/schedule`, { ...d, crew_id: Number(d.crew_id), duration_min: Number(d.duration_min), force: !!d.force }), { form });
    closeModal(); toast('Serviço agendado. Confirmação e lembrete programados na jornada (simulação).'); refresh();
  } catch (e) { if (e.status === 409) form.dispatchEvent(new Event('change')); }
};

// ---------- Ações do serviço ----------
ACT['job-action'] = async (el) => {
  const { id, action } = el.dataset;
  const labels = { on_the_way: 'Aviso "a caminho" enviado ao cliente (simulação).', start: 'Serviço iniciado.', complete: 'Serviço concluído. Comunicação pós-serviço programada.' };
  try {
    await run(() => POST(`/api/jobs/${id}/action`, { action }), { btn: el });
    toast(labels[action]); refresh();
  } catch (e) {
    if (e.data && e.data.needs_confirm && confirm(e.message + '\n\nConcluir mesmo assim?')) {
      await safe(run(() => POST(`/api/jobs/${id}/action`, { action, confirm: true }), { btn: el, ok: labels[action] }).then(refresh));
    }
  }
};
ACT['job-cancel'] = (el) => {
  modal({ title: 'Cancelar serviço', body: html`<form class="form" data-form="job-cancel" data-id="${el.dataset.id}" novalidate>
    <div class="callout warn small">As mensagens programadas para este serviço serão interrompidas.</div>
    <div class="field"><label class="req">Motivo</label><input name="reason" type="text" placeholder="Ex.: Cliente viajou"></div>
    ${el.dataset.series ? html`<div class="field"><label>Aplicar a</label><div class="radio-cards"><label class="radio-card"><input type="radio" name="scope" value="one" checked>Somente esta visita</label><label class="radio-card"><input type="radio" name="scope" value="following">Esta e as próximas (encerra a recorrência)</label></div></div>` : ''}
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Voltar</button><button class="btn danger" type="submit">Cancelar serviço</button></div></form>` });
};
FORMS['job-cancel'] = async (form, d) => {
  if (!d.reason.trim()) return showFormError(form, 'Informe o motivo do cancelamento.');
  const r = await run(() => POST(`/api/jobs/${form.dataset.id}/action`, { action: 'cancel', ...d }), { form });
  closeModal(); toast(r.warning || `${r.canceled} serviço(s) cancelado(s). Mensagens interrompidas.`, r.warning ? 'error' : ''); refresh();
};
ACT.check = (el) => {
  safe(run(() => POST(`/api/jobs/${el.dataset.id}/checklist`, { index: Number(el.dataset.i), done: el.checked })).then(() => el.closest('label').classList.toggle('done', el.checked)).catch(() => { el.checked = !el.checked; }));
};
ACT['add-time'] = (el) => {
  const field = S.me.user.role === 'field';
  modal({ title: 'Registrar horas', body: html`<form class="form" data-form="time" data-id="${el.dataset.id}" novalidate>
    <div class="form-row"><div class="field"><label class="req">Horas trabalhadas</label><input name="hours" type="number" min="0.25" max="24" step="0.25" placeholder="3"></div>
      <div class="field"><label>Pessoa</label><select name="user_id">${userOpts(S.me.user.id, (u) => u.role === 'field' && (!field || u.crew_id === S.me.user.crew_id))}</select></div></div>
    <div class="field"><label>Observação</label><input name="note" type="text"></div>
    ${!field ? html`<p class="small muted">O custo é calculado pelo custo/hora configurado de cada pessoa.</p>` : ''}
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Registrar</button></div></form>` });
};
FORMS.time = async (form, d) => { if (!Number(d.hours)) return showFormError(form, 'Informe as horas.'); await run(() => POST(`/api/jobs/${form.dataset.id}/time`, d), { form, ok: 'Horas registradas.' }); closeModal(); refresh(); };
ACT['add-cost'] = (el) => {
  modal({ title: 'Registrar custo direto', body: html`<form class="form" data-form="cost" data-id="${el.dataset.id}" novalidate>
    <div class="field"><label class="req">Descrição</label><input name="description" type="text" placeholder="Ex.: Produtos para forno"></div>
    <div class="form-row"><div class="field"><label class="req">Valor (US$)</label><input name="amount" type="text" inputmode="decimal"></div>
      <div class="field"><label>Categoria</label><select name="category">${opts(S.meta.expense_categories.map((c) => [c, c]), 'Produtos de limpeza')}</select></div></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Registrar</button></div></form>` });
};
FORMS.cost = async (form, d) => {
  const amount = parseMoney(d.amount); if (!amount || amount <= 0) return showFormError(form, 'Informe um valor válido.');
  await run(() => POST(`/api/jobs/${form.dataset.id}/costs`, { ...d, amount }), { form, ok: 'Custo registrado no serviço.' }); closeModal(); refresh();
};
ACT['costs-complete'] = (el) => safe(run(async () => { await POST(`/api/jobs/${el.dataset.id}/costs-complete`, { complete: el.dataset.v === '1' }); refresh(); }, { btn: el, ok: 'Situação dos custos atualizada.' }));
ACT['job-invoice'] = (el) => safe(run(async () => { const r = await POST(`/api/jobs/${el.dataset.id}/invoice`); toast(r.duplicate ? 'A cobrança deste serviço já existia; nenhuma cobrança duplicada foi criada.' : 'Cobrança gerada conforme o combinado. Lembretes de pagamento programados.'); go(`#/cobrancas/${r.id}`); }, { btn: el }));
ACT['edit-job'] = async (el) => {
  const j = await GET(`/api/jobs/${el.dataset.id}`);
  modal({ title: 'Instruções e checklist', wide: true, body: html`<form class="form" data-form="edit-job" data-id="${j.id}" novalidate>
    <div class="field"><label>Instruções para a equipe</label><textarea name="instructions">${j.instructions || ''}</textarea></div>
    <div class="field"><label>Checklist (um item por linha)</label><textarea name="checklist" style="min-height:160px">${j.checklist.map((c) => c.text).join('\n')}</textarea></div>
    ${S.me.perms.finance && j.status !== 'completed' ? html`<div class="field"><label>Valor contratado (US$)</label><input name="price" type="text" inputmode="decimal" value="${centsToInput(j.price)}"></div>` : ''}
    ${j.series_id ? html`<div class="field"><label>Aplicar a</label><div class="radio-cards"><label class="radio-card"><input type="radio" name="scope" value="one" checked>Somente esta visita</label><label class="radio-card"><input type="radio" name="scope" value="following">Esta e as próximas</label></div></div>` : ''}
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Salvar</button></div></form>` });
};
FORMS['edit-job'] = async (form, d) => {
  const j = await GET(`/api/jobs/${form.dataset.id}`);
  const prev = Object.fromEntries(j.checklist.map((c) => [c.text, c.done]));
  const body = { instructions: d.instructions, checklist: d.checklist.split('\n').map((s) => s.trim()).filter(Boolean).map((text) => ({ text, done: !!prev[text] })), scope: d.scope };
  if ('price' in d) { const p = parseMoney(d.price); if (p === null || Number.isNaN(p)) return showFormError(form, 'Valor inválido.'); body.price = p; }
  await run(() => PATCH(`/api/jobs/${form.dataset.id}`, body), { form, ok: 'Serviço atualizado.' }); closeModal(); refresh();
};
ACT['new-job'] = async () => {
  const clients = await GET('/api/clients');
  modal({ title: 'Serviço sem orçamento', body: html`<form class="form" data-form="new-job" novalidate>
    <p class="small muted">Para serviços combinados diretamente (ex.: por telefone). Ficará pendente de agendamento.</p>
    <div class="field"><label class="req">Cliente</label><select name="client_id">${opts(clients.map((c) => [c.id, c.name]), '', { blank: 'Selecione' })}</select></div>
    <div class="form-row"><div class="field"><label class="req">Serviço</label><input name="title" type="text" placeholder="Standard clean"></div><div class="field"><label class="req">Valor (US$)</label><input name="price" type="text" inputmode="decimal"></div></div>
    <div class="field"><label>Instruções</label><textarea name="instructions"></textarea></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Criar serviço</button></div></form>` });
};
FORMS['new-job'] = async (form, d) => {
  const price = parseMoney(d.price); if (!d.client_id) return showFormError(form, 'Selecione o cliente.'); if (price === null || Number.isNaN(price)) return showFormError(form, 'Informe o valor.');
  const r = await run(() => POST('/api/jobs', { ...d, price }), { form, ok: 'Serviço criado. Agende quando a data estiver confirmada.' }); closeModal(); go(`#/servicos/${r.id}`);
};

// ---------- Detalhe do serviço ----------
async function viewJob({ params }) {
  const j = await GET(`/api/jobs/${params.id}`);
  const field = S.me.user.role === 'field';
  const p = S.me.perms;
  const end = j.start_at ? new Date(Date.parse(j.start_at) + j.duration_min * 60000).toISOString() : null;
  const finalInv = (j.invoices || []).find((i) => i.kind === 'final' && i.status !== 'void');
  const addr = [j.line1, j.line2, j.city, j.state, j.zip].filter(Boolean).join(', ');
  const btn = [];
  if (j.status === 'pending_schedule' && p.schedule) btn.push(html`<button class="btn primary" data-act="schedule" data-id="${j.id}">Agendar</button>`);
  if (j.status === 'scheduled') {
    if (!j.on_the_way_at) btn.push(html`<button class="btn" data-act="job-action" data-action="on_the_way" data-id="${j.id}">A caminho</button>`);
    btn.push(html`<button class="btn primary" data-act="job-action" data-action="start" data-id="${j.id}">Iniciar</button>`);
    if (p.schedule) btn.push(html`<button class="btn" data-act="schedule" data-id="${j.id}">Reagendar</button>`);
  }
  if (j.status === 'in_progress') btn.push(html`<button class="btn primary" data-act="job-action" data-action="complete" data-id="${j.id}">Concluir serviço</button>`);
  if (j.status === 'completed' && p.finance && !finalInv) btn.push(html`<button class="btn primary" data-act="job-invoice" data-id="${j.id}">Gerar cobrança</button>`);
  if (['pending_schedule', 'scheduled'].includes(j.status) && p.schedule) btn.push(html`<button class="btn danger" data-act="job-cancel" data-id="${j.id}" data-series="${j.series_id ? 1 : ''}">Cancelar</button>`);
  const editable = !['completed', 'canceled'].includes(j.status);
  return {
    title: `${j.client_name} · serviço`,
    html: html`<div class="crumbs"><a href="#/agenda">Agenda</a> / Serviço #${j.id}</div>
      <div class="page-head"><div><h1>${j.title}</h1><div class="sub">${field ? j.client_name : html`<a href="#/clientes/${j.client_id}">${j.client_name}</a>`}${j.quote ? html` · ${field ? j.quote.number : html`<a href="#/orcamentos/${j.quote.id}">${j.quote.number}</a>`}` : ''}</div>
        <div class="row wrap mt">${badge(JOB_STATUS, j.status)}${j.series_id ? html`<span class="badge primary">recorrência ${FREQ[j.series_frequency].toLowerCase()}${j.detached ? ' (visita alterada)' : ''}</span>` : ''}${j.on_the_way_at && j.status === 'scheduled' ? html`<span class="badge violet">equipe a caminho</span>` : ''}</div></div>
        <div class="btn-group">${btn}</div></div>
      ${j.status === 'completed' && p.finance && !finalInv ? html`<div class="callout warn mb"><strong>Serviço concluído e ainda não cobrado.</strong> Gere a cobrança conforme as condições do orçamento${j.quote ? ` (${j.quote.payment_terms.type === 'deposit' ? `depósito de ${j.quote.payment_terms.deposit_percent}% já descontado` : 'pagamento integral após a conclusão'})` : ''}.</div>` : ''}
      <div class="grid grid-side">
        <div class="stack" style="min-width:0">
          <div class="card card-pad"><dl class="kv">
            <dt>Data e horário</dt><dd>${j.start_at ? html`<strong>${fmtDayLong(j.local_date)}</strong>, ${fmtTime(j.start_at)} - ${fmtTime(end)} (${durationLabel(j.duration_min)})` : html`<span class="badge warn">Pendente de agendamento</span>`}</dd>
            <dt>Endereço</dt><dd>${addr ? html`<a href="https://maps.google.com/?q=${encodeURIComponent(addr)}" target="_blank" rel="noopener">${addr}</a>` : '-'}${j.access_notes ? html`<div class="small"><strong>Acesso:</strong> ${j.access_notes}</div>` : ''}</dd>
            <dt>Equipe</dt><dd>${j.crew_name || '-'}</dd>
            ${j.client && j.client.phone ? html`<dt>Telefone</dt><dd><a href="tel:${j.client.phone}">${j.client.phone}</a></dd>` : ''}
            ${j.price != null ? html`<dt>Valor contratado</dt><dd class="num"><strong>${money(j.price)}</strong></dd>` : ''}
            ${j.client && j.client.preferences ? html`<dt>Preferências</dt><dd>${j.client.preferences}</dd>` : ''}
            <dt>Instruções</dt><dd>${j.instructions || html`<span class="muted">Nenhuma instrução.</span>`}</dd></dl></div>
          <div class="card"><div class="card-head"><h2>Checklist</h2><span class="row"><span class="small muted">${j.checklist.filter((c) => c.done).length}/${j.checklist.length}</span>${!field && editable ? html`<button class="btn ghost sm" data-act="edit-job" data-id="${j.id}">Editar</button>` : ''}</span></div>
            <div class="card-body checklist stack tight" style="gap:0">${j.checklist.length ? j.checklist.map((c, i) => html`<label class="check ${c.done ? 'done' : ''}"><input type="checkbox" data-act="check" data-id="${j.id}" data-i="${i}" ${c.done ? 'checked' : ''} ${editable ? '' : 'disabled'}><span>${c.text}</span></label>`) : html`<span class="muted small">Sem itens.</span>`}</div></div>
          <div class="card"><div class="card-head"><h2>Execução: horas e custos</h2><div class="btn-group">${['scheduled', 'in_progress', 'completed'].includes(j.status) ? html`<button class="btn sm" data-act="add-time" data-id="${j.id}">Registrar horas</button><button class="btn sm" data-act="add-cost" data-id="${j.id}">Registrar custo</button>` : ''}</div></div>
            <div class="card-body stack">
              ${j.time_entries.length ? html`<table class="table"><thead><tr><th>Pessoa</th><th class="right">Horas</th>${!field ? html`<th class="right">Custo</th>` : ''}</tr></thead><tbody>${j.time_entries.map((te) => html`<tr><td>${te.user_name}${te.note ? html`<div class="small muted">${te.note}</div>` : ''}</td><td class="right num">${hours(te.hours)}</td>${!field ? html`<td class="right num">${te.cost_missing ? html`<span class="badge warn">custo/hora não configurado</span>` : money(te.cost)}</td>` : ''}</tr>`)}</tbody></table>` : html`<div class="small muted">Nenhuma hora registrada.</div>`}
              ${j.expenses.length ? html`<table class="table"><thead><tr><th>Custo direto</th><th>Categoria</th>${!field ? html`<th class="right">Valor</th>` : ''}</tr></thead><tbody>${j.expenses.map((e) => html`<tr><td>${e.description}</td><td>${e.category}</td>${!field ? html`<td class="right num">${money(e.amount)}</td>` : ''}</tr>`)}</tbody></table>` : ''}
            </div></div>
          ${!field ? html`<div class="card"><div class="card-head"><h2>Mensagens programadas</h2><a class="btn ghost sm" href="#/jornadas">Jornadas</a></div><div class="card-body">
            ${j.messages.length ? html`<div class="stack tight">${j.messages.map((m) => html`<div class="row between wrap" style="border-bottom:1px solid var(--border);padding:6px 0"><span class="small"><strong>${m.journey_name}</strong> · ${CH[m.channel]} · ${fmtDT(m.send_at)}${m.hold_reason ? html`<br><span class="muted">Aguardando: ${m.hold_reason}</span>` : m.status_reason ? html`<br><span class="muted">${m.status_reason}</span>` : ''}</span>${badge(MSG_STATUS, m.status)}</div>`)}</div>` : html`<div class="small muted">Lembretes e avisos aparecem aqui quando o serviço é agendado.</div>`}</div></div>` : ''}
        </div>
        <div class="stack">
          ${j.result ? html`<div class="card card-pad stack"><div class="section-title" style="margin:0">Resultado direto do serviço</div>
            <dl class="kv" style="grid-template-columns:1fr auto"><dt>Receita contratada</dt><dd class="right num">${money(j.result.revenue)}</dd><dt>Custos diretos registrados</dt><dd class="right num">${money(j.result.costs)}</dd>
            <dt><strong>Receita - custos diretos</strong></dt><dd class="right num"><strong>${j.result.complete ? money(j.result.result) : 'incompleto'}</strong></dd></dl>
            ${j.result.complete ? html`<div class="callout ok small">Custos confirmados. Não inclui custos gerais da empresa.</div>` : html`<div class="callout warn small"><strong>Resultado não calculado: faltam dados.</strong><br>${j.result.gaps.join('; ')}.${j.result.costs ? ` Parcial registrado: ${money(j.result.revenue - j.result.costs)}.` : ''}</div>`}
            ${p.finance && j.status === 'completed' ? (j.costs_complete ? html`<button class="btn sm" data-act="costs-complete" data-id="${j.id}" data-v="0">Marcar custos como incompletos</button>` : html`<button class="btn sm" data-act="costs-complete" data-id="${j.id}" data-v="1">Confirmar que os custos estão completos</button>`) : ''}</div>` : ''}
          ${j.invoices ? html`<div class="card card-pad"><div class="section-title">Cobranças</div>${j.invoices.length ? j.invoices.map((i) => html`<a class="list-item" style="padding:8px 0" href="#/cobrancas/${i.id}"><div class="grow"><div class="title">${i.number} · ${i.kind === 'deposit' ? 'Depósito' : 'Cobrança final'}</div><div class="meta">Vence ${fmtDate(i.due_date)} · saldo ${money(i.balance)}</div></div><div class="side stack tight" style="align-items:flex-end"><span class="num">${money(i.amount)}</span>${badge(INV_STATUS, i.status === 'void' ? 'void' : i.balance <= 0 ? 'paid' : i.due_date < todayStr() ? 'overdue' : i.status)}</div></a>`) : html`<div class="small muted">Nenhuma cobrança ainda.</div>`}</div>` : ''}
          <div class="card card-pad"><div class="section-title">Histórico</div><div class="timeline">${j.history.map(window.historyItem)}</div></div>
        </div>
      </div>`,
  };
}

routeDef('/agenda', viewSchedule, { perm: ['schedule', 'field'] });
routeDef('/servicos/:id', viewJob, { perm: ['schedule', 'field'] });
void fmtTimeStr; void demoNote; void R;
