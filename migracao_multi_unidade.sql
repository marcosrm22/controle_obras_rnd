-- ================================================================
-- PCO Digital — Migração Multi-Unidade (RDN / RVD / NMT)
-- ================================================================
-- Rode este script inteiro no SQL Editor do Supabase.
-- Ele é seguro para rodar em produção: usa "IF NOT EXISTS" em tudo
-- e o valor padrão 'RDN' garante que os dados que já existem hoje
-- continuem sendo tratados como pertencentes a Rondonópolis.
-- ================================================================

-- 1. Tabela de unidades ------------------------------------------------
create table if not exists pco_unidades (
  codigo text primary key,
  nome   text not null,
  uf     text,
  ativo  boolean not null default true
);

insert into pco_unidades (codigo, nome, uf) values
  ('RDN', 'Rondonópolis', 'MT'),
  ('RVD', 'Rio Verde',    'GO'),
  ('NMT', 'Nova Mutum',   'MT')
on conflict (codigo) do nothing;

alter table pco_unidades enable row level security;
drop policy if exists "allow all pco_unidades" on pco_unidades;
create policy "allow all pco_unidades" on pco_unidades for all using (true) with check (true);


-- 2. Usuários: quais unidades cada pessoa pode acessar -----------------
alter table pco_usuarios
  add column if not exists unidades_acesso jsonb not null default '["RDN"]'::jsonb;
-- Obs.: o admin_paginas (quem administra qual página em qual unidade)
-- fica dentro da coluna "permissoes" já existente, sem precisar de
-- coluna nova — ex.: permissoes.admin_paginas = {"analise_cronograma":["RDN"]}


-- 3. Coluna "unidade" em cada tabela de dados ---------------------------
-- Ajuste esta lista se você tiver criado outras tabelas além destas.
do $$
declare
  t text;
  tabelas text[] := array[
    'drain_elements',
    'terra_areas',
    'bases_civis_elementos',
    'cronograma_analises',
    'val_cronogramas',
    'val_revisoes',
    'dornas_chapas',
    'cronograma_tarefas',
    'lookahead_atividades',
    'ppc_registro',
    'areas_config',
    'pco_link_config'
  ];
begin
  foreach t in array tabelas loop
    if exists (select 1 from information_schema.tables where table_name = t) then
      execute format(
        'alter table %I add column if not exists unidade text not null default ''RDN''',
        t
      );
      execute format(
        'create index if not exists idx_%s_unidade on %I (unidade)',
        t, t
      );
    end if;
  end loop;
end $$;

-- ================================================================
-- IMPORTANTE — leia antes de liberar o acesso para outras unidades
-- ================================================================
-- O isolamento entre unidades hoje é feito pela aplicação (cada tela
-- só busca/grava com "unidade=eq.XXX"), não por Row Level Security —
-- assim como o restante do sistema já funciona hoje com a chave
-- publicável. Ou seja: é o mesmo nível de segurança que o PCO já
-- tem para todo o resto (chave anônima + "allow all"). Se no futuro
-- vocês quiserem impedir que a própria chave do navegador consiga
-- ler/gravar em outra unidade mesmo manipulando a requisição, aí sim
-- vale migrar para políticas de RLS por unidade — me avise quando
-- quiser evoluir para esse nível.
-- ================================================================
