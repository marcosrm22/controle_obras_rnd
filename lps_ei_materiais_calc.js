/* ================================================================
   supabase_lps_ei_areas_geral.sql
   Áreas de agrupamento — módulo LPS · E&I, unidade RDN
   ================================================================
   Por que existe:
   as listas do modelo ON7 trazem a área no campo PRÉDIO do cabeçalho,
   e algumas são emitidas no nível do GRUPO, não da sub-área. A lista
   "ON7-LM-ATR-2300-101-R1-GERAL" é assim: o campo PRÉDIO diz
   "2300 - GERAL", ou seja, o aterramento cobre o conjunto 2300
   (Pipe Rack + Terraplanagem + Drenagem + Pavimentação), não uma
   delas em especial.

   Sem um registro de área com código "2300" essa demanda vira órfã
   no painel — aparece no rodapé da aba Status como área não
   reconhecida e não entra no semáforo de nenhuma área.

   Rode este script se você quiser que as listas emitidas no nível de
   grupo tenham onde cair. Idempotente.
   ================================================================ */

insert into public.lps_ei_areas (unidade, codigo, nome, descricao, ordem) values
  ('RDN', '2300', 'Geral (Pipe Rack, Terraplanagem, Drenagem, Pavimentação)', 'Fase 1',   5),
  ('RDN', '2400', 'Geral (Pipe Rack, Terraplanagem, Drenagem, Pavimentação)', 'Fase 2', 585)
on conflict (unidade, codigo) do update
   set nome      = excluded.nome,
       descricao = excluded.descricao,
       ordem     = excluded.ordem,
       ativo     = true;

/* ----------------------------------------------------------------
   OPCIONAL — demais níveis de agrupamento
   Estes códigos aparecem como nós de agrupamento no cronograma
   (2302. Cozimento, 2306. Fermentação...) mas não são áreas no seu
   cadastro. Descomente apenas os que realmente receberem lista de
   material no nível do grupo — cada linha aqui vira mais uma área
   cinza no painel enquanto não houver contrato/projeto/material.
   ---------------------------------------------------------------- */
-- insert into public.lps_ei_areas (unidade, codigo, nome, descricao, ordem) values
--   ('RDN', '2301', 'Geração de vapor',                        'Fase 1', 6),
--   ('RDN', '2302', 'Cozimento',                               'Fase 1', 6),
--   ('RDN', '2303', 'Estação de Tratamento de Efluentes (ETE)', 'Fase 1', 6),
--   ('RDN', '2306', 'Fermentação',                             'Fase 1', 6),
--   ('RDN', '2308', 'Destilaria',                              'Fase 1', 6),
--   ('RDN', '2309', 'Separação de sólidos e secagem de DDGS',  'Fase 1', 6),
--   ('RDN', '2310', 'Estação de tratamento de água (ETA)',     'Fase 1', 6),
--   ('RDN', '2315', 'Recebimento de Grãos',                    'Fase 1', 6),
--   ('RDN', '2317', 'Sistema de Evaporação de Vinhaça',        'Fase 1', 6),
--   ('RDN', '2320', 'Fábrica de óleo',                         'Fase 1', 6),
--   ('RDN', '2327', 'Armazenamento e expedição de etanol',     'Fase 1', 6),
--   ('RDN', '2331', 'Biomassa',                                'Fase 1', 6),
--   ('RDN', '2401', 'Geração de vapor',                        'Fase 2', 586),
--   ('RDN', '2402', 'Cozimento',                               'Fase 2', 586),
--   ('RDN', '2406', 'Fermentação',                             'Fase 2', 586),
--   ('RDN', '2408', 'Destilaria',                              'Fase 2', 586),
--   ('RDN', '2409', 'Separação de sólidos e secagem de DDGS',  'Fase 2', 586),
--   ('RDN', '2410', 'Estação de tratamento de água (ETA)',     'Fase 2', 586),
--   ('RDN', '2414', 'Sistema de refrigeração de água (Casa de força)', 'Fase 2', 586),
--   ('RDN', '2422', 'Fábrica de óleo',                         'Fase 2', 586),
--   ('RDN', '2427', 'Armazenamento e expedição de etanol',     'Fase 2', 586),
--   ('RDN', '2431', 'Biomassa',                                'Fase 2', 586)
-- on conflict (unidade, codigo) do update
--    set nome = excluded.nome, descricao = excluded.descricao,
--        ordem = excluded.ordem, ativo = true;

/* ---- conferência ---- */
select codigo, nome, descricao as fase, ordem
  from public.lps_ei_areas
 where unidade = 'RDN' and codigo ~ '^\d{4}$'
 order by ordem;
