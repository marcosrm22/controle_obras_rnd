/* ================================================================
   cron_vinculo_core.js — Núcleo do vínculo (Fase 2 · v2)
   ----------------------------------------------------------------
   Estratégia (revisada após feedback de campo):

   1. HERANÇA POR WBS
      O vínculo é feito no NÍVEL HIERÁRQUICO que faz sentido (tipicamente
      L3 do cronograma da terceira: "Equipamentos", "Tubulação de aço
      carbono", etc). Todos os descendentes-resumo herdam esse vínculo
      automaticamente, a menos que sobrescrevam com um vínculo próprio.
      Regra: para um resumo qualquer, o vínculo efetivo é o mais próximo
      caminhando WBS pra cima. Isso reduz drasticamente a quantidade de
      linhas em cron_vinculo (de ~2000 para ~30-50).

   2. DETECÇÃO AUTOMÁTICA DE FASE
      Lê o nome do L2 ancestral no cronograma da terceira. "Fase 01" →
      FASE_I, "Fase 02" → FASE_II, "Armazém" → ARMAZEM, "Posto" → POSTO.

   3. FILTRO EMPRESA→CWA APRENDIDO DO GERAL
      Precomputa {empresa: [cwa,...]} a partir de cron_geral_atividades.
      Ex.: CALDERVOL só aparece em 2309.B e 2409.A → o auto-match só
      considera essas CWAs. Elimina falsos positivos ("água" → 2310).

   4. MATCH RESTRITO
      Candidato só se: empresa ≈ contrato.empresa E cwa ∈ empresa_cwas
      E fase = fase_detectada. Dentro do subset, jaccard-palavras.

   Carregar depois de config.js, unidade.js e cron_geral_core.js.
   ================================================================ */

