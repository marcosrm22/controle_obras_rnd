/* ================================================================
   config.js — Configuração Central do PCO Digital
   ================================================================
   Este arquivo é carregado por TODOS os módulos do sistema.
   Edite apenas aqui para atualizar credenciais em todos os arquivos.
   ================================================================ */

const PCO_CONFIG = {

  /* ── SUPABASE ─────────────────────────────────────────────── */
  supabase: {
    url: 'https://vfqesvmaqxvlgtshyoja.supabase.co',   // <- Project URL
    key: 'sb_publishable_iM-DC7LaA8Ur3mRqpAyy5w_r7bx6LD7',             // <- anon/public key
  },

  /* ── GITHUB (para publicação direta pelo painel) ─────────── */
  github: {
    owner:  'marcosrm22',       // <- seu usuario do GitHub
    repo:   'controle_obras_rnd',    // <- nome do repositorio
    branch: 'main',
    // Token com permissao "Contents: Read & Write"
    // Gere em: GitHub -> Settings -> Developer settings -> Personal access tokens -> Fine-grained
    token:  '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',
  },

  /* ── SISTEMA ──────────────────────────────────────────────── */
  system: {
    version:       '1.0',
    passwordEdicao: '1234',      // <- senha de edicao dos dashboards
  },

};

// Exporta para uso global (compativel com <script src="config.js">)
if (typeof window !== 'undefined') window.PCO_CONFIG = PCO_CONFIG;
