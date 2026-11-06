// Gestão de time (somente o dono): perfil, acompanhamento MAGIC, PDI, premiações e relatórios.
/* global S, ACT, FORMS, html, GET, POST, PATCH, routeDef, money, parseMoney, centsToInput, fmtDate, fmtDT, fmtMonth, empty, modal, closeModal, refresh, run, safe, go, icon, opts, todayStr, showFormError, TZ, setQuery, toast, localDateOf, ROLE, hours */

const PDI_ST = { not_started: ['Não iniciada', ''], in_progress: ['Em andamento', 'info'], done: ['Concluída', 'ok'], canceled: ['Cancelada', ''] };
const BONUS_ST = { approved: ['Aprovada, a pagar', 'warn'], paid: ['Paga', 'ok'], canceled: ['Cancelada', ''] };
const EMP = { w2: 'Funcionário (W-2)', 1099: 'Prestador (1099)', other: 'Outro' };
const curMonth = () => todayStr().slice(0, 7);
const addMonth = (m, n) => TZ.addMonthsClamped(m + '-01', n, 1).slice(0, 7);
const b = (map, k) => { const [l, c] = map[k] || [k, '']; return html`<span class="badge ${c}">${l}</span>`; };

function monthNav(month, base) {
  return html`<div class="seg no-print"><button data-act="go" data-href="${base}?m=${addMonth(month, -1)}" aria-label="Mês anterior">${icon('chevL')}</button><button data-act="go" data-href="${base}?m=${curMonth()}">${fmtMonth(month)}</button><button data-act="go" data-href="${base}?m=${addMonth(month, 1)}" aria-label="Próximo mês" ${month >= curMonth() ? 'disabled' : ''}>${icon('chevR')}</button></div>`;
}

// Barras das dimensões: nota do gestor, comparação com o mês anterior e visão do colaborador.
function bars(method, scores, prev, self, { compact = false } = {}) {
  if (!scores) return html`<div class="small muted">Sem acompanhamento neste mês.</div>`;
  return html`<div class="mbars ${compact ? 'compact' : ''}">${method.dimensions.map((d) => {
    const s = scores[d.key]; const p = prev ? prev[d.key] : null; const me = self ? self[d.key] : null;
    const delta = p ? s - p : 0;
    return html`<div class="mbar-row"><span class="mbar-label" title="${d.question}"><strong>${d.key}</strong> ${compact ? '' : d.label}</span>
      <span class="mbar"><span class="mbar-fill tone-${s}" style="width:${s * 20}%"></span>${me ? html`<span class="mbar-self" style="left:calc(${me * 20}% - 2px)" title="Visão do colaborador: ${me}"></span>` : ''}</span>
      <span class="mbar-val num">${s}${delta ? html`<span class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${delta}</span>` : ''}</span></div>`;
  })}</div>`;
}

function metricLine(mt) {
  if (mt.kind === 'field') {
    return [`${hours(mt.hours)} trabalhadas`, `${mt.crew_jobs} serviço(s) da equipe`, mt.checklist_pct == null ? 'checklist: sem dados' : `checklist ${mt.checklist_pct}%`,
      mt.ratings_count ? `nota média ${mt.avg_rating} (${mt.ratings_count})` : 'sem notas de clientes', `${mt.complaints} reclamação(ões)`].join(' · ');
  }
  return [`${mt.tasks_done} tarefa(s) concluída(s)`, mt.tasks_on_time_pct == null ? 'no prazo: sem dados' : `${mt.tasks_on_time_pct}% no prazo`, `${mt.overdue_open} atrasada(s) agora`, `${mt.quotes_approved}/${mt.quotes_sent} orçamentos aprovados`].join(' · ');
}