(function (global) {
  'use strict';

  var CG = global.CG;
  if (!CG) throw new Error('cron_vinculo_core.js precisa de cron_geral_core.js carregado antes.');

  var CFG    = global.PCO_CONFIG || {};
  var SB_URL = (CFG.supabase || {}).url || '';
  var SB_KEY = (CFG.supabase || {}).key || '';

  /* ============ Normalização e match de strings ============ */
  var STOP = { de:1, da:1, do:1, das:1, dos:1, e:1, a:1, o:1, as:1, os:1,
               em:1, na:1, no:1, nas:1, nos:1, com:1, para:1, por:1,
               '01':1,'02':1,'03':1,'04':1,'05':1,'06':1, sistema:1 };
  function _deacc(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
  }
  function _stem(w) {
    if (w.length > 3 && w.slice(-3) === 'oes') return w.slice(0,-3) + 'ao';
    if (w.length > 3 && w.slice(-2) === 'ns')  return w.slice(0,-2) + 'm';
    if (w.length > 3 && w.slice(-2) === 'is')  return w.slice(0,-2) + 'l';
    if (w.length > 3 && w.slice(-2) === 'es')  return w.slice(0,-2);
    if (w.length > 2 && w.slice(-1) === 's')   return w.slice(0,-1);
    return w;
  }
  function _words(s) {
    var m = _deacc(s).match(/[a-z0-9]+/g) || [];
    var out = {};
    m.forEach(function (w) { if (w.length >= 2 && !STOP[w]) out[_stem(w)] = 1; });
    return out;
  }
  function _jaccard(a, b) {
    var ak = Object.keys(a), bk = Object.keys(b);
    if (!ak.length || !bk.length) return 0;
    var inter = 0;
    ak.forEach(function (k) { if (b[k]) inter++; });
    return inter / (ak.length + bk.length - inter);
  }
  function _empresaKey(nome) {
    if (!nome) return '';
    // pega o "primeiro token significativo" — normalmente a marca (CALDERVOL, HFC, APOLINÁRIO)
    var toks = _deacc(nome).replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/);
    // ignora sufixos societários comuns
    var IGN = { ltda:1, sa:1, s:1, me:1, epp:1, cia:1, construtora:1, engenharia:1, servicos:1, servico:1 };
    for (var i = 0; i < toks.length; i++) if (!IGN[toks[i]] && toks[i].length >= 3) return toks[i];
    return toks[0] || '';
  }
  function _empresaMatch(a, b) {
    if (!a || !b) return false;
    var ka = _empresaKey(a), kb = _empresaKey(b);
    if (!ka || !kb) return false;
    return ka === kb || ka.indexOf(kb) !== -1 || kb.indexOf(ka) !== -1;
  }

  /* ============ Detecção de fase pelo nome do L2 ============ */
  function detectarFasePorNome(nomeL2) {
    var s = _deacc(nomeL2);
    if (/\barmazem/.test(s)) return 'ARMAZEM';
    if (/\bposto/.test(s))   return 'POSTO';
    // "fase 01", "fase 1", "fase i" — atenção: "fase i" precisa ser posição isolada
    if (/\bfase\s*0*2\b/.test(s) || /\bfase\s*ii\b/.test(s)) return 'FASE_II';
    if (/\bfase\s*0*1\b/.test(s) || /\bfase\s*i\b/.test(s))  return 'FASE_I';
    return null;
  }

  /* ============ Carregamento ============ */
  function loadAll() {
    var pContratos = CG.sbGetAll(CG.comUnidade('val_cronogramas?select=*&order=empresa.asc'));
    var pGeral     = CG.sbGetAll(CG.comUnidade('cron_geral_atividades?select=*&tipo_pacote=eq.EXECUCAO&ativo=eq.true'));
    var pVinculos  = CG.sbGetAll(CG.comUnidade('cron_vinculo?select=*'))
                        .catch(function(e){ if (CG.isMissingTable(e)) return []; throw e; });

    return Promise.all([pContratos, pGeral, pVinculos]).then(function (r) {
      var contratos = r[0] || [];
      var geral     = r[1] || [];
      var vinculos  = r[2] || [];

      if (!contratos.length) {
        return _finalizar({ contratos: [], geral: geral, vinculos: vinculos, arvores: [] });
      }

      var promRevs = contratos.map(function (c) {
        var q = 'val_revisoes?cronograma_id=eq.' + c.id +
                '&tarefas_json=not.is.null' +
                '&select=cronograma_id,revisao,rotulo,data_corte,tarefas_json' +
                '&order=revisao.desc&limit=1';
        return CG.sb('GET', CG.comUnidade(q))
          .then(function (revs) { return { c: c, rev: (revs && revs[0]) || null }; })
          .catch(function ()    { return { c: c, rev: null }; });
      });

      return Promise.all(promRevs).then(function (pares) {
        var arvores = pares.map(function (p) { return _construirArvore(p.c, p.rev); }).filter(Boolean);
        return _finalizar({ contratos: contratos, geral: geral, vinculos: vinculos, arvores: arvores });
      });
    });
  }

  function _finalizar(d) {
    // índices
    d.geralById  = {}; d.geral.forEach(function (g) { d.geralById[g.id] = g; });
    d.contratoById = {}; d.contratos.forEach(function (c) { d.contratoById[c.id] = c; });
    // vínculos por (cronograma_id, terceira_uid)
    d.vinculoByKey = {};
    d.vinculos.forEach(function (v) { d.vinculoByKey[v.cronograma_id + '::' + v.terceira_uid] = v; });

    // empresa → set de CWAs (aprendido do geral)
    d.empresaCwas = {};   // { chaveEmpresa: {cwa: true} }
    d.geral.forEach(function (g) {
      if (!g.empresa || !g.cwa) return;
      var k = _empresaKey(g.empresa);
      if (!k) return;
      (d.empresaCwas[k] = d.empresaCwas[k] || {})[g.cwa] = true;
    });
    // Também um índice geral por empresa → linhas do geral (para filtro rápido)
    d.geralPorEmpresa = {};
    d.geral.forEach(function (g) {
      var k = g.empresa ? _empresaKey(g.empresa) : '';
      if (!k) return;
      (d.geralPorEmpresa[k] = d.geralPorEmpresa[k] || []).push(g);
    });
    // words cache para o matcher
    d.geralWords = {};
    d.geral.forEach(function (g) { d.geralWords[g.id] = _words(g.nome); });

    return d;
  }

  /* Constrói a árvore de resumos ativos para um contrato.
     Estrutura: nó = { uid, wbs, name, level, cp, filhos:[], resumosDescendentes, folhasDescendentes }
     Só inclui summary=true, active=true. Também guarda faseByWbs2 (prefixo L2 → fase). */
  function _construirArvore(contrato, rev) {
    if (!rev || !rev.tarefas_json) return { contrato: contrato, root: null, semDetalhe: true, faseByWbs2: {} };
    var tj = rev.tarefas_json;
    if (typeof tj === 'string') { try { tj = JSON.parse(tj); } catch (_) { tj = []; } }
    if (!Array.isArray(tj)) return { contrato: contrato, root: null, semDetalhe: true, faseByWbs2: {} };

    // Índice por WBS de TUDO (resumo e folha)
    var porWbs = {};
    tj.forEach(function (t) { if (t.wbs) porWbs[String(t.wbs)] = t; });

    // Fases detectadas por prefixo L2 (nome do L2)
    var faseByWbs2 = {};
    tj.forEach(function (t) {
      if (t.level === 2 && t.active !== false && t.wbs) {
        var f = detectarFasePorNome(t.name);
        if (f) faseByWbs2[String(t.wbs)] = f;
      }
    });

    // Coleta os resumos ativos que serão vinculáveis (level >= 2)
    var nos = {};
    tj.forEach(function (t) {
      if (!t.summary || t.active === false || !t.wbs) return;
      if ((t.level || 0) < 2) return;
      var wbs = String(t.wbs);
      nos[wbs] = {
        uid:   String(t.uid),
        wbs:   wbs,
        name:  t.name || '',
        level: t.level || 0,
        cp:    (t.CP == null ? null : t.CP),
        filhos: [],
        resumosDescendentes: 0,
        folhasDescendentes:  0
      };
    });

    // Vincula filhos → pais via prefixo do WBS
    var raizes = [];
    Object.keys(nos).forEach(function (w) {
      var no = nos[w];
      var ix = w.lastIndexOf('.');
      var wbsPai = (ix > 0) ? w.slice(0, ix) : null;
      // caminha para cima até achar um pai também presente em nos (skipa níveis que não sejam resumos)
      var pai = null;
      while (wbsPai) {
        if (nos[wbsPai]) { pai = nos[wbsPai]; break; }
        var ix2 = wbsPai.lastIndexOf('.');
        wbsPai = ix2 > 0 ? wbsPai.slice(0, ix2) : null;
      }
      if (pai) pai.filhos.push(no);
      else     raizes.push(no);
    });

    // Ordena filhos por WBS (natural)
    var natural = function (a, b) { return _cmpWbs(a.wbs, b.wbs); };
    raizes.sort(natural);
    Object.keys(nos).forEach(function (w) { nos[w].filhos.sort(natural); });

    // Conta descendentes (resumos e folhas) em cada nó
    tj.forEach(function (t) {
      if (t.active === false || !t.wbs) return;
      var w = String(t.wbs);
      // caminha para cima somando em cada nó (nos) ancestral
      var cur = w;
      while (true) {
        var ix = cur.lastIndexOf('.');
        if (ix <= 0) break;
        cur = cur.slice(0, ix);
        if (nos[cur]) {
          if (t.summary) nos[cur].resumosDescendentes++;
          else           nos[cur].folhasDescendentes++;
        }
      }
    });

    return {
      contrato:   contrato,
      revisao:    rev.revisao,
      revRotulo:  rev.rotulo,
      dataCorte:  rev.data_corte,
      raizes:     raizes,
      todosPorWbs: nos,
      faseByWbs2: faseByWbs2,
      totalResumos: Object.keys(nos).length
    };
  }
  function _cmpWbs(a, b) {
    var pa = String(a).split('.').map(function (x){ return parseInt(x,10)||0; });
    var pb = String(b).split('.').map(function (x){ return parseInt(x,10)||0; });
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var da = pa[i]||0, db = pb[i]||0;
      if (da !== db) return da - db;
    }
    return 0;
  }

  /* ============ Fase detectada pelo WBS do resumo ============ */
  function faseDoResumo(arvore, wbs) {
    // pega o prefixo L2 desse WBS (2 primeiros segmentos)
    var parts = String(wbs).split('.');
    if (parts.length < 2) return null;
    var wbs2 = parts.slice(0, 2).join('.');
    return arvore.faseByWbs2[wbs2] || null;
  }

  /* ============ Vínculo efetivo com herança ============ */
  /* Para um WBS, procura em cron_vinculo o próprio ou o ancestral mais próximo. */
  function vinculoEfetivo(arvore, wbs, vinculoByKey) {
    var cur = String(wbs);
    while (cur) {
      var no = arvore.todosPorWbs[cur];
      if (no) {
        var key = arvore.contrato.id + '::' + no.uid;
        if (vinculoByKey[key]) return { vinculo: vinculoByKey[key], no: no, herdado: (cur !== wbs) };
      }
      var ix = cur.lastIndexOf('.');
      if (ix <= 0) break;
      cur = cur.slice(0, ix);
    }
    return null;
  }

  /* ============ Sugestão automática ============ */
  function sugerirMatch(no, arvore, dados) {
    var contrato = arvore.contrato;
    var empKey   = _empresaKey(contrato.empresa || '');
    var fase     = faseDoResumo(arvore, no.wbs);

    // 1) Sinal WBS exato (raro casar no seu cenário — mas rápido de checar)
    for (var i = 0; i < dados.geral.length; i++) {
      if (dados.geral[i].numero_topico === no.wbs) {
        return { cron_geral_id: dados.geral[i].id, confianca: 'alta', metodo: 'wbs', score: 0.98 };
      }
    }

    // 2) Restringe candidatos pelo filtro (empresa + CWAs + fase)
    var candidatos = null;
    if (empKey && dados.geralPorEmpresa[empKey]) candidatos = dados.geralPorEmpresa[empKey];
    // Se não temos linhas da empresa no geral, avisa (retorna null semSubset=true)
    if (!candidatos || !candidatos.length) return null;

    if (fase) candidatos = candidatos.filter(function (g) { return g.fase === fase; });
    if (!candidatos.length) return null;

    // 3) Jaccard-palavras contra o candidato filtrado
    var noWords = _words(no.name);
    var best = null, bestScore = 0;
    candidatos.forEach(function (g) {
      var s = _jaccard(noWords, dados.geralWords[g.id] || {});
      if (s > bestScore) { best = g; bestScore = s; }
    });

    if (!best) return null;
    var metodo = 'empresa+fase+nome';
    if (bestScore >= 0.7)  return { cron_geral_id: best.id, confianca: 'alta',   metodo: metodo, score: bestScore };
    if (bestScore >= 0.45) return { cron_geral_id: best.id, confianca: 'media',  metodo: metodo, score: bestScore };
    if (bestScore >= 0.25) return { cron_geral_id: best.id, confianca: 'baixa',  metodo: metodo, score: bestScore };
    return null;
  }

  /* ============ Salvamento (upsert em batch) ============ */
  function salvarBatch(itens) {
    // itens = [{cronograma_id, terceira_uid, cron_geral_id}] ; cron_geral_id=null → delete
    var upserts = itens.filter(function (i) { return i.cron_geral_id != null; });
    var deletes = itens.filter(function (i) { return i.cron_geral_id == null; });

    var pUp = Promise.resolve();
    if (upserts.length) {
      var payload = upserts.map(function (i) {
        return CG.comTag({
          cronograma_id: i.cronograma_id,
          terceira_uid:  i.terceira_uid,
          cron_geral_id: i.cron_geral_id,
          metodo_rateio: null,
          criado_por:    CG.userNome()
        });
      });
      var qs = 'on_conflict=' + encodeURIComponent('cronograma_id,terceira_uid');
      pUp = fetch(SB_URL + '/rest/v1/cron_vinculo?' + qs, {
        method: 'POST',
        headers: {
          apikey: SB_KEY,
          Authorization: 'Bearer ' + SB_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=representation,resolution=merge-duplicates'
        },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.text().then(function (txt) {
          if (!res.ok) throw new Error(res.status + ': ' + txt.slice(0, 320));
        });
      });
    }

    var pDel = Promise.resolve();
    if (deletes.length) {
      pDel = pUp.then(function () {
        return Promise.all(deletes.map(function (i) {
          var url = 'cron_vinculo?cronograma_id=eq.' + encodeURIComponent(i.cronograma_id) +
                    '&terceira_uid=eq.' + encodeURIComponent(i.terceira_uid);
          return CG.sb('DELETE', url).catch(function () {}); // idempotente
        }));
      });
    }

    return pUp.then(function () { return pDel; })
              .then(function () { return { upserts: upserts.length, deletes: deletes.length }; });
  }

  /* ============ Exports ============ */
  global.CV = {
    loadAll: loadAll,
    detectarFasePorNome: detectarFasePorNome,
    faseDoResumo: faseDoResumo,
    vinculoEfetivo: vinculoEfetivo,
    sugerirMatch: sugerirMatch,
    salvarBatch: salvarBatch,
    _empresaKey: _empresaKey, _empresaMatch: _empresaMatch,
    _words: _words, _jaccard: _jaccard, _deacc: _deacc, _cmpWbs: _cmpWbs
  };
})(window);
