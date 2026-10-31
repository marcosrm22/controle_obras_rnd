-- ================================================================
-- PCO DIGITAL · PRÉ-PROGRAMAÇÃO — coluna obs (prog_terc) — Fase 3.30
-- Importação do CSV semanal de pisos (tela Cronogramas -> Pré-Programação)
-- Idempotente. Rodar ANTES de publicar os HTMLs.
-- ================================================================

-- Prioridade, data prevista, concretagem, status do kanban, ID e restrições
-- do CSV de pisos ficam aqui; ao "Validar todos" são copiados para
-- prog_terc_programacao.obs (que já existe).
alter table prog_terc_pre_programacao add column if not exists obs text;

-- Conferência de duplicidade na importação: mesma semana + mesmo código
-- (terceira_wbs) em registros sem cronograma.
create index if not exists idx_ptpp_sem_wbs on prog_terc_pre_programacao(unidade, semana, terceira_wbs);

-- Faz o PostgREST enxergar a coluna nova sem esperar o cache expirar
notify pgrst, 'reload schema';
