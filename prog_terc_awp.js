/* ================================================================
   prog_terc_awp.js — Camada de enriquecimento AWP (Fase 3)
   ----------------------------------------------------------------
   Carrega cron_geral_atividades + cron_vinculo e enriquece:
     - Atividades-folha das terceiras (do PT.loadAtividades) com
       cwa, cwp, fase, cron_geral_id, peso_lb_abs, peso_pct_projeto,
       metodo_rateio, vinculo_herdado, sem_vinculo, wbs_anchor.
     - Cards da programação semanal (prog_terc_programacao) copiando
       as propriedades da atividade correspondente por
       (cronograma_id, terceira_uid).

   Fallback: se algum cron_vinculo não tem terceira_wbs (linhas antigas),
   busca val_revisoes daquele cronograma para resolver — depois cacheia.

   Rateio de peso por grupo (todas as folhas que resolvem para o MESMO
   cron_geral_id via herança de WBS):
     Se todas com CP>0:      metodo=CP,      peso = custo_lb × CP_folha/ΣCP
     Se nenhuma tem CP mas todas têm duração: metodo=DURACAO,
                             peso = custo_lb × dias_folha/Σdias
     Se mix:                 metodo=MISTO,   peso relativo = CP (se>0) ou dias (fallback 1)
     Senão:                  metodo=IGUAL,   peso = custo_lb / N

   Carregar depois de config.js, unidade.js e prog_terc_core.js.
   ================================================================ */

