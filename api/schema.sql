-- Schema do iTS Gerencial CASAN
-- Tabelas com prefixo casan_ para isolamento.

CREATE TABLE IF NOT EXISTS casan_usuarios (
  id          SERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  senha_hash  TEXT NOT NULL,
  perfil      TEXT NOT NULL DEFAULT 'Cliente',
  ativo       BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registros de ponto, agrupados por mês (MM/YYYY)
CREATE TABLE IF NOT EXISTS casan_ponto (
  mes_key     TEXT PRIMARY KEY,
  registros   JSONB NOT NULL DEFAULT '[]'::jsonb,
  sups        JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS casan_tarefas (
  id          SERIAL PRIMARY KEY,
  dados       JSONB NOT NULL,
  status      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS casan_chamados (
  id          SERIAL PRIMARY KEY,
  dados       JSONB NOT NULL,
  status      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Armazenamento chave/valor para configurações (SMTP, flags, etc.)
CREATE TABLE IF NOT EXISTS casan_config (
  chave       TEXT PRIMARY KEY,
  valor       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tarefas_status  ON casan_tarefas (status);
CREATE INDEX IF NOT EXISTS idx_chamados_status ON casan_chamados (status);
