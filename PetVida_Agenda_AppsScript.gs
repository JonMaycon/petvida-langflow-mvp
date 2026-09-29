/**
 * PetVida – API da agenda (Google Sheets) para o agente do Langflow.
 *
 * Como instalar (resumo):
 *  1. Abra a planilha "PetVida_Agenda_Planilha" no Google Sheets.
 *  2. Extensões → Apps Script → apague o conteúdo e cole este arquivo inteiro.
 *  3. Troque o TOKEN abaixo por uma senha longa só sua.
 *  4. Implantar → Nova implantação → Tipo: App da Web
 *       Executar como: Eu | Quem pode acessar: Qualquer pessoa
 *  5. Autorize e copie a URL que termina em /exec. Ela e o TOKEN vão no nó
 *     "Agenda PetVida (Google Sheets)" do Langflow.
 *  Sempre que alterar este código: Implantar → Gerenciar implantações → editar → Nova versão.
 */

const TOKEN = 'TROQUE-ESTE-TOKEN';        // mesma senha configurada no Langflow
const TZ = 'America/Cuiaba';             // fuso do petshop
const PASSO_MIN = 30;                    // de quanto em quanto tempo oferecer horários
const ANTECEDENCIA_MIN = 60;             // não oferecer horários que começam em menos de 1h
const DIAS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

// ---------------------------------------------------------------- entrada HTTP