(function (global) {
  'use strict';
  var PT = global.PT;
  if (!PT) throw new Error('prog_terc_awp.js precisa de prog_terc_core.js carregado antes.');

  var _cacheRegras = null;

  /* ============ Carrega tudo que a enriquecimento precisa ============ */
  function loadRegras(force) {
    if (_cacheRegras && !force) return Promise.resolve(_cacheRegras);

    var pGeral = PT.sbGetAll(PT.comUnidade('cron_geral_atividades?select=*&tipo_pacote=eq.EXECUCAO&ativo=eq.true'))
                    .catch(function (e) { if (PT.isMissingTable(e)) return []; throw e; });
    var pVinc  = PT.sbGetAll(PT.comUnidade('cron_vinculo?select=*'))
                    .catch(function (e) { if (PT.isMissingTable(e)) return []; throw e; });
    var pNaoExec = PT.sbGetAll(PT.comUnidade('terc_nao_executavel?select=cronograma_id,terceira_uid,motivo'))
                    .catch(function (e) { if (PT.isMissingTable(e)) return []; throw e; });

    return Promise.all([pGeral, pVinc, pNaoExec]).then(function (r) {
      var geral    = r[0] || [];
      var vinculos = r[1] || [];
      var naoExec  = r[2] || [];

      // Set de "cronograma_id::terceira_uid" que não executa
      var naoExecKey = {};
      naoExec.forEach(function (n) { naoExecKey[n.cronograma_id + '::' + n.terceira_uid] = n.motivo || true; });

      // Índice geral por id
      var geralById = {};
      geral.forEach(function (g) { geralById[g.id] = g; });

      // Peso total do projeto (EXECUCAO ativo) — denominador dos %
      var pesoProjeto = geral.reduce(function (s, g) { return s + (Number(g.custo_lb) || 0); }, 0);

      // Peso por fase — denominador dos % por fase
      var pesoPorFase = { FASE_I: 0, FASE_II: 0, ARMAZEM: 0, POSTO: 0, sem_fase: 0 };
      geral.forEach(function (g) {
        var k = g.fase && pesoPorFase.hasOwnProperty(g.fase) ? g.fase : 'sem_fase';
        pesoPorFase[k] += (Number(g.custo_lb) || 0);
      });

      // Peso por CWA
      var pesoPorCwa = {};
      geral.forEach(function (g) {
        if (!g.cwa) return;
        pesoPorCwa[g.cwa] = (pesoPorCwa[g.cwa] || 0) + (Number(g.custo_lb) || 0);
      });

      // Separa vínculos com terceira_wbs (rápido) e sem (fallback fetch)
      var comWbs = [], semWbs = [];
      vinculos.forEach(function (v) {
        if (v.terceira_wbs) comWbs.push(v);
        else                semWbs.push(v);
      });

      // Fallback: para cada cronograma_id com vínculos sem wbs, busca val_revisoes
      var cronIdsSemWbs = {};
      semWbs.forEach(function (v) { cronIdsSemWbs[v.cronograma_id] = true; });
      var cronIdsFallback = Object.keys(cronIdsSemWbs);

      var pFallback = Promise.resolve({});
      if (cronIdsFallback.length) {
        pFallback = Promise.all(cronIdsFallback.map(function (cid) {
          var q = 'val_revisoes?cronograma_id=eq.' + cid +
                  '&tarefas_json=not.is.null' +
                  '&select=cronograma_id,tarefas_json' +
                  '&order=revisao.desc&limit=1';
          return PT.sb('GET', PT.comUnidade(q))
            .then(function (revs) {
              var tj = (revs && revs[0] && revs[0].tarefas_json) || [];
              if (typeof tj === 'string') { try { tj = JSON.parse(tj); } catch(_) { tj = []; } }
              if (!Array.isArray(tj)) tj = [];
              var mUW = {};
              tj.forEach(function (t) { if (t && t.uid && t.wbs) mUW[String(t.uid)] = String(t.wbs); });
              return { cid: cid, mUW: mUW };
            })
            .catch(function () { return { cid: cid, mUW: {} }; });
        })).then(function (pares) {
          var map = {};
          pares.forEach(function (p) { map[p.cid] = p.mUW; });
          return map;
        });
      }

      return pFallback.then(function (wbsPorUidPorCronFallback) {
        // Constrói vinculos por cronograma, com wbs resolvido
        var vinculosPorCron = {};
        var vinculosOrfaos = 0;

        comWbs.forEach(function (v) {
          (vinculosPorCron[v.cronograma_id] = vinculosPorCron[v.cronograma_id] || []).push({
            wbs: String(v.terceira_wbs), cron_geral_id: v.cron_geral_id, uid: v.terceira_uid
          });
        });
        semWbs.forEach(function (v) {
          var mapa = wbsPorUidPorCronFallback[v.cronograma_id];
          var wbs  = mapa && mapa[String(v.terceira_uid)];
          if (!wbs) { vinculosOrfaos++; return; }
          (vinculosPorCron[v.cronograma_id] = vinculosPorCron[v.cronograma_id] || []).push({
            wbs: wbs, cron_geral_id: v.cron_geral_id, uid: v.terceira_uid
          });
        });

        // Ordena por WBS mais longo primeiro — o mais específico ganha na resolução
        Object.keys(vinculosPorCron).forEach(function (cid) {
          vinculosPorCron[cid].sort(function (a, b) { return b.wbs.length - a.wbs.length; });
        });

        _cacheRegras = {
          geralById:         geralById,
          geralList:         geral,
          vinculosPorCron:   vinculosPorCron,
          pesoProjeto:       pesoProjeto,
          pesoPorFase:       pesoPorFase,
          pesoPorCwa:        pesoPorCwa,
          totalGeral:        geral.length,
          totalVinculos:     vinculos.length,
          vinculosOrfaos:    vinculosOrfaos,
          naoExecKey:        naoExecKey,
          totalNaoExec:      naoExec.length
        };
        return _cacheRegras;
      });
    });
  }

  /* ============ NÃO EXECUTÁVEIS ============ */
  function isNaoExecutavel(cronograma_id, terceira_uid, regras) {
    var R = regras || _cacheRegras;
    if (!R || !R.naoExecKey) return false;
    return !!R.naoExecKey[cronograma_id + '::' + terceira_uid];
  }
  function filtrarExecutaveis(atividades, regras) {
    return (atividades || []).filter(function (a) {
      return !isNaoExecutavel(a.cronograma_id, a.uid, regras);
    });
  }
  /* Marca como não executável (upsert). Retorna Promise. */
  function marcarNaoExec(cronograma_id, terceira_uid, opts) {
    opts = opts || {};
    var payload = {
      cronograma_id: cronograma_id,
      terceira_uid:  String(terceira_uid),
      terceira_wbs:  opts.terceira_wbs || null,
      motivo:        opts.motivo || null,
      criado_por:    PT.userNome()
    };
    // adiciona unidade via comTag
    if (typeof global.pcoComTag === 'function') payload = global.pcoComTag(payload);
    else payload.unidade = sessionStorage.getItem('pco_unidade') || 'RDN';
    var CFG = global.PCO_CONFIG || {}, SB_URL = (CFG.supabase||{}).url, SB_KEY = (CFG.supabase||{}).key;
    return fetch(SB_URL + '/rest/v1/terc_nao_executavel?on_conflict=' + encodeURIComponent('cronograma_id,terceira_uid'), {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type':'application/json', Prefer:'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify([payload])
    }).then(function(res){
      return res.text().then(function(txt){ if(!res.ok) throw new Error(res.status + ': ' + txt.slice(0,320)); });
    }).then(function () {
      if (_cacheRegras && _cacheRegras.naoExecKey) _cacheRegras.naoExecKey[cronograma_id + '::' + terceira_uid] = opts.motivo || true;
    });
  }
  function desmarcarNaoExec(cronograma_id, terceira_uid) {
    var url = 'terc_nao_executavel?cronograma_id=eq.' + encodeURIComponent(cronograma_id) +
              '&terceira_uid=eq.' + encodeURIComponent(terceira_uid);
    return PT.sb('DELETE', url).then(function () {
      if (_cacheRegras && _cacheRegras.naoExecKey) delete _cacheRegras.naoExecKey[cronograma_id + '::' + terceira_uid];
    });
  }

  /* Batch: marca N atividades como não executáveis num único POST */
  function marcarNaoExecBatch(items, motivo) {
    if (!items || !items.length) return Promise.resolve({ok:0, err:0});
    var payload = items.map(function (i) {
      var p = {
        cronograma_id: i.cronograma_id,
        terceira_uid:  String(i.terceira_uid),
        terceira_wbs:  i.terceira_wbs || null,
        motivo:        motivo || i.motivo || null,
        criado_por:    PT.userNome()
      };
      if (typeof global.pcoComTag === 'function') p = global.pcoComTag(p);
      else p.unidade = sessionStorage.getItem('pco_unidade') || 'RDN';
      return p;
    });
    var CFG = global.PCO_CONFIG || {}, SB_URL = (CFG.supabase||{}).url, SB_KEY = (CFG.supabase||{}).key;
    var qs = 'on_conflict=' + encodeURIComponent('cronograma_id,terceira_uid');
    return fetch(SB_URL + '/rest/v1/terc_nao_executavel?' + qs, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type':'application/json',
                 Prefer: 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify(payload)
    }).then(function(res){
      return res.text().then(function(txt){
        if(!res.ok) throw new Error(res.status + ': ' + txt.slice(0,320));
        // atualiza cache
        if (_cacheRegras && _cacheRegras.naoExecKey) {
          items.forEach(function(i){ _cacheRegras.naoExecKey[i.cronograma_id + '::' + i.terceira_uid] = motivo || true; });
        }
        return { ok: items.length, err: 0 };
      });
    });
  }

  /* Batch: reativa N atividades (delete em lote via or filter do PostgREST) */
  function desmarcarNaoExecBatch(items) {
    if (!items || !items.length) return Promise.resolve({ok:0, err:0});
    // Agrupa por cronograma_id — cada grupo vira 1 DELETE com filtro IN
    var porCron = {};
    items.forEach(function(i){ (porCron[i.cronograma_id] = porCron[i.cronograma_id] || []).push(String(i.terceira_uid)); });
    var proms = Object.keys(porCron).map(function(cid){
      var uids = porCron[cid];
      var lista = uids.map(function(u){ return '"' + String(u).replace(/"/g,'\\"') + '"'; }).join(',');
      var url = 'terc_nao_executavel?cronograma_id=eq.' + encodeURIComponent(cid) +
                '&terceira_uid=in.(' + lista + ')';
      return PT.sb('DELETE', url).catch(function(){}); // idempotente
    });
    return Promise.all(proms).then(function(){
      if (_cacheRegras && _cacheRegras.naoExecKey) {
        items.forEach(function(i){ delete _cacheRegras.naoExecKey[i.cronograma_id + '::' + i.terceira_uid]; });
      }
      return { ok: items.length, err: 0 };
    });
  }

  /* ============ TAREFAS DE UM CRONOGRAMA (para o modal split-view) ============ */
  var _cacheTarefas = {};
  function loadTarefasCronograma(cronograma_id, force) {
    if (!force && _cacheTarefas[cronograma_id]) return Promise.resolve(_cacheTarefas[cronograma_id]);
    var q = 'val_revisoes?cronograma_id=eq.' + cronograma_id +
            '&tarefas_json=not.is.null&select=cronograma_id,revisao,tarefas_json&order=revisao.desc&limit=1';
    return PT.sb('GET', PT.comUnidade(q)).then(function (revs) {
      var tj = (revs && revs[0] && revs[0].tarefas_json) || [];
      if (typeof tj === 'string') { try { tj = JSON.parse(tj); } catch(_) { tj = []; } }
      if (!Array.isArray(tj)) tj = [];
      _cacheTarefas[cronograma_id] = tj;
      return tj;
    });
  }

  /* ============ SALVA UM LOTE DE VÍNCULOS (upsert em batch) ============
     items = [{cronograma_id, terceira_uid, terceira_wbs, cron_geral_id}]
     cron_geral_id=null em algum item o pula (não é DELETE em batch aqui). */
  function salvarVinculosBatch(items) {
    if (!items || !items.length) return Promise.resolve({ok:0});
    var upserts = items.filter(function (i) { return i.cron_geral_id != null; });
    if (!upserts.length) return Promise.resolve({ok:0});
    var payload = upserts.map(function (i) {
      var p = {
        cronograma_id: i.cronograma_id,
        terceira_uid:  String(i.terceira_uid),
        terceira_wbs:  i.terceira_wbs || null,
        cron_geral_id: i.cron_geral_id,
        metodo_rateio: null,
        criado_por:    PT.userNome()
      };
      if (typeof global.pcoComTag === 'function') p = global.pcoComTag(p);
      else p.unidade = sessionStorage.getItem('pco_unidade') || 'RDN';
      return p;
    });
    var CFG = global.PCO_CONFIG || {}, SB_URL = (CFG.supabase||{}).url, SB_KEY = (CFG.supabase||{}).key;
    var qs = 'on_conflict=' + encodeURIComponent('cronograma_id,terceira_uid');
    return fetch(SB_URL + '/rest/v1/cron_vinculo?' + qs, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type':'application/json',
                 Prefer: 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify(payload)
    }).then(function(res){
      return res.text().then(function(txt){
        if(!res.ok) throw new Error(res.status + ': ' + txt.slice(0,320));
        return { ok: payload.length };
      });
    });
  }

  /* ============ SALVA/REMOVE UM ÚNICO VÍNCULO (para o modal) ============ */
  function salvarVinculoUnico(cronograma_id, terceira_uid, terceira_wbs, cron_geral_id) {
    var CFG = global.PCO_CONFIG || {}, SB_URL = (CFG.supabase||{}).url, SB_KEY = (CFG.supabase||{}).key;
    if (cron_geral_id == null) {
      var url = 'cron_vinculo?cronograma_id=eq.' + encodeURIComponent(cronograma_id) +
                '&terceira_uid=eq.' + encodeURIComponent(String(terceira_uid));
      return PT.sb('DELETE', url);
    }
    var payload = {
      cronograma_id: cronograma_id,
      terceira_uid:  String(terceira_uid),
      terceira_wbs:  terceira_wbs || null,
      cron_geral_id: cron_geral_id,
      metodo_rateio: null,
      criado_por:    PT.userNome()
    };
    if (typeof global.pcoComTag === 'function') payload = global.pcoComTag(payload);
    else payload.unidade = sessionStorage.getItem('pco_unidade') || 'RDN';
    var qs = 'on_conflict=' + encodeURIComponent('cronograma_id,terceira_uid');
    return fetch(SB_URL + '/rest/v1/cron_vinculo?' + qs, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type':'application/json', Prefer:'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify([payload])
    }).then(function(res){
      return res.text().then(function(txt){ if(!res.ok) throw new Error(res.status + ': ' + txt.slice(0,320)); });
    });
  }

  /* ============ Resolução de vínculo efetivo por WBS ============ */
  function resolverVinculo(atividade, regras) {
    var vins = regras.vinculosPorCron[atividade.cronograma_id];
    if (!vins || !vins.length) return null;
    var wbs = String(atividade.wbs || '');
    if (!wbs) return null;
    for (var i = 0; i < vins.length; i++) {
      var v = vins[i];
      if (wbs === v.wbs || wbs.indexOf(v.wbs + '.') === 0) {
        return { cron_geral_id: v.cron_geral_id, herdado: (wbs !== v.wbs), wbs_anchor: v.wbs };
      }
    }
    return null;
  }

  /* ============ Enriquecimento das ATIVIDADES-FOLHA ============ */
  function enriquecerAtividades(atividades, regras) {
    // Passo 1: resolve vínculo + copia cwa/cwp/fase
    atividades.forEach(function (a) {
      // reset (idempotência)
      a.cron_geral_id = null; a.cwa = null; a.cwp = null; a.fase = null;
      a.peso_lb_abs = 0; a.peso_pct_projeto = 0; a.metodo_rateio = null;
      a.vinculo_herdado = false; a.sem_vinculo = true; a.wbs_anchor = null;

      var v = resolverVinculo(a, regras);
      if (!v) return;
      var g = regras.geralById[v.cron_geral_id];
      if (!g) return;      // vínculo aponta pra atividade removida do geral
      a.cron_geral_id   = v.cron_geral_id;
      a.wbs_anchor      = v.wbs_anchor;
      a.vinculo_herdado = v.herdado;
      a.sem_vinculo     = false;
      a.cwa  = g.cwa  || null;
      a.cwp  = g.cwp  || null;
      a.fase = g.fase || null;
    });

    // Passo 2: agrupa por cron_geral_id e rateia
    var grupos = {};
    atividades.forEach(function (a) {
      if (!a.cron_geral_id) return;
      (grupos[a.cron_geral_id] = grupos[a.cron_geral_id] || []).push(a);
    });

    Object.keys(grupos).forEach(function (gid) {
      var grupo = grupos[gid];
      var g = regras.geralById[gid];
      var pesoDisponivel = Number(g && g.custo_lb) || 0;

      var todasCP  = grupo.every(function (a) { return (Number(a.custoPrev) || 0) > 0; });
      var algumasCP = grupo.some(function (a) { return (Number(a.custoPrev) || 0) > 0; });
      var todasDur = grupo.every(function (a) { return _diasUteis(a) > 0; });

      var metodo;
      if      (todasCP)   metodo = 'CP';
      else if (todasDur)  metodo = 'DURACAO';
      else if (algumasCP) metodo = 'MISTO';
      else                metodo = 'IGUAL';

      var relativos = grupo.map(function (a) {
        if (metodo === 'CP')      return Number(a.custoPrev) || 0;
        if (metodo === 'DURACAO') return _diasUteis(a) || 1;
        if (metodo === 'IGUAL')   return 1;
        // MISTO: CP se tiver, senão duração, fallback 1
        var cp = Number(a.custoPrev) || 0;
        if (cp > 0) return cp;
        var du = _diasUteis(a);
        return du > 0 ? du : 1;
      });
      var soma = relativos.reduce(function (s, x) { return s + x; }, 0) || 1;

      grupo.forEach(function (a, i) {
        a.peso_lb_abs      = pesoDisponivel * relativos[i] / soma;
        a.metodo_rateio    = metodo;
        a.peso_pct_projeto = regras.pesoProjeto ? (a.peso_lb_abs / regras.pesoProjeto * 100) : 0;
      });
    });

    // Estatísticas
    var stats = { total: atividades.length, comVinculo: 0, semVinculo: 0,
                  pesoComVinculo: 0, gruposPorMetodo: {} };
    atividades.forEach(function (a) {
      if (a.cron_geral_id) {
        stats.comVinculo++;
        stats.pesoComVinculo += (a.peso_lb_abs || 0);
      } else stats.semVinculo++;
    });
    Object.keys(grupos).forEach(function (gid) {
      var m = grupos[gid][0].metodo_rateio;
      stats.gruposPorMetodo[m] = (stats.gruposPorMetodo[m] || 0) + 1;
    });
    return stats;
  }

  /* ============ Enriquecimento dos CARDS ============ */
  function enriquecerCards(cards, atividades) {
    var idx = {};
    atividades.forEach(function (a) { idx[a.cronograma_id + '::' + a.uid] = a; });
    cards.forEach(function (c) {
      c.cwa = null; c.cwp = null; c.fase = null;
      c.cron_geral_id = null; c.peso_lb_abs = 0; c.peso_pct_projeto = 0;
      c.metodo_rateio = null; c.vinculo_herdado = false; c.sem_vinculo = true;
      if (c.cronograma_id == null || c.terceira_uid == null) return; // card avulso
      var a = idx[c.cronograma_id + '::' + String(c.terceira_uid)];
      if (!a) return;
      c.cwa = a.cwa; c.cwp = a.cwp; c.fase = a.fase;
      c.cron_geral_id = a.cron_geral_id;
      c.peso_lb_abs = a.peso_lb_abs || 0;
      c.peso_pct_projeto = a.peso_pct_projeto || 0;
      c.metodo_rateio = a.metodo_rateio || null;
      c.vinculo_herdado = !!a.vinculo_herdado;
      c.sem_vinculo = !!a.sem_vinculo;
    });
  }

  /* ============ Duração em dias (baseline preferido, prev fallback) ============ */
  function _diasUteis(a) {
    var s = a.inicio || null;
    var f = a.termino || null;
    if (!s || !f) return 0;
    var ds = new Date(s), df = new Date(f);
    if (isNaN(ds) || isNaN(df)) return 0;
    return Math.max(1, Math.round((df - ds) / 86400000) + 1);
  }

  /* ============ One-shot: carrega regras e enriquece atividades + cards ============ */
  function enriquecerTudo(atividades, cards, force) {
    return loadRegras(force).then(function (regras) {
      var stats = enriquecerAtividades(atividades, regras);
      if (cards) enriquecerCards(cards, atividades);
      return { regras: regras, stats: stats };
    });
  }

  /* ============ KPIs de uma lista de cards da semana ============ */
  function kpisSemana(cards, regras) {
    var doneCards = cards.filter(function (c) { return c.coluna === 'concluida'; });
    var pesoProg = cards.reduce(function (s, c) { return s + (Number(c.peso_lb_abs) || 0); }, 0);
    var pesoReal = doneCards.reduce(function (s, c) { return s + (Number(c.peso_lb_abs) || 0); }, 0);
    var pesoRealParcial = cards.reduce(function (s, c) {
      var frac;
      if (c.coluna === 'concluida') frac = 1;
      else if (c.qtd_prog && c.qtd_real != null) frac = Math.max(0, Math.min(1, c.qtd_real / c.qtd_prog));
      else frac = 0;
      return s + (Number(c.peso_lb_abs) || 0) * frac;
    }, 0);
    var semPeso = cards.filter(function (c) { return !c.peso_lb_abs; }).length;
    return {
      qtd:              cards.length,
      qtdDone:          doneCards.length,
      ppcContagem:      cards.length ? Math.round(doneCards.length / cards.length * 100) : null,
      pesoProg:         pesoProg,
      pesoReal:         pesoReal,
      pesoRealParcial:  pesoRealParcial,
      ppcPeso:          pesoProg ? Math.round(pesoReal / pesoProg * 100) : null,
      aderenciaParcial: pesoProg ? Math.round(pesoRealParcial / pesoProg * 100) : null,
      pctProjSemana:    regras && regras.pesoProjeto ? (pesoProg / regras.pesoProjeto * 100) : 0,
      cardsSemPeso:     semPeso
    };
  }

  /* ============ Agregado: peso por chave arbitrária ============ */
  function agregar(items, keyFn) {
    var out = {};
    items.forEach(function (x) {
      var k = keyFn(x);
      if (k == null || k === '') return;
      out[k] = (out[k] || 0) + (Number(x.peso_lb_abs) || 0);
    });
    return out;
  }

  /* ============ Formatador auxiliar ============ */
  function fmtPct(v, dec) { if (v == null || isNaN(v)) return '—'; return Number(v).toFixed(dec == null ? 2 : dec) + '%'; }
  function fmtBRL(v)      { if (v == null || isNaN(v)) return '—'; return Number(v).toLocaleString('pt-BR', { style:'currency', currency:'BRL', maximumFractionDigits:0 }); }

  global.PTA = {
    loadRegras:          loadRegras,
    enriquecerAtividades: enriquecerAtividades,
    enriquecerCards:      enriquecerCards,
    enriquecerTudo:       enriquecerTudo,
    resolverVinculo:      resolverVinculo,
    kpisSemana:           kpisSemana,
    agregar:              agregar,
    fmtPct:               fmtPct,
    fmtBRL:               fmtBRL,
    cache:                function () { return _cacheRegras; },
    // Não executáveis
    isNaoExecutavel:      isNaoExecutavel,
    filtrarExecutaveis:   filtrarExecutaveis,
    marcarNaoExec:        marcarNaoExec,
    desmarcarNaoExec:     desmarcarNaoExec,
    marcarNaoExecBatch:   marcarNaoExecBatch,
    desmarcarNaoExecBatch: desmarcarNaoExecBatch,
    // Modal split-view
    loadTarefasCronograma: loadTarefasCronograma,
    salvarVinculoUnico:    salvarVinculoUnico,
    salvarVinculosBatch:   salvarVinculosBatch
  };
})(window);