// ---------- Visão do time ----------
async function viewTeam({ query }) {
  const d = await GET('/api/team' + (query.m ? `?month=${query.m}` : ''));
  const attention = d.members.flatMap((m) => m.flags.filter((f) => f.tone).map((f) => ({ ...f, m })));
  const reviewed = d.members.filter((m) => m.review);
  return {
    title: 'Time',
    html: html`<div class="page-head"><div><h1>Time</h1><div class="sub">Desenvolvimento das pessoas pelo método ${d.method.name}. Visível apenas para o dono.</div></div>
      <div class="btn-group"><a class="btn" href="#/time/regras">Regras de premiação</a><a class="btn primary" href="#/time/relatorio?m=${d.month}">Relatório mensal do time</a></div></div>
      <div class="cal-toolbar">${monthNav(d.month, '#/time')}<span class="small muted">${reviewed.length} de ${d.members.length} acompanhamento(s) registrados neste mês</span></div>
      <div class="callout info mb small"><strong>${d.method.name}:</strong> ${d.method.dimensions.map((x) => `${x.key} = ${x.label}`).join(' · ')}. Notas de 1 a 5 dadas pelo dono; o traço preto na barra mostra a visão do colaborador, quando registrada.</div>
      ${attention.length ? html`<div class="card mb"><div class="card-head"><h2>Precisa de atenção</h2><span class="small muted">${attention.length} ponto(s)</span></div><div class="list">${attention.map((a) => html`<a class="list-item" href="#/time/${a.m.id}?m=${d.month}"><span class="badge ${a.tone}">${a.m.name}</span><span class="grow">${a.text}</span>${icon('chevR')}</a>`)}</div></div>` : ''}
      <div class="grid grid-2">${d.members.map((m) => html`<a class="card card-pad stack" href="#/time/${m.id}?m=${d.month}" style="color:inherit;text-decoration:none">
        <div class="row between top"><div><h3>${m.name}</h3><div class="small muted">${m.position || ROLE[m.role]}${m.crew_name ? ` · ${m.crew_name}` : ''}</div></div>
          ${m.review ? html`<div class="right"><div class="num" style="font-size:22px;font-weight:700">${m.review.avg}</div><div class="small muted">${m.prev_avg != null ? `mês anterior ${m.prev_avg}` : 'média'}</div></div>` : html`<div class="right"><span class="badge warn">acompanhamento do mês a fazer</span>${m.latest ? html`<div class="small muted mt">último: ${fmtMonth(m.latest.month)} · média ${m.latest.avg}</div>` : ''}</div>`}</div>
        ${bars(d.method, (m.review || m.latest)?.manager_scores, null, (m.review || m.latest)?.self_scores, { compact: true })}
        <div class="small muted">${metricLine(m.metrics)}</div>
        <div class="row wrap">${m.weakest ? html`<span class="badge">ponto mais fraco: ${m.weakest}</span>` : ''}<span class="badge">${m.pdi_active} meta(s) de PDI ativa(s)</span>
          ${m.bonus_total ? html`<span class="badge ok">${money(m.bonus_total)} em premiações</span>` : ''}${m.eligible_pending ? html`<span class="badge warn">${m.eligible_pending} premiação(ões) elegível(is)</span>` : ''}</div></a>`)}</div>
      ${!d.members.length ? html`<div class="card">${empty('Nenhuma pessoa no time', 'Cadastre usuários de assistente ou equipe de campo.')}</div>` : ''}`,
  };
}

