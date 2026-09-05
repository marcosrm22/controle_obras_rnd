/* ================================================================
   cron_geral_core.js — Núcleo do módulo Cronograma Executivo Geral
   ----------------------------------------------------------------
   Carregar SEMPRE depois de config.js e unidade.js e ANTES do
   SheetJS (que é lazy-loaded pela função ensureXLSX):
     <script src="config.js"></script>
     <script src="unidade.js"></script>
     <script src="cron_geral_core.js"></script>

   Regras (padrão PCO):
   · SB_KEY (anon) como Bearer — nunca o pco_token (expira).
   · Leituras via sbGetAll (Range paginado).
   · Inserts em bloco via sbInsertChunked.
   · Toda gravação inclui a unidade ativa (pcoComTag).
   ================================================================ */

(function (global) {
  'use strict';

  var CFG    = global.PCO_CONFIG || {};
  var SB_URL = (CFG.supabase || {}).url || '';
  var SB_KEY = (CFG.supabase || {}).key || '';

  var MOD_KEY   = 'cron_geral';
  var MOD_TITLE = 'Cronograma Executivo Geral';

  var PAGES = [
    { href: 'cron_geral.html',        key: 'lista',   ic: '§', label: 'Atividades' },
    { href: 'cron_geral_import.html', key: 'import',  ic: '↥', label: 'Importar Excel' }
  ];

  /* Dicionários oficiais das dimensões hierárquicas */
  var FASES = [
    { code: 'FASE_I',  label: 'Fase I' },
    { code: 'FASE_II', label: 'Fase II' },
    { code: 'ARMAZEM', label: 'Armazém de Grãos' },
    { code: 'POSTO',   label: 'Posto de Combustíveis' }
  ];
  var TIPOS = [
    { code: 'PROJETO',         label: 'Projetos' },
    { code: 'FORNECIMENTO',    label: 'Fornecimentos' },
    { code: 'EXECUCAO',        label: 'Execução' },
    { code: 'COMISSIONAMENTO', label: 'Comissionamentos' }
  ];

  /* ── Utilitários ─────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  function parseNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim().replace(/\s/g,'').replace(/R\$/gi,'').replace(/%/g,'');
    if (!s) return null;
    if (s.indexOf(',') > -1 && s.indexOf('.') > -1) {
      s = (s.lastIndexOf(',') > s.lastIndexOf('.'))
        ? s.replace(/\./g,'').replace(',', '.')
        : s.replace(/,/g,'');
    } else if (s.indexOf(',') > -1) {
      s = s.replace(/\./g,'').replace(',', '.');
    }
    var n = parseFloat(s.replace(/[^0-9.\-]/g,''));
    return isNaN(n) ? null : n;
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
  function deacc(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/\s+/g,' ').trim();
  }

  /* ── Datas ────────────────────────────────────────────────── */
  function fmtBr(iso) {
    var p = String(iso == null ? '' : iso).slice(0,10).split('-');
    return p.length === 3 && p[0] ? p[2] + '/' + p[1] + '/' + p[0] : '';
  }
  function toISO(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) {
      return new Date(v.getTime() - v.getTimezoneOffset() * 60000)
        .toISOString().slice(0,10);
    }
    if (typeof v === 'number') {
      // Excel serial date
      var epoch = new Date(Date.UTC(1899, 11, 30));
      var d = new Date(epoch.getTime() + v * 86400000);
      return d.toISOString().slice(0,10);
    }
    var s = String(v).trim();
    // dd/mm/aaaa
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      var y = m[3].length === 2 ? ('20' + m[3]) : m[3];
      return y + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
    }
    // aaaa-mm-dd
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    var d2 = new Date(s);
    return isNaN(d2) ? null : d2.toISOString().slice(0,10);
  }

  /* ── Supabase ─────────────────────────────────────────────── */
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
      method: method, headers: sbHeaders(!!body),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        if (!res.ok) throw new Error(res.status + ': ' + txt.slice(0, 320));
        try { return JSON.parse(txt); } catch (_) { return []; }
      });
    });
  }
  function sbGetAll(path) {
    var out = [], step = 1000;
    function grab(from) {
      var h = sbHeaders(false);
      h.Range = from + '-' + (from + step - 1);
      return fetch(SB_URL + '/rest/v1/' + path, { headers: h })
        .then(function (res) {
          return res.text().then(function (txt) {
            if (!res.ok) throw new Error(res.status + ': ' + txt.slice(0, 320));
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
  function sbInsertChunked(table, rows, chunkSize, extraQS) {
    var size = chunkSize || 300;
    var qs = extraQS ? ('?' + extraQS) : '';
    var i = 0;
    function next() {
      if (i >= rows.length) return Promise.resolve(rows.length);
      var slice = rows.slice(i, i + size);
      i += size;
      return sb('POST', table + qs, slice)
        .catch(function (e1) {
          return new Promise(function (r){ setTimeout(r, 700); })
            .then(function () { return sb('POST', table + qs, slice); })
            .catch(function () { throw e1; });
        })
        .then(next);
    }
    return next();
  }
  function isMissingTable(err) {
    return /42P01|PGRST205|PGRST20[26]|does not exist|Could not find the table/i
      .test(String(err && err.message || err));
  }

  /* ── Sessão / permissões ─────────────────────────────────── */
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
  function canEdit() {
    var perfil = sessionStorage.getItem('pco_perfil') || '';
    if (perfil === 'admin') return true;
    if (typeof global.pcoPodeAdministrar === 'function') {
      try { if (global.pcoPodeAdministrar(MOD_KEY)) return true; } catch (_) {}
    }
    return false;
  }

  /* ── Wrappers de unidade ─────────────────────────────────── */
  function comUnidade(path) {
    if (typeof global.pcoComUnidade === 'function') return global.pcoComUnidade(path);
    var u = 'unidade=eq.' + encodeURIComponent(sessionStorage.getItem('pco_unidade') || 'RDN');
    return path + (path.indexOf('?') > -1 ? '&' : '?') + u;
  }
  function comTag(obj) {
    if (typeof global.pcoComTag === 'function') return global.pcoComTag(obj);
    obj.unidade = sessionStorage.getItem('pco_unidade') || 'RDN';
    return obj;
  }

  /* ── Toast simples ───────────────────────────────────────── */
  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'cg-toast ' + (kind || 'ok');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function(){ t.classList.add('show'); }, 10);
    setTimeout(function(){
      t.classList.remove('show');
      setTimeout(function(){ t.remove(); }, 250);
    }, 3200);
  }

  /* ── SheetJS lazy-load ────────────────────────────────────── */
  var _xlsxP = null;
  function ensureXLSX() {
    if (global.XLSX) return Promise.resolve(global.XLSX);
    if (_xlsxP) return _xlsxP;
    _xlsxP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      // 0.18.5 é a última versão do SheetJS hospedada no cdnjs.
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload  = function () { resolve(global.XLSX); };
      s.onerror = function () {
        reject(new Error('Falha ao carregar SheetJS de https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js — cheque a conexão ou o bloqueio de CDN pela rede.'));
      };
      document.head.appendChild(s);
    });
    return _xlsxP;
  }

  /* ── Leitura do Excel do cronograma geral ─────────────────
     Cabeçalhos esperados (deacc):
       NUMERO DE ESTRUTURA DE TOPICOS | NUMERO TOPICO | WBS
       NOME DA ATIVIDADE | NOME | ATIVIDADE
       FASE
       TIPO | TIPO DE PACOTE | TIPO PACOTE
       CWA
       CWP | DISCIPLINA
       EMPRESA | EMPRESA EXECUTORA
       CUSTO LB | CUSTO DA LINHA DE BASE | CUSTO LINHA DE BASE | BASELINE COST
       INICIO LB | INICIO DA LINHA DE BASE | START LB
       TERMINO LB | TERMINO DA LINHA DE BASE | FINISH LB
       NIVEL | ESTRUTURA DE TOPICOS NIVEL
       PAI | NUMERO PAI | PAI TOPICO
     Toda outra coluna é ignorada. */
  var HEAD_MAP = {
    numero_topico:  ['NUMERO DE ESTRUTURA DE TOPICOS','NUMERO ESTRUTURA DE TOPICOS','NUMERO TOPICO','ESTRUTURA DE TOPICOS','WBS'],
    nome:           ['NOME DA ATIVIDADE','NOME','ATIVIDADE'],
    fase:           ['FASE'],
    tipo_pacote:    ['TIPO','TIPO DE PACOTE','TIPO PACOTE'],
    cwa:            ['CWA','AREA','ÁREA'],
    cwp:            ['CWP','DISCIPLINA'],
    empresa:        ['EMPRESA','EMPRESA EXECUTORA','EMPRESA CONTRATADA'],
    custo_lb:       ['CUSTO LB','CUSTO DA LINHA DE BASE','CUSTO LINHA DE BASE','BASELINE COST','CUSTO BASELINE','CUSTO PREVISTO'],
    inicio_lb:      ['INICIO LB','INICIO DA LINHA DE BASE','START LB','INICIO BASELINE','INICIO PREVISTO'],
    termino_lb:     ['TERMINO LB','TERMINO DA LINHA DE BASE','FINISH LB','TERMINO BASELINE','TERMINO PREVISTO'],
    nivel:          ['NIVEL','ESTRUTURA DE TOPICOS NIVEL','LEVEL'],
    pai_topico:     ['PAI','NUMERO PAI','PAI TOPICO','PARENT WBS']
  };

  function detectHeaderMap(headerRow) {
    var map = {}; // field -> col index
    var normalized = headerRow.map(deacc);
    Object.keys(HEAD_MAP).forEach(function (field) {
      var candidates = HEAD_MAP[field];
      for (var i = 0; i < candidates.length; i++) {
        var idx = normalized.indexOf(candidates[i]);
        if (idx !== -1) { map[field] = idx; return; }
      }
    });
    return map;
  }

  /* Normaliza fase / tipo aceitando várias grafias */
  var FASE_ALIAS = {
    'FASE I':'FASE_I','FASE 1':'FASE_I','FASE_I':'FASE_I','F1':'FASE_I','I':'FASE_I',
    'FASE II':'FASE_II','FASE 2':'FASE_II','FASE_II':'FASE_II','F2':'FASE_II','II':'FASE_II',
    'ARMAZEM':'ARMAZEM','ARMAZEM DE GRAOS':'ARMAZEM','ARMAZEM DE GRAOS':'ARMAZEM',
    'POSTO':'POSTO','POSTO DE COMBUSTIVEIS':'POSTO','POSTO DE COMBUSTIVEL':'POSTO'
  };
  var TIPO_ALIAS = {
    'PROJETO':'PROJETO','PROJETOS':'PROJETO','ENGENHARIA':'PROJETO',
    'FORNECIMENTO':'FORNECIMENTO','FORNECIMENTOS':'FORNECIMENTO','SUPRIMENTOS':'FORNECIMENTO','SUPRIMENTO':'FORNECIMENTO',
    'EXECUCAO':'EXECUCAO','EXECUCAO CIVIL':'EXECUCAO','EXECUCAO MONTAGEM':'EXECUCAO','MONTAGEM':'EXECUCAO','CONSTRUCAO':'EXECUCAO','OBRA':'EXECUCAO',
    'COMISSIONAMENTO':'COMISSIONAMENTO','COMISSIONAMENTOS':'COMISSIONAMENTO','PRE OPERACAO':'COMISSIONAMENTO','PRE-OPERACAO':'COMISSIONAMENTO'
  };
  function normFase(v) { return FASE_ALIAS[deacc(v)] || null; }
  function normTipo(v) { return TIPO_ALIAS[deacc(v)] || null; }

  function readWorkbookRows(file) {
    return ensureXLSX().then(function (X) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () { reject(new Error('Falha ao ler o arquivo.')); };
        reader.onload = function (e) {
          try {
            var wb = X.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
            var name = wb.SheetNames[0];
            var ws = wb.Sheets[name];
            var arr = X.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
            resolve({ sheetName: name, rows: arr });
          } catch (err) { reject(err); }
        };
        reader.readAsArrayBuffer(file);
      });
    });
  }

  /* Interpreta as linhas: retorna { header, mapa, atividades, erros } */
  function parseAtividades(rows, arquivoOrigem) {
    if (!rows || !rows.length) return { header: [], mapa: {}, atividades: [], erros: [{ linha: 0, msg: 'Planilha vazia' }] };
    // encontra a linha do header (a primeira que contenha "NOME" ou "FASE")
    var headerIdx = -1;
    for (var i = 0; i < Math.min(rows.length, 30); i++) {
      var joined = rows[i].map(function (c) { return deacc(c); }).join('|');
      if (joined.indexOf('NOME') > -1 && joined.indexOf('FASE') > -1) { headerIdx = i; break; }
    }
    if (headerIdx === -1) return { header: [], mapa: {}, atividades: [], erros: [{ linha: 0, msg: 'Cabeçalho não encontrado (a planilha precisa ter as colunas NOME e FASE).' }] };

    var header = rows[headerIdx];
    var mapa = detectHeaderMap(header);
    var faltando = ['numero_topico','nome','fase','tipo_pacote']
      .filter(function (k) { return mapa[k] == null; });
    if (faltando.length) {
      return { header: header, mapa: mapa, atividades: [], erros: [{ linha: headerIdx + 1,
        msg: 'Faltam colunas obrigatórias: ' + faltando.join(', ') }] };
    }

    var atividades = [], erros = [];
    for (var r = headerIdx + 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row.every(function (c) { return c == null || c === ''; })) continue;
      var linha = r + 1;
      var numero = String(row[mapa.numero_topico] == null ? '' : row[mapa.numero_topico]).trim();
      var nome   = String(row[mapa.nome]          == null ? '' : row[mapa.nome]).trim();
      var faseR  = row[mapa.fase], tipoR = row[mapa.tipo_pacote];

      if (!numero) { erros.push({ linha: linha, msg: 'numero_topico vazio' }); continue; }
      if (!nome)   { erros.push({ linha: linha, msg: 'nome vazio' }); continue; }

      var fase = normFase(faseR);
      if (!fase) { erros.push({ linha: linha, msg: 'fase inválida: "' + faseR + '"' }); continue; }
      var tipo = normTipo(tipoR);
      if (!tipo) { erros.push({ linha: linha, msg: 'tipo inválido: "' + tipoR + '"' }); continue; }

      var custo = mapa.custo_lb   != null ? parseNum(row[mapa.custo_lb])   : null;
      var iniLB = mapa.inicio_lb  != null ? toISO(row[mapa.inicio_lb])     : null;
      var fimLB = mapa.termino_lb != null ? toISO(row[mapa.termino_lb])    : null;
      var nivel = mapa.nivel      != null ? parseNum(row[mapa.nivel])      : null;
      var pai   = mapa.pai_topico != null ? String(row[mapa.pai_topico] || '').trim() : null;
      if (pai === '') pai = null;

      atividades.push({
        numero_topico:  numero,
        nome:           nome,
        fase:           fase,
        tipo_pacote:    tipo,
        cwa:            mapa.cwa     != null ? String(row[mapa.cwa]     || '').trim() || null : null,
        cwp:            mapa.cwp     != null ? String(row[mapa.cwp]     || '').trim() || null : null,
        empresa:        mapa.empresa != null ? String(row[mapa.empresa] || '').trim() || null : null,
        custo_lb:       custo,
        inicio_lb:      iniLB,
        termino_lb:     fimLB,
        nivel:          nivel != null ? Math.round(nivel) : null,
        pai_topico:     pai,
        arquivo_origem: arquivoOrigem || null,
        _linha:         linha
      });
    }

    // duplicados por numero_topico dentro do próprio arquivo
    var seen = {};
    atividades.forEach(function (a) {
      if (seen[a.numero_topico]) {
        erros.push({ linha: a._linha, msg: 'numero_topico duplicado no arquivo: ' + a.numero_topico });
      } else {
        seen[a.numero_topico] = a._linha;
      }
    });

    return { header: header, mapa: mapa, atividades: atividades, erros: erros };
  }

  /* ── Salva no Supabase (upsert por (unidade, numero_topico)) ─
     Estratégia:
       1) POST em blocos com Prefer: resolution=merge-duplicates
          (funciona se houver unique(unidade, numero_topico), o que
          a migração garante).
       2) marca "ativo=false" para o que existe no banco mas não
          veio no arquivo (opcional, controlado por flag). */
  function upsertAtividades(atividades, opts) {
    opts = opts || {};
    var payload = atividades.map(function (a) {
      var copy = {};
      Object.keys(a).forEach(function (k) { if (k[0] !== '_') copy[k] = a[k]; });
      copy.criado_por    = userNome();
      copy.atualizado_em = new Date().toISOString();
      copy.ativo         = true;
      return comTag(copy);
    });
    var qs = 'on_conflict=' + encodeURIComponent('unidade,numero_topico');
    var extraHeaders = { Prefer: 'return=representation,resolution=merge-duplicates' };
    var i = 0, size = 300;
    function next() {
      if (i >= payload.length) return Promise.resolve(payload.length);
      var slice = payload.slice(i, i + size);
      i += size;
      return fetch(SB_URL + '/rest/v1/cron_geral_atividades?' + qs, {
        method: 'POST',
        headers: Object.assign(sbHeaders(true), extraHeaders),
        body: JSON.stringify(slice)
      }).then(function (res) {
        return res.text().then(function (txt) {
          if (!res.ok) throw new Error(res.status + ': ' + txt.slice(0, 320));
          return next();
        });
      });
    }
    return next().then(function () {
      if (!opts.desativarAusentes) return { inseridos: payload.length, desativados: 0 };
      var topicos = payload.map(function (a) { return a.numero_topico; });
      // marca ativo=false para os que sumiram — filtro not.in
      var lista = topicos.map(function (t) { return '"' + String(t).replace(/"/g,'\\"') + '"'; }).join(',');
      var url = comUnidade('cron_geral_atividades?numero_topico=not.in.(' + lista + ')');
      return sb('PATCH', url, { ativo: false, atualizado_em: new Date().toISOString() })
        .then(function (res) { return { inseridos: payload.length, desativados: (res && res.length) || 0 }; })
        .catch(function () { return { inseridos: payload.length, desativados: 0 }; });
    });
  }

  /* ── Gera o modelo .xlsx para download ────────────────────── */
  function baixarModelo() {
    return ensureXLSX().then(function (X) {
      var wb = X.utils.book_new();

      // aba principal com cabeçalhos + uma linha de exemplo
      var header = [
        'Número da Estrutura de Tópicos','Nome da Atividade','Fase','Tipo',
        'CWA','CWP','Empresa','Custo LB','Início LB','Término LB','Nível','Pai'
      ];
      var exemplo = [
        '1.1.3.1',
        'Instalação de gradil metálico e postes esticadores',
        'Fase I','Execução',
        '2123.A - PORTARIA, VESTIÁRIO, REFEITÓRIO, RH E MONITORAMENTO',
        'CIV - Civil',
        'APOLINÁRIO',
        150000, '2026-08-17','2026-09-05', 5, '1.1.3'
      ];
      var ws = X.utils.aoa_to_sheet([header, exemplo]);
      // largura das colunas
      ws['!cols'] = [
        {wch:16},{wch:56},{wch:10},{wch:16},{wch:44},{wch:22},{wch:22},{wch:14},{wch:12},{wch:12},{wch:6},{wch:12}
      ];
      X.utils.book_append_sheet(wb, ws, 'Atividades');

      // aba de referência com valores válidos
      var ref = [
        ['FASES aceitas','TIPOS aceitos'],
        ['Fase I','Projetos'],
        ['Fase II','Fornecimentos'],
        ['Armazém de Grãos','Execução'],
        ['Posto de Combustíveis','Comissionamentos']
      ];
      var wsRef = X.utils.aoa_to_sheet(ref);
      wsRef['!cols'] = [{wch:28},{wch:22}];
      X.utils.book_append_sheet(wb, wsRef, 'Referência');

      // aba README
      var readme = [
        ['MODELO DE IMPORTAÇÃO — CRONOGRAMA EXECUTIVO GERAL'],
        [''],
        ['Como preencher:'],
        ['- Uma linha por atividade. Colunas obrigatórias: Número, Nome, Fase, Tipo.'],
        ['- Fase e Tipo aceitam as grafias listadas na aba "Referência".'],
        ['- Custo LB em reais (o rateio proporcional para as terceiras usa esse valor).'],
        ['- Datas no formato dd/mm/aaaa ou aaaa-mm-dd.'],
        ['- "Pai" é o Número da Estrutura de Tópicos da atividade-mãe (ex.: pai de "1.1.3.1" é "1.1.3").'],
        ['- O sistema faz UPSERT por Número: reimportar substitui as linhas existentes por Número.'],
        ['- Se marcar "desativar ausentes" na tela, atividades que sumiram do arquivo ficam inativas'],
        ['  (não somem — para não quebrar vínculos com terceiras já criados).'],
        [''],
        ['Colunas extras no arquivo são ignoradas.']
      ];
      var wsR = X.utils.aoa_to_sheet(readme);
      wsR['!cols'] = [{wch:90}];
      X.utils.book_append_sheet(wb, wsR, 'README');

      X.writeFile(wb, 'modelo_cronograma_geral.xlsx');
    });
  }

  /* ── Estilos globais compartilhados (toast + widgets simples) ─ */
  function injectCSS() {
    if (document.getElementById('cg-css')) return;
    var css = document.createElement('style');
    css.id = 'cg-css';
    css.textContent = "\
.cg-toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,20px);background:#1a2332;color:#fff;padding:12px 22px;border-radius:4px;font-size:13px;font-weight:500;box-shadow:0 8px 30px -6px rgba(0,0,0,.35);opacity:0;transition:.25s;z-index:9999;pointer-events:none;max-width:520px}\
.cg-toast.show{opacity:1;transform:translate(-50%,0)}\
.cg-toast.ok{background:#0f5c47}.cg-toast.warn{background:#8a3822}\
";
    document.head.appendChild(css);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectCSS);
  } else { injectCSS(); }

  /* ── Exports ─────────────────────────────────────────────── */
  global.CG = {
    MOD_KEY: MOD_KEY, MOD_TITLE: MOD_TITLE, PAGES: PAGES,
    FASES: FASES, TIPOS: TIPOS,
    $: $, esc: esc, parseNum: parseNum, nf: nf, nfMoney: nfMoney, deacc: deacc,
    fmtBr: fmtBr, toISO: toISO,
    sb: sb, sbGetAll: sbGetAll, sbInsertChunked: sbInsertChunked, isMissingTable: isMissingTable,
    comUnidade: comUnidade, comTag: comTag,
    requireAuth: requireAuth, userNome: userNome, canEdit: canEdit,
    toast: toast,
    ensureXLSX: ensureXLSX,
    readWorkbookRows: readWorkbookRows,
    parseAtividades: parseAtividades,
    upsertAtividades: upsertAtividades,
    baixarModelo: baixarModelo,
    normFase: normFase, normTipo: normTipo
  };

})(window);
