-- Schema do iTS Gerencial CASAN
-- Tabelas com prefixo casan_ para isolamento.

CREATE TABLE IF NOT EXISTS casan_usuarios (
  id            SERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  senha_hash    TEXT NOT NULL,
  perfil        TEXT NOT NULL DEFAULT 'Cliente',
  ativo         BOOLEAN NOT NULL DEFAULT true,
  totp_secret   TEXT,
  totp_enabled  BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Colunas adicionadas em bases ja existentes (idempotente)
ALTER TABLE casan_usuarios ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE casan_usuarios ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- Sessoes (tokens de acesso a API)
CREATE TABLE IF NOT EXISTS casan_sessions (
  token       TEXT PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES casan_usuarios(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON casan_sessions (expires_at);

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
