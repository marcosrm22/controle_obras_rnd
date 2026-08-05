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

  function readSheet(file) {
    return L.ensureXLSX().then(function (X) {
      return new Promise(function (resolve, reject) {
        var rd = new FileReader();
        rd.onerror = function () { reject(new Error('não foi possível ler o arquivo')); };
        rd.onload = function (ev) {
          try {
            var wb = X.read(new Uint8Array(ev.target.result), { type: 'array', cellDates: true });
            var aoa = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
            resolve(aoa);
          } catch (e) { reject(new Error('planilha ilegível')); }
        };
        rd.readAsArrayBuffer(file);
      });
    });
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

  /* Parser genérico de lista de material.
     Detecta automaticamente se é layout Aplus (CÓDIGO + LINE NUMBER)
     ou VIA PACS (COD + REFERÊNCIA ENGENHARIA + LINE NUMBER). */
  function parseListaFile(file) {
    return readSheet(file).then(function (aoa) {
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
        return { err: 'cabeçalho não reconhecido (esperado CÓDIGO/COD + LINE NUMBER)', name: file.name };
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

      var items = [];
      for (var i = hr + 1; i < aoa.length; i++) {
        var r = aoa[i] || [];
        var codRaw = String(iCod >= 0 ? r[iCod] : '').trim();
        if (!codRaw) continue;
        var cod = parseInt(String(codRaw).replace(/\D/g, ''), 10);
        if (isNaN(cod)) cod = 0;
        var ref = String(iRef >= 0 ? r[iRef] : '').trim();
        var qtd = iQtdI >= 0 ? parseNum(r[iQtdI]) : 0;
        if (!qtd) qtd = parseNum(iQtd >= 0 ? r[iQtd] : 0) || parseNum(iComp >= 0 ? r[iComp] : 0);
        items.push([
          ref,
          cod || codRaw,
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
        tag: tag, rev: rev, cat: cat,
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
    { k: 'cod',    label: 'Código do material', req: true,
      hints: ['COD MATERIAL', 'CODIGO MATERIAL', 'COD. MATERIAL', 'MATERIAL', 'COD SAP', 'CODIGO', 'COD', 'ITEM'] },
    { k: 'desc',   label: 'Descrição', req: false,
      hints: ['DESCRICAO MATERIAL', 'DESCRICAO', 'DESCRIPTION', 'TEXTO BREVE'] },
    { k: 'un',     label: 'Unidade', req: false,
      hints: ['UNIDADE MEDIDA', 'UN MEDIDA', 'BITOLA', 'UNIDADE', 'UM', 'UN'] },
    { k: 'area',   label: 'Área', req: false,
      hints: ['AREA DESTINO', 'AREA OBRA', 'AREA', 'SETOR', 'LOCAL'] },
    { k: 'line',   label: 'Line Number', req: false,
      hints: ['LINE NUMBER', 'LINENUMBER', 'LINHA', 'ITEM LISTA', 'TAG'] },
    { k: 'q_sol',  label: 'Qtd. solicitada', req: false,
      hints: ['QTD SOLICITADA', 'QUANTIDADE SOLICITADA', 'QTD REQUISITADA', 'QTD LISTA', 'QTD PREVISTA', 'QTD'] },
    { k: 'q_ped',  label: 'Qtd. pedida (OC)', req: false,
      hints: ['QTD PEDIDA', 'QUANTIDADE PEDIDA', 'QTD COMPRADA', 'QTD OC', 'QTD PEDIDO'] },
    { k: 'q_rec',  label: 'Qtd. recebida', req: false,
      hints: ['QTD RECEBIDA', 'QUANTIDADE RECEBIDA', 'QTD ENTREGUE', 'RECEBIDO', 'QTD RECEB'] },
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
    ['cod', 'q_rec', 'q_ped', 'q_sol', 'status', 'line', 'area', 'desc'].forEach(function (k) {
      if (map[k] == null) return;
      if (used[map[k]]) delete map[k]; else used[map[k]] = k;
    });
    return map;
  }

  /* Lê o tracker e devolve {header, aoa, map, rows} */
  function parseTrackerFile(file, forcedMap) {
    return readSheet(file).then(function (aoa) {
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
        carregado: new Date().toISOString(),
        header: header,
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
    return null;
  }

  function buildTrackerRows(aoa, hr, map) {
    var g = function (r, k) { return map[k] == null ? '' : r[map[k]]; };
    var out = [];
    for (var i = hr + 1; i < aoa.length; i++) {
      var r = aoa[i] || [];
      var codRaw = String(g(r, 'cod') || '').trim();
      if (!codRaw) continue;
      var codNum = parseInt(codRaw.replace(/\D/g, ''), 10);
      var cod = isNaN(codNum) ? codRaw : codNum;
      var stTxt = String(g(r, 'status') || '').trim();
      out.push({
        cod: cod,
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

    /* ---- 4.2 aplica o tracker -------------------------------- */
    var semDemanda = [];       // itens do tracker sem correspondência
    var porCod = {};           // cod → soma do tracker ainda não alocada

    trows.forEach(function (t) {
      var alvo = null;
      var nl = normLine(t.line);
      if (nl && porLinha[nl] && porLinha[nl].length) {
        alvo = porLinha[nl].filter(function (d) {
          return String(d.cod) === String(t.cod);
        })[0] || porLinha[nl][0];
      }
      if (alvo) {
        aplica(alvo, t);
        alvo.matched = true;
      } else {
        var c = String(t.cod);
        var acc = porCod[c] || (porCod[c] = {
          rec: 0, ped: 0, sol: 0, st: null, statusTxt: '',
          pedidos: [], fornec: [], prev: null, n: 0
        });
        acc.rec += t.q_rec; acc.ped += t.q_ped; acc.sol += t.q_sol; acc.n++;
        if (t.st && (!acc.st || STATUS_META[t.st].ord < STATUS_META[acc.st].ord)) {
          acc.st = t.st; acc.statusTxt = t.status;
        }
        if (t.pedido && acc.pedidos.indexOf(t.pedido) < 0) acc.pedidos.push(t.pedido);
        if (t.fornec && acc.fornec.indexOf(t.fornec) < 0) acc.fornec.push(t.fornec);
        if (t.prev && (!acc.prev || t.prev < acc.prev)) acc.prev = t.prev;
      }
    });

    function aplica(d, t) {
      d.rec += t.q_rec; d.ped += t.q_ped; d.sol += t.q_sol;
      if (t.st && (!d.st || STATUS_META[t.st].ord < STATUS_META[d.st].ord)) {
        d.st = t.st; d.statusTxt = t.status;
      }
      if (t.pedido && d.pedidos.indexOf(t.pedido) < 0) d.pedidos.push(t.pedido);
      if (t.fornec && d.fornec.indexOf(t.fornec) < 0) d.fornec.push(t.fornec);
      if (t.prev && (!d.prev || t.prev < d.prev)) d.prev = t.prev;
    }

    /* rateio por código entre as áreas que demandam o mesmo material */
    var porCodDemanda = {};
    Object.keys(demanda).forEach(function (k) {
      var d = demanda[k];
      if (d.matched) return;
      (porCodDemanda[String(d.cod)] = porCodDemanda[String(d.cod)] || []).push(d);
    });
    Object.keys(porCod).forEach(function (c) {
      var acc = porCod[c];
      var alvos = porCodDemanda[c];
      if (!alvos || !alvos.length) { semDemanda.push({ cod: c, acc: acc }); return; }
      var tot = alvos.reduce(function (a, d) { return a + d.qtd; }, 0);
      alvos.forEach(function (d) {
        var f = tot > 0 ? (d.qtd / tot) : (1 / alvos.length);
        d.rec += acc.rec * f;
        d.ped += acc.ped * f;
        d.sol += acc.sol * f;
        d.rateado = true;
        if (acc.st && (!d.st || STATUS_META[acc.st].ord < STATUS_META[d.st].ord)) {
          d.st = acc.st; d.statusTxt = acc.statusTxt;
        }
        acc.pedidos.forEach(function (p) { if (d.pedidos.indexOf(p) < 0) d.pedidos.push(p); });
        acc.fornec.forEach(function (p) { if (d.fornec.indexOf(p) < 0) d.fornec.push(p); });
        if (acc.prev && (!d.prev || acc.prev < d.prev)) d.prev = acc.prev;
        d.matched = true;
      });
    });

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
      semTracker: itens.filter(function (d) { return !d.matched; }).length
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
    STATUS_META: STATUS_META,
    TRACKER_FIELDS: TRACKER_FIELDS,
    classifyStatus: classifyStatus,
    readSheet: readSheet,
    parseListaFile: parseListaFile,
    parseTrackerFile: parseTrackerFile,
    buildTrackerRows: buildTrackerRows,
    autoMap: autoMap,
    build: build,
    resumoParaSnapshot: resumoParaSnapshot
  };

})(window);
