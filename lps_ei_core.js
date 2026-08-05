/* ================================================================
   lps_ei_core.js — Núcleo compartilhado
   LPS · Elétrica e Instrumentação (PCO Digital)
   ----------------------------------------------------------------
   Carregar SEMPRE depois de config.js e unidade.js:
     <script src="config.js"></script>
     <script src="unidade.js"></script>
     <script src="lps_ei_core.js"></script>

   Regras seguidas (padrão do PCO):
   · SB_KEY (anon/publishable) como Bearer — nunca o pco_token,
     que expira e devolve PGRST303.
   · Toda leitura usa sbGetAll() paginado (Range) por causa do
     limite silencioso de 1000 linhas do PostgREST.
   · Todo INSERT recebe a unidade ativa via pcoComTag().
   ================================================================ */

(function (global) {
  'use strict';

  /* ── Credenciais ─────────────────────────────────────────── */
  var CFG    = global.PCO_CONFIG || {};
  var SB_URL = (CFG.supabase || {}).url || '';
  var SB_KEY = (CFG.supabase || {}).key || '';

  /* ── Identificação do módulo ─────────────────────────────── */
  var MOD_KEY   = 'lps_ei';
  var MOD_TITLE = 'LPS · Elétrica e Instrumentação';

  var PAGES = [
    { href: 'lps_ei.html',            key: 'painel',     ic: '▦', label: 'Painel por Área' },
    { href: 'lps_ei_contratos.html',  key: 'contratos',  ic: '§', label: 'Contratos' },
    { href: 'lps_ei_materiais.html',  key: 'materiais',  ic: '▤', label: 'Materiais' },
    { href: 'lps_ei_lookahead.html',  key: 'lookahead',  ic: '▶', label: 'Lookahead' },
    { href: 'lps_ei_restricoes.html', key: 'restricoes', ic: '⚑', label: 'Restrições' },
    { href: 'lps_ei_kanban.html',     key: 'kanban',     ic: '▥', label: 'Programação Semanal' }
  ];

  /* ================================================================
     1. UTILITÁRIOS BÁSICOS
     ================================================================ */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Número em formato pt-BR (aceita string com vírgula decimal) */
  function parseNum(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var s = String(v).trim().replace(/\s/g, '');
    if (!s) return 0;
    // 1.234,56 → 1234.56   |   1,234.56 → 1234.56
    if (s.indexOf(',') > -1 && s.indexOf('.') > -1) {
      s = (s.lastIndexOf(',') > s.lastIndexOf('.'))
        ? s.replace(/\./g, '').replace(',', '.')
        : s.replace(/,/g, '');
    } else if (s.indexOf(',') > -1) {
      s = s.replace(/\./g, '').replace(',', '.');
    }
    var n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function nf(n, d) {
    if (n == null || n === '' || isNaN(n)) return '—';
    var dec = (d == null) ? 0 : d;
    return Number(n).toLocaleString('pt-BR',
      { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function nfMoney(n) {
    if (n == null || n === '' || isNaN(n)) return '—';
    return Number(n).toLocaleString('pt-BR',
      { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  }

  /* Remove acentos e caixa — para casar cabeçalhos de planilha */
  function deacc(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase().replace(/\s+/g, ' ').trim();
  }

  /* ── Datas ────────────────────────────────────────────────── */
  function todayISO() {
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 10);
  }

  function toISO(d) {
    if (!d) return null;
    if (typeof d === 'string') return d.slice(0, 10);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 10);
  }

  /* ISO 'YYYY-MM-DD' → Date local (evita o shift de fuso do parser UTC) */
  function dt(iso) {
    if (!iso) return null;
    var p = String(iso).slice(0, 10).split('-');
    if (p.length !== 3) return null;
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function fmtBr(iso) {
    var p = String(iso == null ? '' : iso).slice(0, 10).split('-');
    return p.length === 3 && p[0] ? p[2] + '/' + p[1] + '/' + p[0] : '';
  }

  function fmtBrDash(iso) { return fmtBr(iso) || '—'; }

  function fmtTS(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.toLocaleDateString('pt-BR') + ' ' +
      d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function addDays(iso, n) {
    var d = dt(iso); if (!d) return null;
    d.setDate(d.getDate() + n);
    return toISO(d);
  }

  function diffDays(a, b) {
    var da = dt(a), db = dt(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }

  /* Segunda-feira da semana de `iso` (ou de hoje) */
  function mondayOf(iso) {
    var d = dt(iso || todayISO()); if (!d) return null;
    var wd = d.getDay();               // 0=dom
    var delta = (wd === 0) ? -6 : (1 - wd);
    d.setDate(d.getDate() + delta);
    return toISO(d);
  }

  /* Rótulo curto da semana: "S32 · 04/08" */
  function weekLabel(isoMonday) {
    var d = dt(isoMonday); if (!d) return '';
    var jan1 = new Date(d.getFullYear(), 0, 1);
    var wk = Math.ceil((((d - jan1) / 86400000) + jan1.getDay() + 1) / 7);
    return 'S' + wk;
  }

  function weekRangeLabel(isoMonday) {
    var fim = addDays(isoMonday, 6);
    return fmtBr(isoMonday).slice(0, 5) + '–' + fmtBr(fim).slice(0, 5);
  }

  /* ================================================================
     2. SUPABASE
     ================================================================ */

  function sbHeaders(withBody) {
    var h = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
    if (withBody) {
      h['Content-Type'] = 'application/json';
      h.Prefer = 'return=representation';
    }
    return h;
  }

  function sb(method, path, body) {
    return fetch(SB_URL + '/rest/v1/' + path, {
      method: method,
      headers: sbHeaders(!!body),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        if (!res.ok) throw new Error(res.status + ': ' + txt.slice(0, 240));
        try { return JSON.parse(txt); } catch (_) { return []; }
      });
    });
  }

  /* Leitura paginada — o PostgREST corta em 1000 linhas sem avisar */
  function sbGetAll(path) {
    var out = [], step = 1000;
    function grab(from) {
      var h = sbHeaders(false);
      h.Range = from + '-' + (from + step - 1);
      return fetch(SB_URL + '/rest/v1/' + path, { headers: h })
        .then(function (res) {
          return res.text().then(function (txt) {
            if (!res.ok) throw new Error(res.status + ': ' + txt.slice(0, 240));
            var chunk;
            try { chunk = JSON.parse(txt); } catch (_) { chunk = []; }
            if (!Array.isArray(chunk)) chunk = [];
            out = out.concat(chunk);
            if (chunk.length < step) return out;
            return grab(from + step);
          });
        });
    }
    return grab(0);
  }

  /* Grava em blocos (com retry por bloco) — padrão dos imports grandes */
  function sbInsertChunked(table, rows, chunkSize) {
    var size = chunkSize || 300;
    var i = 0;
    function next() {
      if (i >= rows.length) return Promise.resolve(rows.length);
      var slice = rows.slice(i, i + size);
      i += size;
      return sb('POST', table, slice)
        .catch(function (e1) {
          return new Promise(function (r) { setTimeout(r, 700); })
            .then(function () { return sb('POST', table, slice); })
            .catch(function () { throw e1; });
        })
        .then(next);
    }
    return next();
  }

  /* Erro de tabela inexistente (antes de rodar a migração) */
  function isMissingTable(err) {
    return /42P01|PGRST205|PGRST20[26]|does not exist|Could not find the table/i
      .test(String(err && err.message || err));
  }

  /* ================================================================
     3. SESSÃO / PERMISSÕES
     ================================================================ */

  function requireAuth() {
    if (!sessionStorage.getItem('pco_token')) {
      window.location.href = 'login.html';
      return false;
    }
    if (!sessionStorage.getItem('pco_unidade')) {
      sessionStorage.setItem('pco_unidade', 'RDN');
    }
    return true;
  }

  function userNome() {
    return sessionStorage.getItem('pco_nome') ||
           sessionStorage.getItem('pco_email') || '';
  }

  function userEmail() { return sessionStorage.getItem('pco_email') || ''; }

  /* Pode editar? admin global, ou admin_paginas contemplando 'lps_ei'
     (aceita tanto o formato objeto {pagina:[unidades]} quanto array) */
  function canEdit() {
    var perfil = sessionStorage.getItem('pco_perfil') || '';
    if (perfil === 'admin') return true;
    if (typeof global.pcoPodeAdministrar === 'function') {
      try { if (global.pcoPodeAdministrar(MOD_KEY)) return true; } catch (_) {}
    }
    try {
      var perms = JSON.parse(sessionStorage.getItem('pco_perms') || '{}');
      var ap = perms.admin_paginas;
      if (Array.isArray(ap)) return ap.indexOf(MOD_KEY) > -1;
      if (ap && typeof ap === 'object') {
        var esc0 = ap[MOD_KEY] || [];
        return esc0.indexOf(unidade()) > -1;
      }
      if (perms[MOD_KEY]) return true;
    } catch (_) {}
    return false;
  }

  function unidade() {
    return (typeof global.pcoUnidadeAtual === 'function')
      ? global.pcoUnidadeAtual()
      : (sessionStorage.getItem('pco_unidade') || 'RDN');
  }

  function unidadeNome() {
    return (typeof global.pcoUnidadeInfo === 'function')
      ? global.pcoUnidadeInfo().nome : unidade();
  }

  /* Wrappers seguros caso unidade.js não tenha carregado */
  function comUnidade(path) {
    if (typeof global.pcoComUnidade === 'function') return global.pcoComUnidade(path);
    return path + (path.indexOf('?') > -1 ? '&' : '?') +
      'unidade=eq.' + encodeURIComponent(unidade());
  }

  function comTag(obj) {
    if (typeof global.pcoComTag === 'function') return global.pcoComTag(obj);
    var tag = function (r) { var o = {}; for (var k in r) o[k] = r[k]; o.unidade = unidade(); return o; };
    return Array.isArray(obj) ? obj.map(tag) : tag(obj);
  }

  /* ================================================================
     4. SHELL — cabeçalho + menu do módulo
     ================================================================ */

  function renderShell(opts) {
    var o = opts || {};
    var host = $('lps-shell');
    if (!host) return;

    var nome = userNome(), mail = userEmail();
    var ini = (nome || '?').split(' ').slice(0, 2)
      .map(function (w) { return w[0] || ''; }).join('').toUpperCase() || '?';
    var editable = canEdit();

    var nav = PAGES.map(function (p) {
      var on = (p.key === o.page) ? ' class="on"' : '';
      return '<a href="' + p.href + '"' + on + '>' +
             '<span class="ic">' + p.ic + '</span>' + esc(p.label) + '</a>';
    }).join('');

    host.innerHTML =
      '<div class="nav-row no-print">' +
        '<a class="back-link" href="index.html">← Painel de Ferramentas</a>' +
        '<div class="user-bar">' +
          '<span id="unidade-switcher"></span>' +
          '<span class="ro-chip' + (editable ? ' edit' : '') + '">' +
            (editable ? 'Edição liberada' : 'Somente leitura') + '</span>' +
          '<div class="user-chip">' +
            '<div class="user-avatar">' + esc(ini) + '</div>' +
            '<div><div class="user-name">' + esc(nome || mail) + '</div>' +
            '<div class="user-mail">' + esc(mail) + '</div></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<header class="site-header">' +
        '<div>' +
          '<div class="eyebrow">Last Planner System · ' + esc(unidadeNome()) + '</div>' +
          '<h1>' + esc(o.title || MOD_TITLE) + '</h1>' +
          (o.subtitle ? '<p class="subtitle">' + o.subtitle + '</p>' : '') +
        '</div>' +
        '<div id="lps-head-actions" class="user-bar no-print"></div>' +
      '</header>' +
      '<nav class="mod-nav no-print">' + nav + '</nav>';

    if (typeof global.pcoRenderSwitcher === 'function') {
      try { global.pcoRenderSwitcher('unidade-switcher'); } catch (_) {}
    }
    document.title = (o.title || MOD_TITLE) + ' · PCO';
  }

  /* ================================================================
     5. ÁREAS (cache em memória por página)
     ================================================================ */

  var _areas = null;

  function loadAreas(force) {
    if (_areas && !force) return Promise.resolve(_areas);
    return sbGetAll(comUnidade(
      'lps_ei_areas?select=*&ativo=eq.true&order=ordem.asc,codigo.asc'
    )).then(function (rows) { _areas = rows || []; return _areas; });
  }

  function areasCache() { return _areas || []; }

  function areaNome(codigo) {
    var a = (_areas || []).find(function (x) { return x.codigo === codigo; });
    return a ? a.nome : (codigo || '');
  }

  function areaOptions(selected, incluirTodas) {
    var out = incluirTodas ? '<option value="">Todas as áreas</option>' : '<option value=""></option>';
    (_areas || []).forEach(function (a) {
      out += '<option value="' + esc(a.codigo) + '"' +
        (a.codigo === selected ? ' selected' : '') + '>' +
        esc(a.codigo + ' · ' + a.nome) + '</option>';
    });
    return out;
  }

  /* ================================================================
     6. TOAST
     ================================================================ */

  var _tt;
  function toast(msg, kind) {
    var el = $('lps-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lps-toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(_tt);
    _tt = setTimeout(function () { el.className = 'toast' + (kind ? ' ' + kind : ''); }, 3400);
  }

  /* ================================================================
     7. EXPORT XLSX (SheetJS via CDN — carregado sob demanda)
     ================================================================ */

  function ensureXLSX() {
    if (global.XLSX) return Promise.resolve(global.XLSX);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = function () { resolve(global.XLSX); };
      s.onerror = function () { reject(new Error('Falha ao carregar SheetJS')); };
      document.head.appendChild(s);
    });
  }

  /* sheets: [{ nome:'Dados', aoa:[[...],[...]] }, ...] */
  function exportXlsx(sheets, filename) {
    return ensureXLSX().then(function (X) {
      var wb = X.utils.book_new();
      sheets.forEach(function (sh) {
        var ws = X.utils.aoa_to_sheet(sh.aoa || [[]]);
        if (sh.cols) ws['!cols'] = sh.cols;
        X.utils.book_append_sheet(wb, ws, (sh.nome || 'Planilha').slice(0, 31));
      });
      X.writeFile(wb, filename);
      toast('Excel gerado: ' + filename, 'ok');
    }).catch(function (e) {
      toast('Erro ao exportar: ' + e.message, 'warn');
    });
  }

  function stamp() {
    return unidade() + '_' + todayISO().replace(/-/g, '');
  }

  /* ================================================================
     8. MODAL — abrir/fechar genérico
     ================================================================ */

  function openModal(id) {
    var m = $(id); if (!m) return;
    m.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(id) {
    var m = $(id); if (!m) return;
    m.classList.remove('open');
    document.body.style.overflow = '';
  }

  function wireModal(id) {
    var m = $(id); if (!m) return;
    m.addEventListener('click', function (ev) {
      if (ev.target === m) closeModal(id);
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var open = document.querySelector('.modal.open');
    if (open) closeModal(open.id);
  });

  /* ================================================================
     9. AVISO DE SETUP (tabelas ainda não criadas)
     ================================================================ */

  function setupNotice(containerId, err) {
    var el = $(containerId);
    if (!el) return;
    if (isMissingTable(err)) {
      el.className = 'notice warn';
      el.innerHTML = '<b>Tabelas do módulo ainda não existem.</b> ' +
        'Rode o script <code>supabase_lps_ei.sql</code> no SQL Editor do Supabase ' +
        '(projeto <code>vfqesvmaqxvlgtshyoja</code>) e recarregue esta página.';
    } else {
      el.className = 'notice err';
      el.innerHTML = '<b>Erro ao carregar dados.</b> ' + esc(String(err && err.message || err));
    }
    el.style.display = '';
  }

  /* ================================================================
     10. LISTAS DE DOMÍNIO
     ================================================================ */

  var DISCIPLINAS = ['Elétrica', 'Instrumentação', 'Elétrica e Instrumentação'];

  var CONTRATO_STATUS = [
    'Em definição de escopo', 'Em cotação', 'Em negociação',
    'Contratado', 'Mobilizado', 'Em execução', 'Concluído', 'Cancelado'
  ];

  var PROJETO_STATUS = [
    'Não iniciado', 'Em elaboração', 'Em aprovação',
    'Liberado para construção', 'Em revisão', 'Cancelado'
  ];

  var ATIV_STATUS = ['Não iniciada', 'Em execução', 'Concluída', 'Paralisada'];

  var RESTR_CATEGORIAS = [
    'Projeto executivo', 'Material', 'Contratação', 'Mão de obra',
    'Equipamento', 'Acesso / Interferência', 'Documentação / Permissão',
    'Segurança', 'Predecessora (obra civil)', 'Escopo / Definição', 'Outros'
  ];

  var RESTR_STATUS = ['Aberta', 'Em tratativa', 'Removida', 'Cancelada'];

  var KB_COLS = [
    { key: 'programada',    label: 'Programada',     cls: 'c-prog' },
    { key: 'execucao',      label: 'Em execução',    cls: 'c-exec' },
    { key: 'concluida',     label: 'Concluída',      cls: 'c-done' },
    { key: 'nao_concluida', label: 'Não concluída',  cls: 'c-fail' }
  ];

  /* Causas de não cumprimento — base do Pareto do LPS */
  var CAUSAS_PPC = [
    'Falta de material',
    'Projeto não liberado / com pendência',
    'Falta de mão de obra',
    'Falta de equipamento / ferramenta',
    'Frente não liberada (obra civil / montagem)',
    'Interferência com outra equipe',
    'Condição climática',
    'Falta de documentação / permissão de trabalho',
    'Retrabalho / qualidade',
    'Programação mal dimensionada',
    'Paralisação por segurança',
    'Outros'
  ];

  /* ================================================================
     11. SEMÁFORO — cálculo de status por data
     ================================================================ */

  function statusPorData(dataAlvo, dataReal, janelaAlerta) {
    if (dataReal) return 'ok';
    if (!dataAlvo) return 'na';
    var d = diffDays(todayISO(), dataAlvo);
    if (d == null) return 'na';
    if (d < 0) return 'late';
    if (d <= (janelaAlerta == null ? 7 : janelaAlerta)) return 'warn';
    return 'ok';
  }

  var SEM_CLS = { ok: 'g', warn: 'y', late: 'r', na: 'n' };

  /* ================================================================
     EXPORT
     ================================================================ */

  var API = {
    SB_URL: SB_URL, SB_KEY: SB_KEY,
    MOD_KEY: MOD_KEY, MOD_TITLE: MOD_TITLE, PAGES: PAGES,
    $: $, esc: esc, parseNum: parseNum, nf: nf, nfMoney: nfMoney, deacc: deacc,
    todayISO: todayISO, toISO: toISO, dt: dt, fmtBr: fmtBr, fmtBrDash: fmtBrDash,
    fmtTS: fmtTS, addDays: addDays, diffDays: diffDays,
    mondayOf: mondayOf, weekLabel: weekLabel, weekRangeLabel: weekRangeLabel,
    sb: sb, sbGetAll: sbGetAll, sbInsertChunked: sbInsertChunked,
    isMissingTable: isMissingTable, setupNotice: setupNotice,
    requireAuth: requireAuth, canEdit: canEdit,
    userNome: userNome, userEmail: userEmail,
    unidade: unidade, unidadeNome: unidadeNome,
    comUnidade: comUnidade, comTag: comTag,
    renderShell: renderShell,
    loadAreas: loadAreas, areasCache: areasCache, areaNome: areaNome, areaOptions: areaOptions,
    toast: toast, exportXlsx: exportXlsx, ensureXLSX: ensureXLSX, stamp: stamp,
    openModal: openModal, closeModal: closeModal, wireModal: wireModal,
    DISCIPLINAS: DISCIPLINAS, CONTRATO_STATUS: CONTRATO_STATUS,
    PROJETO_STATUS: PROJETO_STATUS, ATIV_STATUS: ATIV_STATUS,
    RESTR_CATEGORIAS: RESTR_CATEGORIAS, RESTR_STATUS: RESTR_STATUS,
    KB_COLS: KB_COLS, CAUSAS_PPC: CAUSAS_PPC,
    statusPorData: statusPorData, SEM_CLS: SEM_CLS
  };

  global.LPS = API;

})(window);
