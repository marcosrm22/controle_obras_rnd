/* ================================================================
   unidade.js — Módulo de Multi-Unidade do PCO Digital
   ================================================================
   Carregado por TODOS os módulos, logo após config.js.
   Responsável por: saber qual unidade está ativa, oferecer o
   seletor de unidade (header) e ajudar a montar filtros/paylods
   do Supabase com a unidade correta.
   ================================================================ */

const PCO_UNIDADES = [
  { codigo: 'RDN', nome: 'Rondonópolis', uf: 'MT' },
  { codigo: 'RVD', nome: 'Rio Verde',    uf: 'GO' },
  { codigo: 'NMT', nome: 'Nova Mutum',   uf: 'MT' },
];

const UNIDADE_PADRAO = 'RDN';

/* ── Leitura básica ─────────────────────────────────────────── */
function pcoUnidadeAtual(){
  return sessionStorage.getItem('pco_unidade') || UNIDADE_PADRAO;
}

function pcoUnidadeInfo(codigo){
  codigo = codigo || pcoUnidadeAtual();
  return PCO_UNIDADES.find(u => u.codigo === codigo) || PCO_UNIDADES[0];
}

/* Unidades que o usuário logado pode ver/trocar (definido pelo ADM
   em admin_usuarios.html). Se não houver nada salvo, assume-se que
   o usuário só acessa a própria unidade padrão. */
function pcoUnidadesAcesso(){
  try{
    const raw = sessionStorage.getItem('pco_unidades_acesso');
    const arr = raw ? JSON.parse(raw) : [UNIDADE_PADRAO];
    return Array.isArray(arr) && arr.length ? arr : [UNIDADE_PADRAO];
  }catch(_){ return [UNIDADE_PADRAO] }
}

/* perfil='admin' (super admin) sempre enxerga todas as unidades */
function pcoUnidadesDisponiveis(){
  const perfil = sessionStorage.getItem('pco_perfil') || '';
  if(perfil === 'admin') return PCO_UNIDADES.map(u => u.codigo);
  return pcoUnidadesAcesso();
}

/* Troca a unidade ativa e recarrega a página atual para refletir
   os dados da nova unidade (mais simples e seguro do que tentar
   re-filtrar tudo em memória). */
function pcoSetUnidade(codigo){
  if(!PCO_UNIDADES.some(u => u.codigo === codigo)) return;
  sessionStorage.setItem('pco_unidade', codigo);
  window.location.reload();
}

/* ── Permissão de ADM por página, por unidade ─────────────────
   pco_perms.admin_paginas = { "analise_cronograma": ["RDN","RVD"], ... }
   perfil='admin' sempre pode administrar qualquer página/unidade. */
function pcoPodeAdministrar(chavePagina){
  const perfil = sessionStorage.getItem('pco_perfil') || '';
  if(perfil === 'admin') return true;
  try{
    const perms = JSON.parse(sessionStorage.getItem('pco_perms') || '{}');
    const escopo = (perms.admin_paginas || {})[chavePagina] || [];
    return escopo.includes(pcoUnidadeAtual());
  }catch(_){ return false }
}

/* ── Helpers para montar chamadas Supabase já com a unidade ──── */

/* Acrescenta "unidade=eq.XXX" a uma query string de SELECT.
   Uso: sbGet('drain_elements?select=' + pcoFiltro()) */
function pcoFiltroQS(){
  return 'unidade=eq.' + encodeURIComponent(pcoUnidadeAtual());
}

/* Junta um path de /rest/v1/ já existente com o filtro de unidade,
   cuidando de usar ? ou & corretamente.
   Uso: sbGet(pcoComUnidade('drain_elements?select=id,status')) */
function pcoComUnidade(path){
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + pcoFiltroQS();
}

/* Garante que um objeto (ou array de objetos) a ser gravado
   (INSERT/UPSERT) carregue o campo unidade correto.
   Uso: body: JSON.stringify(pcoComTag(novoRegistro)) */
function pcoComTag(obj){
  const tag = r => ({ ...r, unidade: pcoUnidadeAtual() });
  return Array.isArray(obj) ? obj.map(tag) : tag(obj);
}

/* ── Widget: seletor de unidade para o header ─────────────────
   Uso: <span id="unidade-switcher"></span>
        document.addEventListener('DOMContentLoaded', pcoRenderSwitcher);
   Se o usuário só tem acesso a 1 unidade, mostra um rótulo fixo
   (sem dropdown) para não sugerir uma troca que não é permitida. */
function pcoRenderSwitcher(containerId){
  const el = document.getElementById(containerId || 'unidade-switcher');
  if(!el) return;

  const disponiveis = pcoUnidadesDisponiveis();
  const atual = pcoUnidadeAtual();

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;font-family:Montserrat,sans-serif';

  const label = document.createElement('span');
  label.textContent = '📍';
  label.style.cssText = 'font-size:12px';
  wrap.appendChild(label);

  if(disponiveis.length <= 1){
    const fixo = document.createElement('span');
    fixo.textContent = pcoUnidadeInfo(atual).nome;
    fixo.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text-dim,#546175)';
    wrap.appendChild(fixo);
  } else {
    const sel = document.createElement('select');
    sel.id = 'pco-unidade-select';
    sel.style.cssText = 'font-family:Montserrat,sans-serif;font-size:10px;font-weight:700;letter-spacing:.5px;'
      + 'text-transform:uppercase;border:1px solid var(--border-2,#c1c9d3);background:#fff;color:var(--text,#1a2332);'
      + 'padding:5px 8px;cursor:pointer;outline:none';
    disponiveis.forEach(codigo => {
      const info = pcoUnidadeInfo(codigo);
      const opt = document.createElement('option');
      opt.value = codigo;
      opt.textContent = info.nome;
      opt.selected = codigo === atual;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => pcoSetUnidade(sel.value));
    wrap.appendChild(sel);
  }

  el.innerHTML = '';
  el.appendChild(wrap);
}

if(typeof window !== 'undefined'){
  window.PCO_UNIDADES = PCO_UNIDADES;
  window.pcoUnidadeAtual = pcoUnidadeAtual;
  window.pcoUnidadeInfo = pcoUnidadeInfo;
  window.pcoUnidadesAcesso = pcoUnidadesAcesso;
  window.pcoUnidadesDisponiveis = pcoUnidadesDisponiveis;
  window.pcoSetUnidade = pcoSetUnidade;
  window.pcoPodeAdministrar = pcoPodeAdministrar;
  window.pcoFiltroQS = pcoFiltroQS;
  window.pcoComUnidade = pcoComUnidade;
  window.pcoComTag = pcoComTag;
  window.pcoRenderSwitcher = pcoRenderSwitcher;
}