// ---------- Ficha da pessoa ----------
async function viewMember({ params, query }) {
  const d = await GET(`/api/team/members/${params.id}` + (query.m ? `?month=${query.m}` : ''));
  const m = d.member; const p = d.profile; const r = d.review; const method = d.method;
  const weakest = r ? method.dimensions.reduce((a, x) => (r.manager_scores[x.key] < r.manager_scores[a.key] ? x : a)) : null;
  const mt = d.metrics; const pm = d.prev_metrics;
  const cmp = (cur, prev, suffix = '') => (prev == null || cur == null || cur === prev ? '' : html` <span class="delta ${cur > prev ? 'up' : 'down'}">${cur > prev ? '+' : ''}${Math.round((cur - prev) * 10) / 10}${suffix}</span>`);
  const metricRows = mt.kind === 'field'
    ? [['Horas trabalhadas', `${mt.hours}h`, cmp(mt.hours, pm.hours, 'h')], ['Serviços concluídos pela equipe', mt.crew_jobs, cmp(mt.crew_jobs, pm.crew_jobs)], ['Itens do checklist concluídos', mt.checklist_pct == null ? 'sem dados' : `${mt.checklist_pct}%`, cmp(mt.checklist_pct, pm.checklist_pct, '%')],
      ['Nota média dos clientes', mt.ratings_count ? `${mt.avg_rating} (${mt.ratings_count} nota(s))` : 'sem notas no mês', cmp(mt.avg_rating, pm.avg_rating)], ['Reclamações atribuídas à equipe', mt.complaints, cmp(mt.complaints, pm.complaints)], ['Metas do PDI concluídas', mt.pdi_completed, '']]
    : [['Tarefas concluídas', mt.tasks_done, cmp(mt.tasks_done, pm.tasks_done)], ['Concluídas no prazo', mt.tasks_on_time_pct == null ? 'sem dados' : `${mt.tasks_on_time_pct}%`, cmp(mt.tasks_on_time_pct, pm.tasks_on_time_pct, '%')], ['Tarefas atrasadas agora', mt.overdue_open, ''],
      ['Orçamentos enviados', mt.quotes_sent, cmp(mt.quotes_sent, pm.quotes_sent)], ['Orçamentos aprovados', mt.quotes_approved, cmp(mt.quotes_approved, pm.quotes_approved)], ['Metas do PDI concluídas', mt.pdi_completed, '']];
  window.TEAM_CTX = d;
  return {
    title: m.name,
    html: html`<div class="crumbs"><a href="#/time?m=${d.month}">Time</a> / ${m.name}</div>
      <div class="page-head"><div><h1>${m.name}</h1><div class="sub">${p.position || ROLE[m.role]}${m.crew_name ? ` · ${m.crew_name}` : ''}${p.hire_date ? ` · desde ${fmtDate(p.hire_date)}` : ''}</div>
        <div class="row wrap mt">${d.flags.map((f) => html`<span class="badge ${f.tone}">${f.text}</span>`)}</div></div>
        <div class="btn-group"><a class="btn" href="#/time/${m.id}/relatorio?m=${d.month}">Relatório mensal</a><button class="btn primary" data-act="review" data-id="${m.id}" data-month="${d.month}">${r ? 'Editar acompanhamento' : 'Registrar acompanhamento'}</button></div></div>
      <div class="cal-toolbar">${monthNav(d.month, `#/time/${m.id}`)}${mt.partial ? html`<span class="small muted">Mês em andamento: indicadores parciais.</span>` : ''}</div>
      <div class="grid grid-side">
        <div class="stack" style="min-width:0">
          <div class="card card-pad stack"><div class="row between"><h2>${method.name} · ${fmtMonth(d.month)}</h2>${r ? html`<span class="small muted">média ${r.avg}${r.self_avg ? ` · visão do colaborador ${r.self_avg}` : ''}</span>` : ''}</div>
            ${r ? bars(method, r.manager_scores, d.prev_review?.manager_scores, r.self_scores) : empty('Nenhum acompanhamento neste mês', 'Registre as notas e os combinados da conversa individual.', html`<button class="btn primary" data-act="review" data-id="${m.id}" data-month="${d.month}">Registrar acompanhamento</button>`)}
            ${r ? html`<div class="small muted">Números verdes/vermelhos comparam com ${d.prev_review ? fmtMonth(d.prev_review.month) : 'o mês anterior'}. Traço preto = visão do colaborador.</div>
              ${method.dimensions.filter((x) => r.notes[x.key]).map((x) => html`<div class="small"><strong>${x.label}:</strong> ${r.notes[x.key]}</div>`)}
              <dl class="kv"><dt>Destaques</dt><dd>${r.highlights || '-'}</dd><dt>Pontos de atenção</dt><dd>${r.attention || '-'}</dd><dt>Combinados</dt><dd>${r.agreements || '-'}</dd></dl>` : ''}</div>
          <div class="card"><div class="card-head"><h2>Indicadores do mês</h2><span class="small muted">Calculados automaticamente da operação</span></div>
            <table class="table"><tbody>${metricRows.map(([l, val, c]) => html`<tr><td>${l}</td><td class="right num"><strong>${val}</strong>${c}</td></tr>`)}</tbody></table>
            ${mt.kind === 'field' ? html`<div class="card-body small muted" style="border-top:1px solid var(--border)">Nota e reclamações são atribuídas à equipe do último serviço concluído para o cliente. Qualidade é medida por equipe, horas por pessoa.</div>` : ''}</div>
          <div class="card"><div class="card-head"><h2>PDI · Plano de desenvolvimento</h2><button class="btn sm" data-act="pdi-new" data-id="${m.id}" data-dim="${weakest ? weakest.key : ''}">${icon('plus')} Nova meta</button></div>
            ${d.pdi.length ? html`<div class="list">${d.pdi.map((g) => { const dim = method.dimensions.find((x) => x.key === g.dimension); const late = ['not_started', 'in_progress'].includes(g.status) && g.due_date < todayStr(); return html`<div class="list-item" style="align-items:flex-start">
              <div class="grow"><div class="title">${g.title}</div><div class="meta">${dim ? `${dim.key} · ${dim.label} · ` : ''}prazo ${fmtDate(g.due_date)}${late ? ' · atrasada' : ''}</div>
                ${g.actions ? html`<div class="small" style="margin-top:4px"><strong>Ações:</strong> ${g.actions}</div>` : ''}${g.success_criteria ? html`<div class="small"><strong>Sucesso quando:</strong> ${g.success_criteria}</div>` : ''}${g.progress_note ? html`<div class="small muted">Andamento: ${g.progress_note}</div>` : ''}</div>
              <div class="side stack tight" style="align-items:flex-end">${b(PDI_ST, g.status)}${late ? html`<span class="badge danger">atrasada</span>` : ''}<button class="btn sm" data-act="pdi-edit" data-id="${g.id}">Atualizar</button></div></div>`; })}</div>`
    : empty('Nenhuma meta de desenvolvimento', weakest ? `Sugestão: começar por ${weakest.label}, a dimensão mais fraca do mês.` : 'Registre o acompanhamento para ver a dimensão mais fraca.')}
            ${weakest ? html`<div class="card-body small" style="border-top:1px solid var(--border)"><strong>Ideias para ${weakest.label}:</strong> ${weakest.ideas.join('; ')}.</div>` : ''}</div>
          <div class="card"><div class="card-head"><h2>Histórico de acompanhamentos</h2></div>
            ${d.reviews.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Mês</th>${method.dimensions.map((x) => html`<th class="right" title="${x.label}">${x.key}</th>`)}<th class="right">Média</th><th class="right">Colab.</th></tr></thead><tbody>
              ${d.reviews.map((rv) => html`<tr><td><a href="#/time/${m.id}?m=${rv.month}">${fmtMonth(rv.month)}</a></td>${method.dimensions.map((x) => html`<td class="right num"><span class="score tone-${rv.manager_scores[x.key]}">${rv.manager_scores[x.key]}</span></td>`)}<td class="right num"><strong>${rv.avg}</strong></td><td class="right num muted">${rv.self_avg ?? '-'}</td></tr>`)}</tbody></table></div>` : empty('Sem histórico ainda')}</div>
        </div>
        <div class="stack">
          <div class="card card-pad stack"><div class="row between"><div class="section-title" style="margin:0">Perfil</div><button class="btn ghost sm" data-act="profile-edit" data-id="${m.id}">Editar</button></div>
            <dl class="kv" style="grid-template-columns:1fr"><dt>Vínculo</dt><dd>${EMP[p.employment_type] || '-'}</dd><dt>O que motiva</dt><dd>${p.motivators || '-'}</dd><dt>Objetivo de carreira</dt><dd>${p.career_goals || '-'}</dd><dt>Pontos fortes</dt><dd>${p.strengths || '-'}</dd>${p.notes ? html`<dt>Observações</dt><dd>${p.notes}</dd>` : ''}</dl></div>
          <div class="card card-pad stack"><div class="row between"><div class="section-title" style="margin:0">Premiações · ${fmtMonth(d.month)}</div><button class="btn ghost sm" data-act="bonus-manual" data-id="${m.id}" data-month="${d.month}">Avulsa</button></div>
            ${d.suggestions.length ? d.suggestions.map((s) => html`<div class="stack tight" style="border-bottom:1px solid var(--border);padding-bottom:8px">
              <div class="row between"><strong class="small">${s.name}</strong><span class="num small">${money(s.amount)}</span></div>
              <div class="small muted">${s.value}</div>
              <div>${s.bonus_id ? b(BONUS_ST, s.bonus_status) : s.ok === true ? html`<button class="btn sm primary" data-act="bonus-approve" data-user="${m.id}" data-rule="${s.rule_id}" data-month="${d.month}">Aprovar ${money(s.amount)}</button>` : s.ok === null ? html`<span class="badge">sem dados suficientes</span>` : html`<span class="badge">critério não atingido</span>`}</div></div>`) : html`<div class="small muted">Nenhuma regra de premiação se aplica a este perfil.</div>`}
            ${mt.partial ? html`<div class="callout warn small">Mês em andamento: a elegibilidade pode mudar até o fim do mês.</div>` : ''}
            <div class="section-title" style="margin:6px 0 0">Histórico</div>
            ${d.bonuses.length ? d.bonuses.map((x) => html`<div class="stack tight" style="border-bottom:1px solid var(--border);padding-bottom:8px">
              <div class="row between"><span class="small"><strong>${money(x.amount)}</strong> · ${fmtMonth(x.month)}</span>${b(BONUS_ST, x.status)}</div><div class="small muted">${x.reason}${x.paid_date ? ` · pago em ${fmtDate(x.paid_date)}` : ''}</div>
              ${x.status === 'approved' ? html`<div class="btn-group"><button class="btn sm" data-act="bonus-pay" data-id="${x.id}">Marcar como paga</button><button class="btn sm danger" data-act="bonus-cancel" data-id="${x.id}">Cancelar</button></div>` : ''}</div>`) : html`<div class="small muted">Nenhuma premiação registrada.</div>`}
            <div class="small muted">Ao marcar como paga, a premiação entra como despesa no Financeiro. O sistema não calcula impostos de folha (payroll).</div></div>
        </div>
      </div>`,
  };
}

// ---------- Formulários ----------
ACT.review = async (el) => {
  const d = window.TEAM_CTX && String(window.TEAM_CTX.member.id) === el.dataset.id && window.TEAM_CTX.month === el.dataset.month ? window.TEAM_CTX : await GET(`/api/team/members/${el.dataset.id}?month=${el.dataset.month}`);
  window.TEAM_CTX = d;
  const r = d.review || {}; const ms = r.manager_scores || {}; const ss = r.self_scores || {}; const notes = r.notes || {};
  modal({ title: `Acompanhamento de ${fmtMonth(d.month)} · ${d.member.name}`, wide: true, body: html`<form class="form" data-form="review" data-user="${d.member.id}" data-month="${d.month}" novalidate>
    <p class="small muted">Dê a sua nota de 1 (${d.method.scale[1].toLowerCase()}) a 5 (${d.method.scale[5].toLowerCase()}). Se fez a conversa individual, registre também a nota que a pessoa se deu: a diferença entre as duas visões é um dos sinais mais úteis.</p>
    ${d.method.dimensions.map((x) => html`<div class="step-card">
      <div><strong>${x.key} · ${x.label}</strong> <span class="small muted">(${x.original})</span><div class="small muted">${x.question}</div></div>
      <div class="row wrap between"><div class="row wrap" role="radiogroup" aria-label="Nota do gestor para ${x.label}"><span class="small" style="font-weight:600">Sua nota</span>${[1, 2, 3, 4, 5].map((n) => html`<label class="score-pick"><input type="radio" name="m_${x.key}" value="${n}" ${ms[x.key] === n ? 'checked' : ''}><span>${n}</span></label>`)}</div>
        <label class="row small">Visão do colaborador <select name="s_${x.key}" style="width:auto">${opts([1, 2, 3, 4, 5].map((n) => [n, String(n)]), ss[x.key] || '', { blank: 'não registrada' })}</select></label></div>
      <input type="text" name="n_${x.key}" placeholder="O que você observou (opcional)" value="${notes[x.key] || ''}"></div>`)}
    <div class="field"><label>Destaques do mês</label><textarea name="highlights">${r.highlights || ''}</textarea></div>
    <div class="field"><label>Pontos de atenção</label><textarea name="attention">${r.attention || ''}</textarea></div>
    <div class="field"><label>Combinados para o próximo mês</label><textarea name="agreements">${r.agreements || ''}</textarea></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Salvar acompanhamento</button></div></form>` });
};
FORMS.review = async (form, fd) => {
  const dims = window.TEAM_CTX ? window.TEAM_CTX.method.dimensions : S.teamMethod.dimensions;
  const missing = dims.filter((x) => !fd[`m_${x.key}`]);
  if (missing.length) return showFormError(form, `Dê sua nota para: ${missing.map((x) => x.label).join(', ')}.`);
  const selfGiven = dims.filter((x) => fd[`s_${x.key}`]).length;
  if (selfGiven && selfGiven < dims.length) return showFormError(form, 'Visão do colaborador: preencha todas as dimensões ou deixe todas em branco.');
  const body = { user_id: Number(form.dataset.user), month: form.dataset.month, highlights: fd.highlights, attention: fd.attention, agreements: fd.agreements,
    manager_scores: Object.fromEntries(dims.map((x) => [x.key, Number(fd[`m_${x.key}`])])),
    self_scores: selfGiven ? Object.fromEntries(dims.map((x) => [x.key, Number(fd[`s_${x.key}`])])) : null,
    notes: Object.fromEntries(dims.map((x) => [x.key, fd[`n_${x.key}`]])) };
  await run(() => POST('/api/team/reviews', body), { form, ok: 'Acompanhamento salvo.' }); closeModal(); refresh();
};

ACT['profile-edit'] = () => {
  const d = window.TEAM_CTX; const p = d.profile;
  modal({ title: `Perfil de ${d.member.name}`, body: html`<form class="form" data-form="profile" data-id="${d.member.id}" novalidate>
    <div class="form-row"><div class="field"><label>Função</label><input type="text" name="position" value="${p.position || ''}"></div><div class="field"><label>Data de admissão</label><input type="date" name="hire_date" value="${p.hire_date || ''}"></div></div>
    <div class="field"><label>Vínculo</label><select name="employment_type">${opts(Object.entries(EMP), p.employment_type || '', { blank: 'Não informado' })}</select></div>
    <div class="field"><label>O que motiva esta pessoa</label><textarea name="motivators">${p.motivators || ''}</textarea></div>
    <div class="field"><label>Objetivo de carreira</label><textarea name="career_goals">${p.career_goals || ''}</textarea></div>
    <div class="field"><label>Pontos fortes</label><textarea name="strengths">${p.strengths || ''}</textarea></div>
    <div class="field"><label>Observações</label><textarea name="notes">${p.notes || ''}</textarea></div>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Salvar</button></div></form>` });
};
FORMS.profile = async (form, fd) => { await run(() => PATCH(`/api/team/members/${form.dataset.id}/profile`, fd), { form, ok: 'Perfil atualizado.' }); closeModal(); refresh(); };

function goalForm(g, d, dim) {
  return html`<form class="form" data-form="pdi" data-id="${g.id || ''}" data-user="${d.member.id}" novalidate>
    <div class="field"><label class="req">Objetivo</label><input type="text" name="title" value="${g.title || ''}" placeholder="Ex.: Preparar-se para liderar uma equipe"></div>
    <div class="form-row"><div class="field"><label>Dimensão ${d.method.name}</label><select name="dimension">${opts(d.method.dimensions.map((x) => [x.key, `${x.key} · ${x.label}`]), g.dimension || dim, { blank: 'Nenhuma' })}</select></div>
      <div class="field"><label class="req">Prazo</label><input type="date" name="due_date" value="${g.due_date || TZ.addDays(todayStr(), 30)}"></div></div>
    <div class="field"><label>Ações combinadas</label><textarea name="actions">${g.actions || ''}</textarea></div>
    <div class="field"><label>Como saber que deu certo</label><input type="text" name="success_criteria" value="${g.success_criteria || ''}"></div>
    ${g.id ? html`<div class="form-row"><div class="field"><label>Status</label><select name="status">${opts(Object.entries(PDI_ST).map(([k, [l]]) => [k, l]), g.status)}</select></div><div class="field"><label>Andamento</label><input type="text" name="progress_note" value="${g.progress_note || ''}"></div></div>` : ''}
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Salvar meta</button></div></form>`;
}
ACT['pdi-new'] = (el) => modal({ title: 'Nova meta de PDI', body: goalForm({}, window.TEAM_CTX, el.dataset.dim) });
ACT['pdi-edit'] = (el) => { const g = window.TEAM_CTX.pdi.find((x) => String(x.id) === el.dataset.id); modal({ title: 'Atualizar meta', body: goalForm(g, window.TEAM_CTX, '') }); };
FORMS.pdi = async (form, fd) => {
  if (!fd.title.trim()) return showFormError(form, 'Descreva o objetivo.');
  const id = form.dataset.id;
  await run(() => (id ? PATCH(`/api/team/pdi/${id}`, fd) : POST('/api/team/pdi', { ...fd, user_id: Number(form.dataset.user) })), { form, ok: 'Meta salva.' });
  closeModal(); refresh();
};

ACT['bonus-approve'] = (el) => safe(run(async () => { await POST('/api/team/bonuses', { user_id: Number(el.dataset.user), rule_id: Number(el.dataset.rule), month: el.dataset.month }); refresh(); }, { btn: el, ok: 'Premiação aprovada. Marque como paga quando pagar.' }));
ACT['bonus-manual'] = (el) => modal({ title: 'Premiação avulsa', body: html`<form class="form" data-form="bonus" data-user="${el.dataset.id}" data-month="${el.dataset.month}" novalidate>
  <div class="field"><label class="req">Motivo</label><input type="text" name="reason" placeholder="Ex.: cobriu duas faltas na semana do feriado"></div>
  <div class="field"><label class="req">Valor (US$)</label><input type="text" name="amount" inputmode="decimal"></div>
  <p class="small muted">Premiações avulsas não dependem de regra. Use com critério para manter a percepção de justiça no time.</p>
  <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Aprovar premiação</button></div></form>` });
FORMS.bonus = async (form, fd) => {
  const amount = parseMoney(fd.amount); if (!amount || amount <= 0) return showFormError(form, 'Informe um valor válido.');
  await run(() => POST('/api/team/bonuses', { user_id: Number(form.dataset.user), month: form.dataset.month, amount, reason: fd.reason }), { form, ok: 'Premiação aprovada.' }); closeModal(); refresh();
};
ACT['bonus-pay'] = (el) => modal({ title: 'Registrar pagamento da premiação', body: html`<form class="form" data-form="bonus-pay" data-id="${el.dataset.id}" novalidate>
  <div class="field"><label class="req">Data do pagamento</label><input type="date" name="paid_date" value="${todayStr()}" max="${todayStr()}"></div>
  <p class="small muted">O valor será registrado como despesa ("Bônus e premiações") no Financeiro. Impostos e folha de pagamento devem ser tratados pelo seu contador ou sistema de payroll.</p>
  <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Confirmar pagamento</button></div></form>` });
FORMS['bonus-pay'] = async (form, fd) => { await run(() => POST(`/api/team/bonuses/${form.dataset.id}/pay`, fd), { form, ok: 'Premiação paga e lançada no Financeiro.' }); closeModal(); refresh(); };
ACT['bonus-cancel'] = (el) => { if (!confirm('Cancelar esta premiação aprovada?')) return; safe(run(async () => { await POST(`/api/team/bonuses/${el.dataset.id}/cancel`); refresh(); }, { btn: el, ok: 'Premiação cancelada.' })); };

// ---------- Regras de premiação ----------
async function viewRules() {
  const d = await GET('/api/team/rules');
  window.RULES = d;
  const who = { field: 'Equipe de campo', assistant: 'Assistente / VA', all: 'Todos' };
  return {
    title: 'Regras de premiação',
    html: html`<div class="crumbs"><a href="#/time">Time</a> / Regras de premiação</div>
      <div class="page-head"><div><h1>Regras de premiação</h1><div class="sub">Critérios objetivos, calculados com os dados da operação. O dono sempre aprova antes de pagar.</div></div>
        <div class="btn-group"><button class="btn primary" data-act="rule-edit">${icon('plus')} Nova regra</button></div></div>
      <div class="callout info mb small">Quando faltam dados (ex.: nenhum cliente deu nota no mês), a regra aparece como "sem dados suficientes" e não sugere premiação. Isso evita premiar ou deixar de premiar com base em números que não existem.</div>
      <div class="card"><div class="table-wrap"><table class="table responsive"><thead><tr><th>Regra</th><th>Critério</th><th>Para quem</th><th class="right">Valor</th><th></th></tr></thead><tbody>
        ${d.rules.map((rl) => html`<tr><td data-l="Regra"><strong>${rl.name}</strong> ${rl.active ? '' : html`<span class="badge">inativa</span>`}</td><td data-l="Critério">${d.catalog[rl.metric].label}${rl.threshold != null ? ` ${rl.threshold}${d.catalog[rl.metric].unit === '%' ? '%' : ''}` : ''}</td><td data-l="Para quem">${who[rl.applies_to]}</td><td data-l="Valor" class="right num">${money(rl.amount)}</td><td class="right"><button class="btn sm" data-act="rule-edit" data-id="${rl.id}">Editar</button></td></tr>`)}
      </tbody></table></div>${!d.rules.length ? empty('Nenhuma regra ainda') : ''}</div>`,
  };
}
ACT['rule-edit'] = (el) => {
  const d = window.RULES; const rl = el.dataset.id ? d.rules.find((x) => String(x.id) === el.dataset.id) : { active: 1, metric: 'avg_rating_gte' };
  modal({ title: rl.id ? 'Editar regra' : 'Nova regra de premiação', body: html`<form class="form" data-form="rule" data-id="${rl.id || ''}" novalidate>
    <div class="field"><label class="req">Nome</label><input type="text" name="name" value="${rl.name || ''}"></div>
    <div class="field"><label class="req">Critério</label><select name="metric">${opts(Object.entries(d.catalog).map(([k, x]) => [k, `${x.label}${x.applies !== 'all' ? (x.applies === 'field' ? ' (equipe de campo)' : ' (assistente)') : ''}`]), rl.metric)}</select></div>
    <div class="form-row"><div class="field"><label>Meta (quando o critério pede)</label><input type="number" name="threshold" step="0.1" value="${rl.threshold ?? ''}"></div><div class="field"><label class="req">Valor do prêmio (US$)</label><input type="text" name="amount" inputmode="decimal" value="${centsToInput(rl.amount)}"></div></div>
    <div class="field"><label>Para quem (critério "PDI")</label><select name="applies_to">${opts([['all', 'Todos'], ['field', 'Equipe de campo'], ['assistant', 'Assistente / VA']], rl.applies_to || 'all')}</select></div>
    <label class="check"><input type="checkbox" name="active" ${rl.active ? 'checked' : ''}> Regra ativa</label>
    <div class="form-actions"><button type="button" class="btn" data-act="close-modal">Cancelar</button><button class="btn primary" type="submit">Salvar regra</button></div></form>` });
};
FORMS.rule = async (form, fd) => {
  const amount = parseMoney(fd.amount); if (!amount || amount <= 0) return showFormError(form, 'Informe o valor do prêmio.');
  const body = { ...fd, amount, threshold: fd.threshold === '' ? null : Number(fd.threshold) };
  await run(() => (form.dataset.id ? PATCH(`/api/team/rules/${form.dataset.id}`, body) : POST('/api/team/rules', body)), { form, ok: 'Regra salva.' }); closeModal(); refresh();
};

// ---------- Relatórios mensais (imprimir / salvar em PDF) ----------
function reportPerson(p, method, { full = true } = {}) {
  const r = p.review; const mt = p.metrics;
  const activePdi = p.pdi.filter((g) => g.status !== 'canceled');
  const monthBonuses = p.bonuses.filter((x) => x.month === p.month && x.status !== 'canceled');
  return html`<section class="report-person">
    <div class="row between top"><div><h2>${p.member.name}</h2><div class="small muted">${p.profile.position || ROLE[p.member.role]}${p.member.crew_name ? ` · ${p.member.crew_name}` : ''}</div></div>
      ${r ? html`<div class="right"><div style="font-size:22px;font-weight:700">${r.avg}</div><div class="small muted">média ${method.name}${p.prev_review ? ` (antes ${p.prev_review.avg})` : ''}</div></div>` : html`<span class="badge warn">sem acompanhamento no mês</span>`}</div>
    ${r ? bars(method, r.manager_scores, p.prev_review?.manager_scores, r.self_scores) : ''}
    <div class="small"><strong>Indicadores:</strong> ${metricLine(mt)}</div>
    ${r && full ? html`<dl class="kv"><dt>Destaques</dt><dd>${r.highlights || '-'}</dd><dt>Pontos de atenção</dt><dd>${r.attention || '-'}</dd><dt>Combinados</dt><dd>${r.agreements || '-'}</dd></dl>` : ''}
    <div class="small"><strong>PDI:</strong> ${activePdi.length ? activePdi.map((g) => `${g.title} (${PDI_ST[g.status][0].toLowerCase()}, prazo ${fmtDate(g.due_date)})`).join('; ') : 'nenhuma meta'}</div>
    <div class="small"><strong>Premiações do mês:</strong> ${monthBonuses.length ? monthBonuses.map((x) => `${money(x.amount)} - ${x.reason} (${BONUS_ST[x.status][0].toLowerCase()})`).join('; ') : 'nenhuma'}</div>
    ${p.flags.filter((f) => f.tone).length ? html`<div class="row wrap">${p.flags.filter((f) => f.tone).map((f) => html`<span class="badge ${f.tone}">${f.text}</span>`)}</div>` : ''}
  </section>`;
}
async function viewTeamReport({ query }) {
  const d = await GET('/api/team/report' + (query.m ? `?month=${query.m}` : ''));
  return {
    title: `Relatório do time · ${fmtMonth(d.month)}`,
    html: html`<div class="crumbs no-print"><a href="#/time?m=${d.month}">Time</a> / Relatório mensal</div>
      <div class="row between wrap no-print mb">${monthNav(d.month, '#/time/relatorio')}<button class="btn primary" data-act="print">Imprimir / salvar em PDF</button></div>
      <article class="doc report stack">
        <div class="row between top"><div><h1>Relatório de acompanhamento do time</h1><div class="muted">${d.company} · ${fmtMonth(d.month)} · método ${d.method.name}</div></div><div class="small muted right">Gerado em ${fmtDT(d.generated_at)}<br>Confidencial: uso do dono</div></div>
        <div class="tiles">
          <div class="tile" style="cursor:default"><span class="label">Acompanhamentos feitos</span><span class="value">${d.totals.reviewed}/${d.totals.members}</span></div>
          <div class="tile" style="cursor:default"><span class="label">Premiações pagas</span><span class="value">${money(d.totals.bonuses_paid)}</span></div>
          <div class="tile" style="cursor:default"><span class="label">Aprovadas a pagar</span><span class="value">${money(d.totals.bonuses_approved)}</span></div>
        </div>
        <div><div class="section-title">Média do time por dimensão</div><div class="row wrap">${d.method.dimensions.map((x) => html`<span class="badge">${x.key} · ${x.label}: <strong>${d.totals.dim_avg[x.key] ?? '-'}</strong></span>`)}</div></div>
        ${d.people.map((p) => reportPerson(p, d.method, { full: true }))}
        ${d.totals.reviewed < d.totals.members ? html`<p class="small muted">Pessoas sem acompanhamento no mês aparecem sem notas: o relatório não estima valores que não foram registrados.</p>` : ''}
      </article>`,
  };
}
async function viewMemberReport({ params, query }) {
  const p = await GET(`/api/team/members/${params.id}` + (query.m ? `?month=${query.m}` : ''));
  return {
    title: `Relatório · ${p.member.name}`,
    html: html`<div class="crumbs no-print"><a href="#/time">Time</a> / <a href="#/time/${p.member.id}?m=${p.month}">${p.member.name}</a> / Relatório</div>
      <div class="row between wrap no-print mb">${monthNav(p.month, `#/time/${p.member.id}/relatorio`)}<button class="btn primary" data-act="print">Imprimir / salvar em PDF</button></div>
      <article class="doc report stack">
        <div class="row between top"><div><h1>Relatório mensal de acompanhamento</h1><div class="muted">${S.me.company.name} · ${fmtMonth(p.month)} · método ${p.method.name}</div></div><div class="small muted right">Confidencial</div></div>
        ${reportPerson(p, p.method)}
        ${p.review ? html`<div><div class="section-title">Observações por dimensão</div>${p.method.dimensions.map((x) => html`<div class="small"><strong>${x.label}:</strong> ${p.review.notes[x.key] || '-'}</div>`)}</div>` : ''}
        <div class="row between wrap mt-lg" style="gap:40px"><div class="sign">Dono / gestor</div><div class="sign">${p.member.name}</div></div>
      </article>`,
  };
}
ACT.print = () => window.print();

routeDef('/time', viewTeam, { perm: ['team'] });
routeDef('/time/relatorio', viewTeamReport, { perm: ['team'] });
routeDef('/time/regras', viewRules, { perm: ['team'] });
routeDef('/time/:id/relatorio', viewMemberReport, { perm: ['team'] });
routeDef('/time/:id', viewMember, { perm: ['team'] });
void go; void setQuery; void toast; void localDateOf;
