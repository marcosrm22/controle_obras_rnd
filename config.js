/* ================================================================
   config.js — Configuração Central do PCO Digital
   ================================================================
   Este arquivo é carregado por TODOS os módulos do sistema e é
   servido publicamente. NÃO coloque segredos aqui (tokens de
   escrita, chaves privadas, service_role do Supabase, etc.).
   Só pode conter o que é seguro ficar público:
     - URL do Supabase
     - publishable/anon key do Supabase (protegida por RLS)
   ================================================================ */

const PCO_CONFIG = {

  /* ── SUPABASE ─────────────────────────────────────────────────
     A 'key' abaixo é a publishable/anon key — pode ser pública,
     pois o acesso é controlado pelas policies de RLS no banco. */
  supabase: {
    url: 'https://vfqesvmaqxvlgtshyoja.supabase.co',   // Project URL
    key: 'sb_publishable_iM-DC7LaA8Ur3mRqpAyy5w_r7bx6LD7',  // anon/public key (OK ser pública)
  },

  /* ── SISTEMA ──────────────────────────────────────────────────
     Atenção: 'passwordEdicao' é apenas uma trava de interface e
     também fica visível neste arquivo público. Não é uma barreira
     de segurança real — a proteção dos dados depende do RLS do
     Supabase, não desta senha. */
  system: {
    version:        '1.1',
    passwordEdicao: '1234',
  },

  /* ── PUBLICAÇÃO ───────────────────────────────────────────────
     A publicação do site NÃO usa mais token no navegador.
     O deploy é feito por push no GitHub (a Vercel republica
     automaticamente a cada push). Se um dia for preciso publicar
     pelo painel, o token do GitHub deve ficar SOMENTE no servidor
     (ex.: uma Vercel Function com o token em variável de ambiente),
     nunca neste arquivo. */

};

// Exporta para uso global (compatível com <script src="config.js">)
if (typeof window !== 'undefined') window.PCO_CONFIG = PCO_CONFIG;