function doPost(e) {
  let req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, erro: 'JSON inválido' });
  }
  if (req.token !== TOKEN) return json_({ ok: false, erro: 'Token inválido' });

  const acoes = {
    listar_servicos: listarServicos_,
    buscar_cliente: buscarCliente_,
    salvar_cliente: salvarCliente_,
    horarios_disponiveis: horariosDisponiveis_,
    criar_agendamento: criarAgendamento_,
    cancelar_agendamento: cancelarAgendamento_,
  };
  const fn = acoes[req.acao];
  if (!fn) return json_({ ok: false, erro: 'Ação desconhecida: ' + req.acao });

  try {
    return json_(fn(req.dados || {}));
  } catch (err) {
    return json_({ ok: false, erro: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return json_({ ok: true, mensagem: 'API da agenda PetVida no ar. Use POST.' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- ações

function listarServicos_() {
  return { ok: true, servicos: servicos_() };
}

function buscarCliente_(d) {
  const tel = telefone_(d.telefone);
  if (!tel) return { ok: false, erro: 'Informe o telefone.' };
  const cliente = tabela_('Clientes').linhas.find(c => telefone_(c.telefone) === tel) || null;
  const pets = tabela_('Pets').linhas
    .filter(p => telefone_(p.telefone_tutor) === tel)
    .map(p => ({ pet: p.pet, especie: p.especie, raca: p.raca, porte: p.porte, idade: p.idade, observacoes: p.observacoes }));
  const hoje = chaveData_(agora_().data);
  const agendamentos = tabela_('Agendamentos').linhas
    .filter(a => telefone_(a.telefone) === tel && !cancelado_(a.status) && chaveData_(data_(a.data)) >= hoje)
    .map(a => ({ id: a.id, data: data_(a.data), hora: hora_(a.hora), servico: a.servico, pet: a.pet, valor: a.valor, status: a.status }))
    .sort((x, y) => (chaveData_(x.data) + x.hora).localeCompare(chaveData_(y.data) + y.hora));
  return {
    ok: true,
    cliente_cadastrado: !!cliente,
    cliente: cliente ? { telefone: tel, nome: cliente.nome } : null,
    pets: pets,
    proximos_agendamentos: agendamentos,
  };
}

function salvarCliente_(d) {
  const tel = telefone_(d.telefone);
  if (!tel) return { ok: false, erro: 'Informe o telefone.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const agora = agora_().carimbo;
    if (d.nome) {
      const t = tabela_('Clientes');
      const i = t.linhas.findIndex(c => telefone_(c.telefone) === tel);
      if (i >= 0) {
        t.atualizar(i, { nome: d.nome, atualizado_em: agora });
      } else {
        t.inserir({ telefone: tel, nome: d.nome, criado_em: agora, atualizado_em: agora });
      }
    }
    if (d.pet) {
      const t = tabela_('Pets');
      const i = t.linhas.findIndex(p => telefone_(p.telefone_tutor) === tel && norm_(p.pet) === norm_(d.pet));
      const campos = { atualizado_em: agora };
      ['especie', 'raca', 'porte', 'idade', 'observacoes'].forEach(k => { if (d[k]) campos[k] = d[k]; });
      if (i >= 0) {
        t.atualizar(i, campos);
      } else {
        campos.telefone_tutor = tel;
        campos.pet = d.pet;
        t.inserir(campos);
      }
    }
    return { ok: true, mensagem: 'Cadastro salvo.' };
  } finally {
    lock.releaseLock();
  }
}

function horariosDisponiveis_(d) {
  const serv = servico_(d.servico);
  if (!serv) return { ok: false, erro: 'Serviço não encontrado.', servicos_validos: servicos_().map(s => s.servico) };
  const dt = parseData_(d.data);
  if (!dt) return { ok: false, erro: 'Data inválida. Use dd/mm/aaaa.' };
  const livres = slotsLivres_(serv, dt);
  return {
    ok: true,
    servico: serv.servico,
    data: dt.texto,
    dia_semana: DIAS[dt.date.getDay()],
    valor: serv.valor,
    duracao_min: serv.duracao_min,
    horarios_livres: livres.slots,
    observacao: livres.motivo || (livres.slots.length ? '' : 'Sem horários livres nesta data.'),
  };
}

function criarAgendamento_(d) {
  const tel = telefone_(d.telefone);
  if (!tel) return { ok: false, erro: 'Informe o telefone.' };
  if (!d.pet) return { ok: false, erro: 'Informe o nome do pet.' };
  const serv = servico_(d.servico);
  if (!serv) return { ok: false, erro: 'Serviço não encontrado.', servicos_validos: servicos_().map(s => s.servico) };
  const dt = parseData_(d.data);
  if (!dt) return { ok: false, erro: 'Data inválida. Use dd/mm/aaaa.' };
  const hora = hora_(d.hora);
  if (!hora) return { ok: false, erro: 'Hora inválida. Use hh:mm.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const livres = slotsLivres_(serv, dt);
    if (livres.slots.indexOf(hora) < 0) {
      return { ok: false, erro: 'Horário indisponível.', horarios_livres: livres.slots, observacao: livres.motivo || '' };
    }
    const agora = agora_();
    const id = 'AG-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd-HHmmss') + '-' + Math.floor(Math.random() * 90 + 10);
    tabela_('Agendamentos').inserir({
      id: id,
      data: dt.texto,
      hora: hora,
      servico: serv.servico,
      recurso: serv.recurso,
      duracao_min: String(serv.duracao_min),
      telefone: tel,
      tutor: d.tutor || '',
      pet: d.pet,
      especie: d.especie || '',
      porte: d.porte || '',
      valor: String(serv.valor),
      status: 'Agendado',
      observacoes: d.observacoes || '',
      criado_em: agora.carimbo,
    });
  } finally {
    lock.releaseLock();
  }
  // mantém o cadastro do cliente/pet atualizado
  salvarCliente_({ telefone: tel, nome: d.tutor, pet: d.pet, especie: d.especie, porte: d.porte });
  return {
    ok: true,
    mensagem: 'Agendamento criado.',
    agendamento: { data: dt.texto, dia_semana: DIAS[dt.date.getDay()], hora: hora, servico: serv.servico, pet: d.pet, valor: serv.valor },
  };
}

function cancelarAgendamento_(d) {
  const tel = telefone_(d.telefone);
  if (!tel) return { ok: false, erro: 'Informe o telefone.' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = tabela_('Agendamentos');
    const i = t.linhas.findIndex(a => String(a.id).trim() === String(d.id || '').trim());
    if (i < 0) return { ok: false, erro: 'Agendamento não encontrado.' };
    const a = t.linhas[i];
    if (telefone_(a.telefone) !== tel) return { ok: false, erro: 'Este agendamento não pertence a este cliente.' };
    if (cancelado_(a.status)) return { ok: true, mensagem: 'Este agendamento já estava cancelado.' };
    t.atualizar(i, { status: 'Cancelado', observacoes: ((a.observacoes || '') + ' | Cancelado pelo cliente via WhatsApp em ' + agora_().carimbo).replace(/^ \| /, '') });
    return { ok: true, mensagem: 'Agendamento cancelado.', agendamento: { data: data_(a.data), hora: hora_(a.hora), servico: a.servico, pet: a.pet } };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- disponibilidade

function slotsLivres_(serv, dt) {
  const dia = DIAS[dt.date.getDay()];
  const turnos = tabela_('Horarios').linhas.filter(h => norm_(h.recurso) === norm_(serv.recurso) && norm_(h.dia_semana) === dia);
  if (!turnos.length) return { slots: [], motivo: 'Fechado neste dia para ' + serv.recurso + '.' };

  const agora = agora_();
  const hoje = chaveData_(agora.data);
  const alvo = chaveData_(dt.texto);
  if (alvo < hoje) return { slots: [], motivo: 'Data no passado.' };
  const minimo = alvo === hoje ? min_(agora.hora) + ANTECEDENCIA_MIN : -1;

  const ocupados = tabela_('Agendamentos').linhas
    .filter(a => !cancelado_(a.status) && data_(a.data) === dt.texto && norm_(a.recurso || recursoDoServico_(a.servico)) === norm_(serv.recurso))
    .map(a => {
      const ini = min_(hora_(a.hora));
      return { ini: ini, fim: ini + (Number(a.duracao_min) || duracaoDoServico_(a.servico)) };
    });

  const slots = [];
  turnos.forEach(t => {
    const abre = min_(hora_(t.abre));
    const fecha = min_(hora_(t.fecha));
    const vagas = Number(t.vagas) || 1;
    for (let ini = abre; ini + serv.duracao_min <= fecha; ini += PASSO_MIN) {
      if (ini < minimo) continue;
      const fim = ini + serv.duracao_min;
      const conflitos = ocupados.filter(o => o.ini < fim && ini < o.fim).length;
      if (conflitos < vagas) slots.push(txtMin_(ini));
    }
  });
  const unicos = Array.from(new Set(slots)).sort();
  return { slots: unicos, motivo: unicos.length ? '' : (alvo === hoje ? 'Não há mais horários hoje.' : '') };
}

function servicos_() {
  return tabela_('Servicos').linhas
    .filter(s => s.servico)
    .map(s => ({ servico: String(s.servico).trim(), recurso: String(s.recurso).trim(), duracao_min: Number(s.duracao_min) || 30, valor: Number(String(s.valor).replace(',', '.')) || 0, observacao: s.observacao || '' }));
}

function servico_(nome) {
  if (!nome) return null;
  const n = norm_(nome);
  const lista = servicos_();
  return lista.find(s => norm_(s.servico) === n) || lista.find(s => norm_(s.servico).indexOf(n) >= 0) || null;
}

function recursoDoServico_(nome) { const s = servico_(nome); return s ? s.recurso : ''; }
function duracaoDoServico_(nome) { const s = servico_(nome); return s ? s.duracao_min : PASSO_MIN; }

// ---------------------------------------------------------------- planilha

function tabela_(nome) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nome);
  if (!sh) throw new Error('Aba "' + nome + '" não encontrada.');
  const valores = sh.getDataRange().getValues();
  const cab = (valores.shift() || []).map(c => String(c).trim());
  const linhas = valores
    .filter(r => r.some(v => v !== '' && v !== null))
    .map(r => { const o = {}; cab.forEach((c, i) => { o[c] = r[i]; }); return o; });
  // posição real de cada linha (ignorando linhas vazias no meio)
  const numeros = [];
  valores.forEach((r, i) => { if (r.some(v => v !== '' && v !== null)) numeros.push(i + 2); });

  return {
    linhas: linhas,
    inserir: function (obj) {
      const linha = cab.map(c => (obj[c] === undefined || obj[c] === null ? '' : String(obj[c])));
      const r = sh.getLastRow() + 1;
      const rg = sh.getRange(r, 1, 1, cab.length);
      rg.setNumberFormat('@');
      rg.setValues([linha]);
    },
    atualizar: function (indice, campos) {
      const r = numeros[indice];
      Object.keys(campos).forEach(k => {
        const c = cab.indexOf(k);
        if (c >= 0 && campos[k] !== undefined && campos[k] !== null && campos[k] !== '') {
          const cel = sh.getRange(r, c + 1);
          cel.setNumberFormat('@');
          cel.setValue(String(campos[k]));
        }
      });
    },
  };
}

// ---------------------------------------------------------------- utilidades

function tzPlanilha_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || TZ;
}

function agora_() {
  const n = new Date();
  return {
    data: Utilities.formatDate(n, TZ, 'dd/MM/yyyy'),
    hora: Utilities.formatDate(n, TZ, 'HH:mm'),
    carimbo: Utilities.formatDate(n, TZ, 'dd/MM/yyyy HH:mm'),
  };
}

function telefone_(v) {
  let s = String(v || '').split('@')[0].replace(/\D/g, '');
  if (s.length === 10 || s.length === 11) s = '55' + s; // número brasileiro sem DDI
  return s;
}

function norm_(v) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

function cancelado_(status) {
  const s = norm_(status);
  return s.indexOf('cancel') === 0;
}

// dd/mm/aaaa a partir de Date, "aaaa-mm-dd" ou "dd/mm/aaaa"
function data_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tzPlanilha_(), 'dd/MM/yyyy');
  const p = parseData_(v);
  return p ? p.texto : String(v || '').trim();
}

function parseData_(v) {
  if (v instanceof Date) v = Utilities.formatDate(v, tzPlanilha_(), 'dd/MM/yyyy');
  const s = String(v || '').trim();
  let d, m, y, r;
  if ((r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/))) {
    d = +r[1]; m = +r[2];
    y = r[3] ? +r[3] : +agora_().data.slice(6);
    if (y < 100) y += 2000;
  } else return null;
  const date = new Date(y, m - 1, d, 12, 0, 0);
  if (date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  const pad = n => (n < 10 ? '0' : '') + n;
  return { date: date, texto: pad(d) + '/' + pad(m) + '/' + y };
}

function chaveData_(texto) {
  const p = parseData_(texto);
  if (!p) return '';
  const t = p.texto;
  return t.slice(6) + t.slice(3, 5) + t.slice(0, 2);
}

// hh:mm a partir de Date (célula de hora), "8:00", "08h", "8h30", "0800"
function hora_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tzPlanilha_(), 'HH:mm');
  const s = String(v || '').trim().toLowerCase();
  const r = s.match(/^(\d{1,2})\s*(?:[:h]\s*(\d{2})?)?\s*$/) || s.match(/^(\d{2})(\d{2})$/);
  if (!r) return '';
  const h = +r[1];
  const m = r[2] ? +r[2] : 0;
  if (h > 23 || m > 59) return '';
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function min_(hhmm) {
  const p = String(hhmm).split(':');
  return (+p[0]) * 60 + (+p[1] || 0);
}

function txtMin_(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
}
