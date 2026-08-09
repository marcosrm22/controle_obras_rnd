/* ================================================================
   lps_ei_materiais_calc.js — Motor de materiais do LPS E&I
   ----------------------------------------------------------------
   Compartilhado por lps_ei_materiais.html (upload + status) e
   lps_ei.html (painel por área). Carregar depois de lps_ei_core.js.

   ESTRUTURA DO SNAPSHOT (coluna `dados` de lps_ei_materiais_snapshots)
   {
     gerado : '05/08/2026',
     listas : [ { tag, rev, cat, nome, src, arquivo, carregado,
                  items: [ [ref, cod, desc, un, qtd, peso, line, area] ] } ],
     tracker: { arquivo, carregado, map:{campo:indiceColuna},
                header:[...], rows:[ {cod,desc,un,area,line,
                                      q_sol,q_ped,q_rec,status,
                                      pedido,fornec,prev} ] },
     areasExtra : { 'LINE-123':'MOA', ... }   // overrides manuais
   }
   ================================================================ */

(function (global) {
  'use strict';

  var L = global.LPS;
  if (!L) { console.error('lps_ei_core.js precisa ser carregado antes.'); return; }

  var deacc = L.deacc, parseNum = L.parseNum;

  /* ================================================================
     1. CLASSIFICAÇÃO DE STATUS DO TRACKER
     ================================================================ */

  /* Ordem importa: o primeiro padrão que casar vence. */
  var STATUS_RULES = [
    { k: 'cancelado', re: /CANCEL/ },
    { k: 'recebido',  re: /RECEB|ENTREGU|NO ALMOX|EM OBRA|LIBERAD/ },
    { k: 'transito',  re: /TRANSIT|EMBARC|DESPACH|EXPEDI|COLETAD|NAVIO|A CAMINHO|FATURAD/ },
    { k: 'producao',  re: /PRODUC|FABRIC|EM FABRIC|MANUFAT/ },
    { k: 'pedido',    re: /PEDID|COLOCAD|OC |ORDEM DE COMPRA|COMPRAD|CONTRATAD|APROVAD/ },
    { k: 'cotacao',   re: /COTAC|RFQ|NEGOCIA|CONCORR|EM COMPRA|SOLICIT|REQUISI/ }
  ];

  var STATUS_META = {
    recebido:  { label: 'Recebido',        cls: 'g', ord: 1 },
    transito:  { label: 'Em trânsito',     cls: 'b', ord: 2 },
    producao:  { label: 'Em fabricação',   cls: 'v', ord: 3 },
    pedido:    { label: 'Pedido colocado', cls: 'y', ord: 4 },
    cotacao:   { label: 'Em cotação',      cls: 'y', ord: 5 },
    naopedido: { label: 'Não pedido',      cls: 'r', ord: 6 },
    cancelado: { label: 'Cancelado',       cls: 'n', ord: 7 },
    parcial:   { label: 'Parcial',         cls: 'y', ord: 3 }
  };

  function classifyStatus(txt) {
    var s = deacc(txt);
    if (!s) return null;
    for (var i = 0; i < STATUS_RULES.length; i++) {
      if (STATUS_RULES[i].re.test(s)) return STATUS_RULES[i].k;
    }
    return null;
  }

  /* ================================================================
     2. LISTAS DE MATERIAL (Aplus / VIA PACS)
     Mesmo layout usado no comparativo de compras:
     item = [ref, cod, desc, un, qtd, peso, line, area]
     ================================================================ */

  var IDX = { REF: 0, COD: 1, DESC: 2, UN: 3, QTD: 4, PESO: 5, LINE: 6, AREA: 7 };

  /* Normaliza código de material.
     Só vira número quando a célula é inteiramente numérica — códigos
     alfanuméricos (CB.ATR.70, HT.SR.3/4.3000) precisam ser preservados
     como texto, senão viram lixo e colidem entre si. */
  /* O export do Tracker traz a coluna do código com formato de DATA aplicado.
     Com cellDates o SheetJS devolve um Date e o código (64953) viraria
     "Sat Oct 30 2077...". Aqui o número de série do Excel é recuperado. */
  function serialDoExcel(d) {
    var ms = d.getTime() - Date.UTC(1899, 11, 30);
    var n = Math.round(ms / 86400000);
    return (n > 0 && n < 400000) ? n : null;
  }

  function normCod(v) {
    if (v instanceof Date && !isNaN(v)) {
      var n = serialDoExcel(v);
      if (n != null) return n;
    }
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (/^\d+[.,]0+$/.test(s)) return parseInt(s, 10);   // 1234.0 vindo do Excel
    return s.toUpperCase().replace(/\s+/g, ' ');
  }

  /* Códigos que a lista traz no lugar de um código real */
  var COD_VAZIO = /^(TERCEIRO|TERCEIROS|A\s*DEFINIR|A\s*COTAR|A\s*ESPECIFICAR|SEM\s*CODIGO|OMISSO|OMISSOS|N\/?A|NA|VB|X|-+|\.+)$/;
  function codIgnoravel(c) {
    if (c instanceof Date) return serialDoExcel(c) == null;
    var s = deacc(c);
    return !s || COD_VAZIO.test(s) || s.length > 60;
  }

  function readSheet(file) {
    return L.ensureXLSX().then(function (X) {
      return new Promise(function (resolve, reject) {
        var rd = new FileReader();
        rd.onerror = function () { reject(new Error('não foi possível ler o arquivo')); };
        rd.onload = function (ev) {
          try {
            var wb = X.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true });
            var sheets = wb.SheetNames.map(function (n) {
              return { name: n, aoa: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }) };
            });
            resolve(sheets);
          } catch (e) { reject(new Error('planilha ilegível')); }
        };
        rd.readAsArrayBuffer(file);
      });
    });
  }

  /* Aba de trabalho: a de nome preferido, senão a com mais linhas */
  function pickSheet(sheets, prefer) {
    if (prefer) {
      var alvo = sheets.filter(function (s) { return deacc(s.name) === prefer; })[0];
      if (alvo) return alvo;
    }
    var best = null;
    sheets.forEach(function (s) {
      if (!best || (s.aoa || []).length > (best.aoa || []).length) best = s;
    });
    return best || { name: '', aoa: [] };
  }

  /* Acha a linha de cabeçalho pelo conjunto de colunas esperado */
  function findHeader(aoa, testFn, limit) {
    var lim = Math.min(aoa.length, limit || 60);
    for (var i = 0; i < lim; i++) {
      var row = (aoa[i] || []).map(deacc);
      if (testFn(row)) return i;
    }
    return -1;
  }

  /* Metadados chave/valor acima do cabeçalho (TAG DOCUMENTO, REVISÃO...) */
  function readMeta(aoa, hr) {
    var meta = {};
    for (var i = 0; i < hr; i++) {
      var r = aoa[i] || [], ki = -1;
      for (var j = 0; j < r.length; j++) {
        if (String(r[j]).trim() !== '') { ki = j; break; }
      }
      if (ki < 0) continue;
      var k = deacc(r[ki]), v = '';
      for (var j2 = ki + 1; j2 < r.length; j2++) {
        if (String(r[j2]).trim() !== '') { v = String(r[j2]).trim(); break; }
      }
      if (k) meta[k] = v;
    }
    return meta;
  }

  /* ----------------------------------------------------------------
     Modelo ON7 — Aterramento / SPDA
     Aba "LM", bloco de cabeçalho chave/valor (CLIENTE, OBRA, PRÉDIO,
     DISCIPLINA) e tabela ITEM | CÓDIGO INPASA | DESCRIÇÃO | UNID. |
     TOTAL PROJETO. A área vale para o arquivo inteiro — vem do campo
     PRÉDIO (ou ÁREA), não de uma coluna.
     Sem LINE NUMBER: o casamento com o tracker é por código.
     ---------------------------------------------------------------- */

  function on7Header(aoa) {
    return findHeader(aoa, function (row) {
      var temCod  = row.some(function (c) { return c.indexOf('CODIGO') > -1; });
      var temDesc = row.some(function (c) { return c.indexOf('DESCRI') > -1; });
      var temTot  = row.some(function (c) {
        return c.indexOf('TOTAL PROJETO') > -1 || c.indexOf('QUANT') > -1 || c === 'TOTAL';
      });
      var temItem = row.some(function (c) { return c === 'ITEM'; });
      return temCod && temDesc && temTot && temItem;
    }, 40);
  }

  /* Área do arquivo: PRÉDIO / ÁREA no bloco acima da tabela */
  function on7Area(sheets, aoa, hr) {
    var rotulos = ['PREDIO', 'AREA', 'LOCAL DE APLICACAO', 'UNIDADE'];
    function varrer(rows, lim) {
      for (var i = 0; i < Math.min(rows.length, lim); i++) {
        var r = rows[i] || [];
        for (var j = 0; j < r.length; j++) {
          var k = deacc(r[j]).replace(/:$/, '');
          if (rotulos.indexOf(k) < 0) continue;
          for (var j2 = j + 1; j2 < r.length; j2++) {
            var v = String(r[j2]).trim();
            if (v) return v;
          }
        }
      }
      return '';
    }
    var a = varrer(aoa, hr);
    if (a) return a;
    var capa = sheets.filter(function (s) { return deacc(s.name) === 'CAPA'; })[0];
    return capa ? varrer(capa.aoa, 40) : '';
  }

  function parseON7(file, sheets, lm, hr) {
    var aoa = lm.aoa;
    var H = (aoa[hr] || []).map(deacc);
    var colIn = function (sub) {
      for (var j = 0; j < H.length; j++) if (H[j].indexOf(sub) > -1) return j;
      return -1;
    };
    var iItem = H.indexOf('ITEM');
    var iCod  = colIn('CODIGO');
    var iDesc = colIn('DESCRI');
    var iUn   = colIn('UNID');
    var iQtd  = colIn('TOTAL PROJETO');
    if (iQtd < 0) iQtd = colIn('QUANT');
    if (iQtd < 0) iQtd = H.indexOf('TOTAL');

    var areaTxt = on7Area(sheets, aoa, hr);
    var disc = '';
    for (var i0 = 0; i0 < hr; i0++) {
      var r0 = aoa[i0] || [];
      for (var j0 = 0; j0 < r0.length; j0++) {
        if (deacc(r0[j0]).replace(/:$/, '') !== 'DISCIPLINA') continue;
        for (var j1 = j0 + 1; j1 < r0.length; j1++) {
          if (String(r0[j1]).trim()) { disc = String(r0[j1]).trim(); break; }
        }
      }
    }

    var items = [], ignorados = 0, grupo = '';
    for (var i = hr + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      var item = String(iItem >= 0 ? r[iItem] : '').trim();

      /* fora da tabela (Notas:, assinaturas) → encerra a leitura */
      if (item && !/^\d+(\.\d+)*\.?$/.test(item)) break;

      var codRaw = iCod >= 0 ? r[iCod] : '';
      if (codRaw instanceof Date) codRaw = String(normCod(codRaw));
      codRaw = String(codRaw == null ? '' : codRaw).trim();
      var desc   = String(iDesc >= 0 ? r[iDesc] : '').trim();

      /* linha de grupo: item "1." sem código, descrição é o título */
      if (!codRaw) {
        if (item && /\.$/.test(item) && desc) grupo = desc;
        else if (desc) ignorados++;
        continue;
      }
      if (codIgnoravel(codRaw)) { ignorados++; continue; }

      items.push([
        '',                                   // ref
        normCod(codRaw),                      // cod
        desc.slice(0, 120),                   // desc
        String(iUn >= 0 ? r[iUn] : '').trim(),// un
        parseNum(iQtd >= 0 ? r[iQtd] : 0),    // qtd
        0,                                    // peso
        '',                                   // line number (não existe)
        areaTxt                               // área do arquivo inteiro
      ]);
    }
    if (!items.length) {
      return { err: 'nenhum item com código mapeado na aba ' + lm.name, name: file.name };
    }

    var base = file.name.replace(/\.[^.]+$/, '');
    var mrev = base.match(/[-_]R(?:EV)?[\s_-]*(\d+)/i);

    return {
      tag: base, tags: [base], rev: mrev ? mrev[1] : '', cat: 'Aterramento / SPDA',
      nome: disc || 'Lista ON7 — Aterramento',
      src: 'ON7',
      area: areaTxt,
      arquivo: file.name,
      aba: lm.name,
      ignorados: ignorados,
      carregado: new Date().toISOString(),
      items: items
    };
  }

  /* Parser genérico de lista de material.
     Detecta o layout: ON7 (aba LM, área no cabeçalho),
     VIA PACS (COD + REFERÊNCIA + LINE NUMBER) ou
     Aplus (CÓDIGO + LINE NUMBER). */
  function parseListaFile(file) {
    return readSheet(file).then(function (sheets) {
      /* ---- ON7: procura a aba LM, senão qualquer aba com o layout ---- */
      var lm = pickSheet(sheets, 'LM');
      var hrOn7 = on7Header(lm.aoa);
      if (hrOn7 < 0) {
        for (var s = 0; s < sheets.length; s++) {
          var h = on7Header(sheets[s].aoa);
          if (h > -1) { lm = sheets[s]; hrOn7 = h; break; }
        }
      }
      if (hrOn7 > -1) return parseON7(file, sheets, lm, hrOn7);

      /* ---- Aplus / VIA PACS ---- */
      var alvo = pickSheet(sheets, null);
      var aoa = alvo.aoa;
      var isPacs = false;
      var hr = findHeader(aoa, function (row) {
        var hasCod = row.indexOf('COD') > -1;
        var hasRef = row.some(function (c) { return c.indexOf('REFERENCIA') > -1; });
        var hasLn  = row.some(function (c) { return c.indexOf('LINE NUMBER') > -1; });
        if (hasCod && hasRef && hasLn) { isPacs = true; return true; }
        return false;
      });
      if (hr < 0) {
        hr = findHeader(aoa, function (row) {
          return row.some(function (c) { return c.indexOf('CODIGO') > -1; }) &&
                 row.some(function (c) { return c.indexOf('LINE NUMBER') > -1; });
        });
      }
      if (hr < 0) {
        return { err: 'cabeçalho não reconhecido (esperado CÓDIGO/COD + LINE NUMBER, ou aba LM no modelo ON7)', name: file.name };
      }

      var H = (aoa[hr] || []).map(deacc);
      var colEq = function (v) { return H.indexOf(v); };
      var colIn = function (sub) {
        for (var j = 0; j < H.length; j++) if (H[j].indexOf(sub) > -1) return j;
        return -1;
      };

      var iCod, iRef;
      if (isPacs) { iCod = colEq('COD'); iRef = colIn('REFERENCIA'); }
      else        { iCod = colIn('CODIGO'); iRef = iCod; }

      var iDesc = colIn('DESCRICAO MATERIAL');
      if (iDesc < 0) iDesc = colIn('DESCRI');
      var iBit  = colIn('BITOLA');
      if (iBit < 0) iBit = colIn('UNIDADE');
      var iQtdI = colIn('QUANTIDADE IMPORTACAO');
      var iQtd  = colEq('QTD');
      if (iQtd < 0) iQtd = colIn('QTD');
      var iComp = colIn('COMP');
      var iPeso = colIn('PESO');
      var iLn   = colIn('LINE NUMBER');
      var iAr   = colIn('AREA');

      var meta = readMeta(aoa, hr);
      var tag = meta['TAG DOCUMENTO'] || '';
      var cat = meta['CATEGORIA'] || '';
      var descDoc = meta['DESCRICAO'] || '';
      var rev = '';
      Object.keys(meta).forEach(function (k) {
        if (k.indexOf('REVISAO') === 0 && !rev) rev = meta[k];
      });
      rev = String(rev).replace(/\.0+$/, '');
      if (!rev) { var m = file.name.match(/REV[\s_-]*(\d+)/i); if (m) rev = m[1]; }
      if (!tag) tag = file.name.replace(/\.[^.]+$/, '');
      /* a lista pode declarar mais de uma TAG (ex.: TAG DOCUMENTO + TAG DOCUMENTO ON7);
         todas valem para casar com o documento gravado no Tracker */
      var tags = [tag];
      Object.keys(meta).forEach(function (k) {
        if (k.indexOf('TAG') !== 0) return;
        var v = String(meta[k] || '').trim();
        if (v && tags.indexOf(v) < 0) tags.push(v);
      });

      var items = [];
      for (var i = hr + 1; i < aoa.length; i++) {
        var r = aoa[i] || [];
        var codRaw = iCod >= 0 ? r[iCod] : '';
        if (codRaw == null || String(codRaw).trim() === '') continue;
        var cod = normCod(codRaw);
        var refRaw = iRef >= 0 ? r[iRef] : '';
        var ref = (refRaw == null || refRaw === '') ? '' : String(normCod(refRaw));
        var qtd = iQtdI >= 0 ? parseNum(r[iQtdI]) : 0;
        if (!qtd) qtd = parseNum(iQtd >= 0 ? r[iQtd] : 0) || parseNum(iComp >= 0 ? r[iComp] : 0);
        items.push([
          ref,
          cod,
          String(iDesc >= 0 ? r[iDesc] : '').trim().slice(0, 120),
          String(iBit >= 0 ? r[iBit] : '').trim(),
          qtd,
          parseNum(iPeso >= 0 ? r[iPeso] : 0),
          String(iLn >= 0 ? r[iLn] : '').trim(),
          String(iAr >= 0 ? r[iAr] : '').trim()
        ]);
      }
      if (!items.length) return { err: 'nenhum item encontrado abaixo do cabeçalho', name: file.name };

      return {
        tag: tag, tags: tags, rev: rev, cat: cat,
        nome: descDoc || cat || tag,
        src: isPacs ? 'PACS' : 'APLUS',
        arquivo: file.name,
        carregado: new Date().toISOString(),
        items: items
      };
    }).catch(function (e) {
      return { err: e.message || 'erro ao processar', name: file.name };
    });
  }

  /* ================================================================
     3. TRACKER (base de dados de suprimentos)
     Layout desconhecido/variável → detecção automática + mapeamento
     manual pela interface.
     ================================================================ */

  var TRACKER_FIELDS = [
    { k: 'cod',    label: 'Código do material (sistema)', req: true,
      hints: ['COD MATERIAL', 'CODIGO MATERIAL', 'COD. MATERIAL', 'MATERIAL', 'COD SAP', 'CODIGO', 'COD', 'ITEM'] },
    { k: 'cod2',   label: 'Código interno / ref. engenharia', req: false,
      hints: ['CODIGO INTERNO', 'COD INTERNO', 'REFERENCIA ENGENHARIA', 'REF ENGENHARIA', 'CODIGO ENGENHARIA', 'TAG MATERIAL'] },
    { k: 'doc',    label: 'Documento da lista (LM)', req: false,
      hints: ['DESCRICAO PROJETO', 'DESC PROJETO', 'PROJETO', 'DOCUMENTO', 'LISTA DE MATERIAL', 'TAG DOCUMENTO', 'COD_PROJETO'] },
    { k: 'docrev', label: 'Revisão do documento', req: false,
      hints: ['VERSAO LM', 'VERSAO LISTA', 'REVISAO LM', 'REV LM', 'VERSAO DOCUMENTO'] },
    { k: 'docdata',label: 'Data do documento', req: false,
      hints: ['DATA LM', 'DATA LISTA', 'DATA DOCUMENTO', 'DATA REVISAO'] },
    { k: 'desc',   label: 'Descrição', req: false,
      hints: ['DESC MATERIAL', 'DESCRICAO MATERIAL', 'DESCRICAO DO MATERIAL', 'DESCRIPTION', 'TEXTO BREVE', 'DESCRICAO'] },
    { k: 'un',     label: 'Unidade', req: false,
      hints: ['COD UNIDADE', 'UNIDADE MEDIDA', 'UN MEDIDA', 'UNIDADE DE MEDIDA', 'BITOLA', 'UM'] },
    { k: 'area',   label: 'Área', req: false,
      hints: ['AREA DESTINO', 'AREA OBRA', 'AREA', 'SETOR', 'LOCAL'] },
    { k: 'line',   label: 'Line Number (da lista)', req: false,
      hints: ['LINE NUMBER', 'LINENUMBER', 'LINE  NUMBER', 'ITEM LISTA', 'NUMERO DA LINHA'] },
    { k: 'q_sol',  label: 'Qtd. solicitada', req: false,
      hints: ['QTD SOLICITADA', 'QUANTIDADE SOLICITADA', 'QTD REQUISITADA', 'QTD LISTA', 'QTD PREVISTA', 'QTD'] },
    { k: 'q_ped',  label: 'Qtd. pedida (OC)', req: false,
      hints: ['QTD PEDIDA', 'QUANTIDADE PEDIDA', 'QTD COMPRADA', 'QTD OC', 'QTD PEDIDO'] },
    { k: 'q_rec',  label: 'Qtd. recebida', req: false,
      hints: ['QTDE_TOTAL_FATURADA', 'QTD RECEBIDA', 'QUANTIDADE RECEBIDA', 'QTDE TOTAL FATURADA', 'QTD FATURADA', 'QTD ENTREGUE', 'QTD RECEB'] },
    { k: 'status', label: 'Status', req: false,
      hints: ['STATUS ITEM', 'STATUS MATERIAL', 'SITUACAO', 'STATUS'] },
    { k: 'pedido', label: 'Nº do pedido / OC', req: false,
      hints: ['NUMERO PEDIDO', 'N PEDIDO', 'PEDIDO', 'OC', 'ORDEM DE COMPRA', 'NF'] },
    { k: 'fornec', label: 'Fornecedor', req: false,
      hints: ['FORNECEDOR', 'SUPPLIER', 'VENDOR'] },
    { k: 'prev',   label: 'Previsão de entrega', req: false,
      hints: ['PREVISAO ENTREGA', 'DATA PREVISTA', 'PREVISAO', 'ETA', 'DATA ENTREGA'] }
  ];

  function autoMap(header) {
    var H = header.map(deacc), map = {};
    TRACKER_FIELDS.forEach(function (f) {
      var best = -1, bestScore = -1;
      H.forEach(function (h, j) {
        if (!h) return;
        f.hints.forEach(function (hint, rank) {
          var score = -1;
          if (h === hint) score = 1000 - rank;
          else if (h.indexOf(hint) > -1) score = 500 - rank - Math.abs(h.length - hint.length);
          if (score > bestScore) { bestScore = score; best = j; }
        });
      });
      if (bestScore > 0) map[f.k] = best;
    });
    /* evita que dois campos apontem para a mesma coluna por engano */
    var used = {};
    ['cod', 'cod2', 'doc', 'q_rec', 'q_ped', 'q_sol', 'status', 'line', 'area', 'desc'].forEach(function (k) {
      if (map[k] == null) return;
      if (used[map[k]]) delete map[k]; else used[map[k]] = k;
    });
    return map;
  }

  /* Lê o tracker e devolve {header, aoa, map, rows} */
  function parseTrackerFile(file, forcedMap) {
    return readSheet(file).then(function (sheets) {
      var alvo = pickSheet(sheets, null);
      var aoa = alvo.aoa;
      /* cabeçalho = primeira linha com >=4 células preenchidas e algum
         termo típico; senão, a primeira linha "cheia" */
      var hr = findHeader(aoa, function (row) {
        var filled = row.filter(function (c) { return c !== ''; }).length;
        if (filled < 3) return false;
        return row.some(function (c) {
          return /COD|MATERIAL|ITEM/.test(c);
        });
      });
      if (hr < 0) {
        for (var i = 0; i < Math.min(aoa.length, 30); i++) {
          var filled = (aoa[i] || []).filter(function (c) { return String(c).trim() !== ''; }).length;
          if (filled >= 3) { hr = i; break; }
        }
      }
      if (hr < 0) return { err: 'não foi possível localizar o cabeçalho', name: file.name };

      var header = (aoa[hr] || []).map(function (c) { return String(c).trim(); });
      var map = forcedMap && Object.keys(forcedMap).length ? forcedMap : autoMap(header);
      var rows = buildTrackerRows(aoa, hr, map);
      if (!rows.length) return { err: 'nenhuma linha de item reconhecida', name: file.name, header: header, map: map };

      return {
        arquivo: file.name,
        aba: alvo.name,
        carregado: new Date().toISOString(),
        header: header,
        docs: buildDocs(aoa, hr, map),
        headerRow: hr,
        map: map,
        rows: rows,
        aoa: aoa
      };
    }).catch(function (e) {
      return { err: e.message || 'erro ao processar', name: file.name };
    });
  }

  function cellDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return L.toISO(v);
    var s = String(v).trim();
    var m = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[0];
    /* número de série do Excel (a coluna veio como número, sem formato) */
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      var n = parseFloat(s);
      if (n > 20000 && n < 80000) {
        return L.toISO(new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000));
      }
    }
    return null;
  }

  /* "APLUS-LM-CAL-2300-001 - LISTA DE MATERIAL DE TUBULACAO" -> "APLUS-LM-CAL-2300-001"
     Isola a TAG do documento para casar com a TAG das listas carregadas. */
  var RE_TAG = /([A-Z0-9]{2,12}-LM-[A-Z]{2,5}-[0-9][0-9.A-Z]*-\d+)/;
  function normDoc(v) {
    var s = deacc(v);
    if (!s) return '';
    var m = s.match(RE_TAG);
    if (m) return m[1];
    return s.split(' - ')[0].trim().slice(0, 60);
  }

  function buildTrackerRows(aoa, hr, map) {
    var g = function (r, k) { return map[k] == null ? '' : r[map[k]]; };
    var out = [];
    for (var i = hr + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      var codRaw = g(r, 'cod');
      if (codRaw == null || codRaw === '' || codIgnoravel(codRaw)) continue;
      var cod = normCod(codRaw);
      var c2Raw = g(r, 'cod2');
      var stTxt = String(g(r, 'status') || '').trim();
      out.push({
        cod: cod,
        cod2: (c2Raw == null || c2Raw === '' || codIgnoravel(c2Raw)) ? '' : normCod(c2Raw),
        doc: normDoc(g(r, 'doc')),
        docrev: String(g(r, 'docrev') || '').trim(),
        desc: String(g(r, 'desc') || '').trim().slice(0, 120),
        un: String(g(r, 'un') || '').trim(),
        area: String(g(r, 'area') || '').trim(),
        line: String(g(r, 'line') || '').trim(),
        q_sol: parseNum(g(r, 'q_sol')),
        q_ped: parseNum(g(r, 'q_ped')),
        q_rec: parseNum(g(r, 'q_rec')),
        status: stTxt,
        st: classifyStatus(stTxt),
        pedido: String(g(r, 'pedido') || '').trim(),
        fornec: String(g(r, 'fornec') || '').trim(),
        prev: cellDate(g(r, 'prev'))
      });
    }
    return out;
  }

  /* ================================================================
     4. AGREGAÇÃO — demanda (listas) × suprimento (tracker)
     ----------------------------------------------------------------
     Casamento em duas passadas:
       (a) por LINE NUMBER, quando o tracker traz a coluna — é o
           vínculo exato item-a-item;
       (b) por CÓDIGO DE MATERIAL, rateando a quantidade disponível
           entre as áreas proporcionalmente à demanda de cada uma.
     ================================================================ */

  function normLine(s) { return deacc(s).replace(/[^A-Z0-9]/g, ''); }

  /* ----------------------------------------------------------------
     Inventário de documentos (listas de material) a partir do Tracker.
     O Tracker é a fonte de verdade sobre QUAIS listas existem e em que
     revisão estão; as listas carregadas dizem quais já foram mapeadas.
     ---------------------------------------------------------------- */

  var DISC_LM = {
    ELE: 'Elétrica', AUT: 'Instrumentação', ATR: 'Aterramento / SPDA',
    INS: 'Instrumentação', CAL: 'Caldeiraria', PRO: 'Processo',
    CIV: 'Civil', DRE: 'Drenagem', MEC: 'Mecânica', TUB: 'Tubulação'
  };
  var DISC_EI = ['ELE', 'AUT', 'ATR', 'INS'];

  /* "APLUS-LM-CAL-2300-001" → { emp, disc, area, seq } */
  function partesTag(tag) {
    var m = String(tag || '').toUpperCase()
      .match(/^([A-Z0-9]+)-LM-([A-Z]{2,5})-([0-9][0-9.A-Z]*)-(\d+)$/);
    if (!m) return null;
    return { emp: m[1], disc: m[2], area: m[3], seq: m[4] };
  }

  function revNum(v) {
    if (v instanceof Date && !isNaN(v)) {
      var sr = serialDoExcel(v);
      return sr != null && sr < 500 ? sr : null;   // rev 1..n virou data no export
    }
    var n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
    if (isNaN(n) || n > 999) return null;
    return n;
  }

  /* Varre o arquivo cru do Tracker e devolve um mapa de documentos.
     Feito sobre o AOA (e não sobre rows) para preservar a descrição
     completa, que não vale a pena repetir linha a linha. */
  function buildDocs(aoa, hr, map) {
    if (map.doc == null) return {};
    var g = function (r, k) { return map[k] == null ? '' : r[map[k]]; };
    var docs = {};
    for (var i = hr + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      var bruto = String(g(r, 'doc') || '').trim();
      if (!bruto) continue;
      var tag = normDoc(bruto);
      if (!tag) continue;
      var d = docs[tag];
      if (!d) {
        d = docs[tag] = { tag: tag, desc: '', revs: [], rev: null, data: '', n: 0 };
        var resto = bruto.replace(/^[^-]*-LM-[^\s]*\s*-?\s*/i, '').trim();
        d.desc = (resto || bruto).slice(0, 120);
      }
      d.n++;
      var rv = revNum(g(r, 'docrev'));
      if (rv != null && d.revs.indexOf(rv) < 0) d.revs.push(rv);
      var dt = cellDate(g(r, 'docdata'));
      if (dt && (!d.data || dt > d.data)) d.data = dt;
    }
    Object.keys(docs).forEach(function (k) {
      var d = docs[k];
      d.revs.sort(function (a, b) { return a - b; });
      d.rev = d.revs.length ? d.revs[d.revs.length - 1] : null;
      var p = partesTag(k);
      d.emp = p ? p.emp : '';
      d.disc = p ? p.disc : '';
      d.discNome = p ? (DISC_LM[p.disc] || p.disc) : '';
      d.area = p ? p.area : '';
      d.ei = !!(p && DISC_EI.indexOf(p.disc) > -1);
      d.malformado = !p;
    });
    return docs;
  }

  /* Cruza o inventário do Tracker com as listas efetivamente carregadas.
     Situações:
       carregada     — subida e na mesma revisão do Tracker
       desatualizada — subida numa revisão anterior à do Tracker
       pendente      — existe no Tracker e nunca foi subida
       avulsa        — subida mas o Tracker não conhece o documento */
  function inventarioListas(dados) {
    var tracker = (dados && dados.tracker) || null;
    var docs = (tracker && tracker.docs) || {};
    var listas = (dados && dados.listas) || [];

    /* índice das listas carregadas por cada TAG que elas declaram */
    var porTag = {};
    listas.forEach(function (l) {
      (l.tags || [l.tag]).forEach(function (tg) {
        var n = normDoc(tg);
        if (n) porTag[n] = l;
      });
    });

    var out = [], vistas = [];
    Object.keys(docs).forEach(function (k) {
      var d = docs[k];
      var l = porTag[k] || null;
      if (l && vistas.indexOf(l) < 0) vistas.push(l);
      var revCarregada = l ? revNum(l.rev) : null;
      var sit = !l ? 'pendente'
        : (d.rev != null && revCarregada != null && revCarregada < d.rev) ? 'desatualizada'
        : 'carregada';
      out.push({
        tag: d.tag, desc: d.desc, emp: d.emp, disc: d.disc, discNome: d.discNome,
        area: d.area, ei: d.ei, malformado: d.malformado,
        revTracker: d.rev, revs: d.revs, dataTracker: d.data, linhas: d.n,
        carregada: !!l, revCarregada: revCarregada,
        arquivo: l ? (l.arquivo || l.tag) : '', srcLista: l ? l.src : '',
        itens: l ? (l.items || []).length : 0,
        carregadoEm: l ? l.carregado : '',
        sit: sit
      });
    });

    /* listas carregadas que o Tracker não conhece */
    listas.forEach(function (l) {
      if (vistas.indexOf(l) > -1) return;
      var p = partesTag(normDoc(l.tag));
      out.push({
        tag: l.tag, desc: l.nome || '', emp: p ? p.emp : '',
        disc: p ? p.disc : '', discNome: p ? (DISC_LM[p.disc] || p.disc) : '',
        area: p ? p.area : (l.area || ''), ei: !p || DISC_EI.indexOf(p.disc) > -1,
        malformado: !p,
        revTracker: null, revs: [], dataTracker: '', linhas: 0,
        carregada: true, revCarregada: revNum(l.rev),
        arquivo: l.arquivo || l.tag, srcLista: l.src,
        itens: (l.items || []).length, carregadoEm: l.carregado,
        sit: 'avulsa'
      });
    });

    out.sort(function (a, b) {
      if (a.ei !== b.ei) return a.ei ? -1 : 1;
      var o = { pendente: 0, desatualizada: 1, avulsa: 2, carregada: 3 };
      if (o[a.sit] !== o[b.sit]) return o[a.sit] - o[b.sit];
      return b.linhas - a.linhas;
    });
    return out;
  }

  function build(dados, opts) {
    var o = opts || {};
    var listas = (dados && dados.listas) || [];
    var tracker = (dados && dados.tracker) || null;
    var trows = (tracker && tracker.rows) || [];
    var overrides = (dados && dados.areasExtra) || {};
    var areaFallback = o.areaFallback || 'SEM ÁREA';

    /* ---- 4.1 demanda por (área, código) ---------------------- */
    var demanda = {};   // chave: area||cod
    var porLinha = {};  // chave: linha normalizada → itens de demanda
    var descs = {};

    listas.forEach(function (L2) {
      (L2.items || []).forEach(function (it) {
        var line = String(it[IDX.LINE] || '').trim();
        var area = overrides[line] || String(it[IDX.AREA] || '').trim() || areaFallback;
        var cod = it[IDX.COD];
        var key = area + '||' + cod;
        var d = demanda[key];
        if (!d) {
          d = demanda[key] = {
            area: area, cod: cod,
            desc: it[IDX.DESC] || '', un: it[IDX.UN] || '',
            ref: it[IDX.REF] || '',
            qtd: 0, peso: 0, lines: [], listas: [],
            rec: 0, ped: 0, sol: 0, st: null, statusTxt: '',
            pedidos: [], fornec: [], prev: null, matched: false
          };
        }
        if (!d.docs) d.docs = [];
        (L2.tags || [L2.tag]).forEach(function (tg) {
          var n = normDoc(tg);
          if (n && d.docs.indexOf(n) < 0) d.docs.push(n);
        });
        d.qtd += parseNum(it[IDX.QTD]);
        d.peso += parseNum(it[IDX.PESO]);
        if (line && d.lines.indexOf(line) < 0) d.lines.push(line);
        if (L2.tag && d.listas.indexOf(L2.tag) < 0) d.listas.push(L2.tag);
        if (!descs[cod] && it[IDX.DESC]) descs[cod] = it[IDX.DESC];
        if (line) {
          var nl = normLine(line);
          (porLinha[nl] = porLinha[nl] || []).push(d);
        }
      });
    });

    /* ---- 4.2 aplica o tracker -------------------------------
       Cadeia de casamento, do mais específico para o mais frouxo:
         1. LINE NUMBER              — item a item, exato
         2. DOCUMENTO (LM) + CÓDIGO  — escopo da lista de origem
         3. CÓDIGO                   — rateado entre as áreas que pedem
       O código de cada lado pode ser o interno (ref. engenharia) ou o
       do sistema; ambos entram no índice, então uma lista que só tenha
       o código de engenharia casa igual.
       ---------------------------------------------------------- */
    var semDemanda = [];
    var cnt = { line: 0, doc: 0, cod: 0, orfa: 0, ignoradas: 0 };
    var soDoc = !!o.somenteDoc;

    /* índices sobre as demandas ainda não casadas por line number */
    function indexar() {
      var porDocCod = {}, porCodigo = {};
      Object.keys(demanda).forEach(function (k) {
        var d = demanda[k];
        if (d.matched) return;
        codigosDe(d).forEach(function (c) {
          (porCodigo[c] = porCodigo[c] || []).push(d);
          (d.docs || []).forEach(function (doc) {
            var kk = doc + '||' + c;
            (porDocCod[kk] = porDocCod[kk] || []).push(d);
          });
        });
      });
      return { docCod: porDocCod, cod: porCodigo };
    }
    function codigosDe(x) {
      var out = [];
      [x.ref, x.cod, x.cod2].forEach(function (c) {
        var s = c == null ? '' : String(c).trim().toUpperCase();
        if (s && out.indexOf(s) < 0) out.push(s);
      });
      return out;
    }

    /* passo 1 — line number */
    var restantes = [];
    trows.forEach(function (t) {
      var nl = normLine(t.line);
      if (nl && porLinha[nl] && porLinha[nl].length) {
        var cods = codigosDe(t);
        var alvo = porLinha[nl].filter(function (d) {
          return codigosDe(d).some(function (c) { return cods.indexOf(c) > -1; });
        })[0] || porLinha[nl][0];
        aplica(alvo, t);
        alvo.matched = true;
        alvo.via = 'line';
        cnt.line++;
        return;
      }
      restantes.push(t);
    });

    /* passos 2 e 3 — documento+código, depois código */
    var IX = indexar();
    restantes.forEach(function (t) {
      var cods = codigosDe(t);
      var alvos = null, via = '';

      if (t.doc) {
        for (var i = 0; i < cods.length && !alvos; i++) {
          var lst = IX.docCod[t.doc + '||' + cods[i]];
          if (lst && lst.length) { alvos = lst; via = 'doc'; }
        }
      }
      if (!alvos && !soDoc) {
        for (var j = 0; j < cods.length && !alvos; j++) {
          var l2 = IX.cod[cods[j]];
          if (l2 && l2.length) { alvos = l2; via = 'cod'; }
        }
      }
      if (!alvos) {
        if (soDoc) cnt.ignoradas++;
        else { cnt.orfa++; semDemanda.push({ cod: t.cod2 || t.cod, doc: t.doc, acc: t }); }
        return;
      }

      /* rateio proporcional à demanda de cada área */
      var tot = alvos.reduce(function (a, d) { return a + d.qtd; }, 0);
      alvos.forEach(function (d) {
        var f = tot > 0 ? (d.qtd / tot) : (1 / alvos.length);
        aplica(d, t, f);
        d.matched = true;
        d.via = d.via || via;
        if (alvos.length > 1) d.rateado = true;
      });
      if (via === 'doc') cnt.doc++; else cnt.cod++;
    });

    function aplica(d, t, f) {
      f = f == null ? 1 : f;
      d.rec += t.q_rec * f; d.ped += t.q_ped * f; d.sol += t.q_sol * f;
      if (t.st && (!d.st || STATUS_META[t.st].ord < STATUS_META[d.st].ord)) {
        d.st = t.st; d.statusTxt = t.status;
      }
      if (t.pedido && d.pedidos.indexOf(t.pedido) < 0) d.pedidos.push(t.pedido);
      if (t.fornec && d.fornec.indexOf(t.fornec) < 0) d.fornec.push(t.fornec);
      if (t.doc && (d.docsTrk = d.docsTrk || []).indexOf(t.doc) < 0) d.docsTrk.push(t.doc);
      if (t.prev && (!d.prev || t.prev < d.prev)) d.prev = t.prev;
    }

    /* ---- 4.3 situação final de cada item --------------------- */
    var itens = Object.keys(demanda).map(function (k) {
      var d = demanda[k];
      var tol = Math.max(d.qtd * 0.005, 0.001);
      if (d.st === 'cancelado') d.sit = 'cancelado';
      else if (d.qtd > 0 && d.rec >= d.qtd - tol) d.sit = 'recebido';
      else if (d.rec > tol) d.sit = 'parcial';
      else if (d.st && d.st !== 'recebido') d.sit = d.st;
      else if (d.ped > tol) d.sit = 'pedido';
      else d.sit = 'naopedido';
      d.pct = d.qtd > 0 ? Math.min(100, (d.rec / d.qtd) * 100) : (d.sit === 'recebido' ? 100 : 0);
      d.key = k;
      return d;
    });

    /* ---- 4.4 resumo por área --------------------------------- */
    var areas = {};
    itens.forEach(function (d) {
      var a = areas[d.area] || (areas[d.area] = {
        area: d.area, itens: 0, qtd: 0, rec: 0, peso: 0, pesoRec: 0,
        recebidos: 0, parciais: 0, pendentes: 0, naopedidos: 0, cancelados: 0
      });
      a.itens++;
      a.qtd += d.qtd; a.rec += Math.min(d.rec, d.qtd || d.rec);
      a.peso += d.peso; a.pesoRec += d.peso * (d.pct / 100);
      if (d.sit === 'recebido') a.recebidos++;
      else if (d.sit === 'parcial') a.parciais++;
      else if (d.sit === 'naopedido') a.naopedidos++;
      else if (d.sit === 'cancelado') a.cancelados++;
      else a.pendentes++;
    });
    var resumo = Object.keys(areas).map(function (k) {
      var a = areas[k];
      var base = a.itens - a.cancelados;
      a.pct = base > 0 ? (a.recebidos / base) * 100 : 0;
      a.pctQtd = a.qtd > 0 ? (a.rec / a.qtd) * 100 : 0;
      return a;
    }).sort(function (x, y) { return String(x.area).localeCompare(String(y.area), 'pt-BR'); });

    /* ---- 4.5 totais ------------------------------------------ */
    var tot = {
      itens: itens.length,
      recebidos: itens.filter(function (d) { return d.sit === 'recebido'; }).length,
      parciais: itens.filter(function (d) { return d.sit === 'parcial'; }).length,
      naopedidos: itens.filter(function (d) { return d.sit === 'naopedido'; }).length,
      cancelados: itens.filter(function (d) { return d.sit === 'cancelado'; }).length,
      areas: resumo.length,
      listas: listas.length,
      trackerRows: trows.length,
      semDemanda: semDemanda.length,
      semTracker: itens.filter(function (d) { return !d.matched; }).length,
      match: cnt,
      viaLine: itens.filter(function (d) { return d.via === 'line'; }).length,
      viaDoc:  itens.filter(function (d) { return d.via === 'doc'; }).length,
      viaCod:  itens.filter(function (d) { return d.via === 'cod'; }).length
    };
    tot.pendentes = tot.itens - tot.recebidos - tot.parciais - tot.naopedidos - tot.cancelados;
    tot.pct = (tot.itens - tot.cancelados) > 0
      ? (tot.recebidos / (tot.itens - tot.cancelados)) * 100 : 0;

    return { itens: itens, areas: resumo, tot: tot, semDemanda: semDemanda };
  }

  /* Resumo enxuto para gravar no snapshot e consumir no painel */
  function resumoParaSnapshot(res) {
    return {
      gerado: new Date().toISOString(),
      total: res.tot,
      areas: res.areas.map(function (a) {
        return {
          area: a.area, itens: a.itens, recebidos: a.recebidos,
          parciais: a.parciais, pendentes: a.pendentes,
          naopedidos: a.naopedidos, cancelados: a.cancelados,
          pct: Math.round(a.pct * 10) / 10,
          pctQtd: Math.round(a.pctQtd * 10) / 10
        };
      })
    };
  }

  global.LPS_MAT = {
    IDX: IDX,
    buildDocs: buildDocs,
    inventarioListas: inventarioListas,
    partesTag: partesTag,
    DISC_LM: DISC_LM,
    STATUS_META: STATUS_META,
    TRACKER_FIELDS: TRACKER_FIELDS,
    classifyStatus: classifyStatus,
    readSheet: readSheet,
    parseListaFile: parseListaFile,
    normCod: normCod,
    codIgnoravel: codIgnoravel,
    parseTrackerFile: parseTrackerFile,
    buildTrackerRows: buildTrackerRows,
    autoMap: autoMap,
    build: build,
    resumoParaSnapshot: resumoParaSnapshot
  };

})(window);
