/* ================================================================
   cron_vinculo_core.js — Núcleo da tela de vínculo (Fase 2)
   ----------------------------------------------------------------
   Faz o link entre as ATIVIDADES-RESUMO dos cronogramas das
   terceiras (val_cronogramas + val_revisoes.tarefas_json) e as
   linhas do CRONOGRAMA EXECUTIVO GERAL (cron_geral_atividades,
   filtrado a EXECUCAO + ativo=true).

   Carregar SEMPRE depois de config.js, unidade.js e cron_geral_core.js:
     <script src="config.js"></script>
     <script src="unidade.js"></script>
     <script src="cron_geral_core.js"></script>
     <script src="cron_vinculo_core.js"></script>
   Usa CG.* para Supabase / auth / helpers.
   ================================================================ */

(function (global) {
  'use strict';

  var CG = global.CG;
  if (!CG) throw new Error('cron_vinculo_core.js precisa de cron_geral_core.js carregado antes.');

  var CFG    = global.PCO_CONFIG || {};
  var SB_URL = (CFG.supabase || {}).url || '';
  var SB_KEY = (CFG.supabase || {}).key || '';

  var MOD_KEY = 'cron_vinculo';

  /* ── Normalização de texto para o algoritmo de match ────── */
  var STOP = { de:1, da:1, do:1, das:1, dos:1, e:1, a:1, o:1, as:1, os:1,
               em:1, na:1, no:1, nas:1, nos:1, com:1, para:1, por:1,
               '01':1,'02':1,'03':1,'04':1,'05':1,'06':1,'07':1,'08':1,'09':1,
               fase:1, marco:1, 'sub':1 };

  function _deacc(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[̀-ͯ]/g,'')
      .toLowerCase();
  }
  function _stem(w) {
    if (w.length > 3 && w.slice(-3) === 'oes') return w.slice(0,-3) + 'ao';
    if (w.length > 3 && w.slice(-3) === 'aes') return w.slice(0,-3) + 'ao';
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
    var uni = ak.length + bk.length - inter;
    return uni ? inter / uni : 0;
  }
  function _empresaMatch(contratoEmpresa, geralEmpresa) {
    if (!contratoEmpresa || !geralEmpresa) return false;
    var a = _deacc(contratoEmpresa).replace(/[^a-z0-9]+/g,' ').trim();
    var b = _deacc(geralEmpresa).replace(/[^a-z0-9]+/g,' ').trim();
    if (!a || !b) return false;
    // um contém o outro (tolera "APOLINÁRIO" vs "APOLINARIO CONSTRUTORA LTDA")
    return a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
  }

  /* ── Carregamento ─────────────────────────────────────────── */

  /* Retorna { contratos, resumos, geral, vinculos, geralById, contratoById }
     - contratos:  val_cronogramas da unidade
     - resumos:    tarefas com summary=true e active=true, extraídas da última
                   revisão de cada contrato que tem tarefas_json
     - geral:      cron_geral_atividades filtradas EXECUCAO + ativo=true
     - vinculos:   linhas existentes de cron_vinculo (índice por chave)
  */
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
        return { contratos: [], resumos: [], geral: geral, vinculos: vinculos,
                 geralById: _byId(geral), contratoById: _byId(contratos, 'id'),
                 vinculosByKey: _vinculosByKey(vinculos) };
      }

      // Para cada contrato, busca a revisão mais recente COM detalhe
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
        var resumos = [];
        pares.forEach(function (p) {
          if (!p.rev || !p.rev.tarefas_json) return;
          var tj = p.rev.tarefas_json;
          if (typeof tj === 'string') { try { tj = JSON.parse(tj); } catch(_) { tj = []; } }
          if (!Array.isArray(tj)) return;

          // conta folhas por uid de resumo pai (via prefixo de WBS)
          var folhasPorWbs = {};
          tj.forEach(function (t) {
            if (t.summary || t.active === false || !t.wbs) return;
            var partes = String(t.wbs).split('.');
            for (var i = 1; i <= partes.length - 1; i++) {
              var ancestral = partes.slice(0, i).join('.');
              folhasPorWbs[ancestral] = (folhasPorWbs[ancestral] || 0) + 1;
            }
          });

          tj.forEach(function (t) {
            if (!t.summary || t.active === false || !t.wbs) return;
            // pula o resumo raiz (nível 1) — nunca vinculamos o "contrato inteiro"
            if ((t.level || 0) < 2) return;
            resumos.push({
              cronograma_id: p.c.id,
              contrato:      p.c,          // {empresa, escopo, area, disciplina, unidade}
              uid:           String(t.uid),
              wbs:           String(t.wbs),
              name:          t.name || '',
              level:         t.level || 0,
              cp:            (t.CP == null ? null : t.CP),
              folhas:        folhasPorWbs[t.wbs] || 0
            });
          });
        });
        return {
          contratos: contratos, resumos: resumos, geral: geral, vinculos: vinculos,
          geralById: _byId(geral), contratoById: _byId(contratos, 'id'),
          vinculosByKey: _vinculosByKey(vinculos)
        };
      });
    });
  }

  function _byId(arr, key) {
    var k = key || 'id', m = {};
    (arr || []).forEach(function (x) { m[x[k]] = x; });
    return m;
  }
  function _vinculosByKey(arr) {
    var m = {};
    (arr || []).forEach(function (v) { m[v.cronograma_id + '::' + v.terceira_uid] = v; });
    return m;
  }

  /* ── Índices de match no geral ────────────────────────────── */

  function buildGeralIndex(geral) {
    var byNumero = {}, byEmpresa = {}, wordsCache = {};
    (geral || []).forEach(function (g) {
      byNumero[g.numero_topico] = g;
      if (g.empresa) {
        var key = _deacc(g.empresa).replace(/[^a-z0-9]+/g,' ').trim();
        (byEmpresa[key] = byEmpresa[key] || []).push(g);
      }
      wordsCache[g.id] = _words(g.nome);
    });
    return { list: geral, byNumero: byNumero, byEmpresa: byEmpresa, wordsCache: wordsCache };
  }

  /* Para um resumo, filtra o geral pela empresa do contrato (com match tolerante)
     e devolve a lista {geralRow, geralWords}. Se não há empresa/nenhum match,
     devolve a lista inteira. */
  function geralPorEmpresa(idx, contratoEmpresa) {
    if (!contratoEmpresa) return null;
    var alvo = _deacc(contratoEmpresa).replace(/[^a-z0-9]+/g,' ').trim();
    var out = [];
    idx.list.forEach(function (g) {
      if (g.empresa && _empresaMatch(contratoEmpresa, g.empresa)) out.push(g);
    });
    return out.length ? out : null;
  }

  /* Match — devolve { cron_geral_id, confianca, metodo, score } | null */
  function sugerirMatch(resumo, idx) {
    // 1) WBS exato
    var g = idx.byNumero[resumo.wbs];
    if (g) return { cron_geral_id: g.id, confianca: 'alta', metodo: 'wbs', score: 0.98 };

    // 2) Nome, restrito à empresa do contrato
    var resumoWords = _words(resumo.name);
    var subset = geralPorEmpresa(idx, resumo.contrato && resumo.contrato.empresa);
    var best = null, bestScore = 0;
    if (subset) {
      subset.forEach(function (g2) {
        var s = _jaccard(resumoWords, idx.wordsCache[g2.id] || {});
        if (s > bestScore) { best = g2; bestScore = s; }
      });
      if (best && bestScore >= 0.7) return { cron_geral_id: best.id, confianca: 'alta',   metodo: 'nome+empresa', score: bestScore };
      if (best && bestScore >= 0.5) return { cron_geral_id: best.id, confianca: 'media',  metodo: 'nome+empresa', score: bestScore };
      if (best && bestScore >= 0.35) return { cron_geral_id: best.id, confianca: 'baixa', metodo: 'nome+empresa', score: bestScore };
    }

    // 3) Nome livre (fallback, considera o geral inteiro)
    best = null; bestScore = 0;
    idx.list.forEach(function (g2) {
      var s = _jaccard(resumoWords, idx.wordsCache[g2.id] || {});
      if (s > bestScore) { best = g2; bestScore = s; }
    });
    if (best && bestScore >= 0.6) return { cron_geral_id: best.id, confianca: 'media', metodo: 'nome', score: bestScore };
    if (best && bestScore >= 0.4) return { cron_geral_id: best.id, confianca: 'baixa', metodo: 'nome', score: bestScore };

    return null; // sem sugestão — usuário decide manualmente
  }

  /* Para todos os resumos, produz { pending: [...linhas...] } onde cada linha
     junta o resumo, a sugestão do auto-match e o vínculo já salvo. */
  function computarLinhas(dados) {
    var idx = buildGeralIndex(dados.geral);
    return dados.resumos.map(function (r) {
      var key = r.cronograma_id + '::' + r.uid;
      var salvo = dados.vinculosByKey[key] || null;
      var sug   = salvo ? null : sugerirMatch(r, idx);
      return {
        resumo:            r,
        salvo:             salvo,                          // linha completa de cron_vinculo, ou null
        sugestao:          sug,                            // {cron_geral_id, confianca, metodo, score} | null
        cron_geral_id:     salvo ? salvo.cron_geral_id : (sug ? sug.cron_geral_id : null),
        confianca_view:    salvo ? 'salvo' : (sug ? sug.confianca : null),
        metodo_view:       salvo ? (salvo.metodo_rateio || 'manual') : (sug ? sug.metodo : null),
        _dirty:            false,       // marcado quando o usuário troca
        _selecionado:      false        // checkbox
      };
    });
  }

  /* Salva um lote de linhas em cron_vinculo (upsert por cronograma_id+terceira_uid).
     Só grava as linhas cujo cron_geral_id está preenchido. Devolve {gravados, ignorados}. */
  function salvarSelecionados(linhas) {
    var payload = [];
    linhas.forEach(function (L) {
      if (!L.cron_geral_id) return;
      payload.push(CG.comTag({
        cronograma_id: L.resumo.cronograma_id,
        terceira_uid:  L.resumo.uid,
        cron_geral_id: L.cron_geral_id,
        metodo_rateio: null,                                // Fase 3 preenche
        criado_por:    CG.userNome()
      }));
    });
    if (!payload.length) return Promise.resolve({ gravados: 0, ignorados: linhas.length });

    var qs = 'on_conflict=' + encodeURIComponent('cronograma_id,terceira_uid');
    var i = 0, size = 200;
    function next() {
      if (i >= payload.length) return Promise.resolve(payload.length);
      var slice = payload.slice(i, i + size);
      i += size;
      return fetch(SB_URL + '/rest/v1/cron_vinculo?' + qs, {
        method: 'POST',
        headers: {
          apikey: SB_KEY,
          Authorization: 'Bearer ' + SB_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=representation,resolution=merge-duplicates'
        },
        body: JSON.stringify(slice)
      }).then(function (res) {
        return res.text().then(function (txt) {
          if (!res.ok) throw new Error(res.status + ': ' + txt.slice(0,320));
          return next();
        });
      });
    }
    return next().then(function () { return { gravados: payload.length, ignorados: linhas.length - payload.length }; });
  }

  function excluirVinculo(cronograma_id, terceira_uid) {
    var url = 'cron_vinculo?cronograma_id=eq.' + encodeURIComponent(cronograma_id) +
              '&terceira_uid=eq.' + encodeURIComponent(terceira_uid);
    return CG.sb('DELETE', url);
  }

  /* ── Exports ─────────────────────────────────────────────── */
  global.CV = {
    MOD_KEY: MOD_KEY,
    loadAll: loadAll,
    buildGeralIndex: buildGeralIndex,
    sugerirMatch: sugerirMatch,
    computarLinhas: computarLinhas,
    salvarSelecionados: salvarSelecionados,
    excluirVinculo: excluirVinculo,
    _deacc: _deacc, _words: _words, _jaccard: _jaccard
  };

})(window);
