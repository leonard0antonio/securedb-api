-- =============================================================
-- init.sql - Demonstração de Segurança na Camada de Banco de Dados
-- Práticas: Check Constraints, Views e Princípio do Menor Privilégio
-- =============================================================

-- ---------------------------------------------------------------
-- 1. TABELA: Transacoes
--    Com Check Constraints para garantir integridade e segurança
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Transacoes (
    ID              SERIAL PRIMARY KEY,
    Conta_Origem    VARCHAR(20) NOT NULL,
    Conta_Destino   VARCHAR(20) NOT NULL,
    Valor           NUMERIC(15, 2) NOT NULL,
    Criado_Em       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- SEGURANÇA: Valor deve ser estritamente positivo
    CONSTRAINT chk_valor_positivo
        CHECK (Valor > 0),

    -- SEGURANÇA: Impede transferências para a própria conta
    CONSTRAINT chk_contas_diferentes
        CHECK (Conta_Origem <> Conta_Destino)
);

COMMENT ON TABLE Transacoes IS 'Registra transferências entre contas com restrições de segurança via Check Constraints.';
COMMENT ON CONSTRAINT chk_valor_positivo ON Transacoes IS 'Garante que nenhuma transação com valor zero ou negativo seja inserida.';
COMMENT ON CONSTRAINT chk_contas_diferentes ON Transacoes IS 'Impede que uma conta realize uma transferência para si mesma.';


-- ---------------------------------------------------------------
-- 2. TABELA: Funcionarios
--    Contém dados sensíveis (CPF, Salario) que serão protegidos
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS Funcionarios (
    ID           SERIAL PRIMARY KEY,
    Nome         VARCHAR(100) NOT NULL,
    Departamento VARCHAR(50)  NOT NULL,
    CPF          CHAR(11)     NOT NULL UNIQUE,
    Salario      NUMERIC(10, 2) NOT NULL
);

COMMENT ON TABLE Funcionarios IS 'Tabela com dados sensíveis. Acesso direto restrito pelo Princípio do Menor Privilégio.';
COMMENT ON COLUMN Funcionarios.CPF     IS 'Dado sensível - protegido via view pública.';
COMMENT ON COLUMN Funcionarios.Salario IS 'Dado sensível - protegido via view pública.';


-- ---------------------------------------------------------------
-- 3. DADOS FICTÍCIOS para teste
-- ---------------------------------------------------------------
INSERT INTO Funcionarios (Nome, Departamento, CPF, Salario) VALUES
    ('Ana Beatriz Costa',    'Tecnologia',   '12345678901', 9800.00),
    ('Carlos Eduardo Lima',  'Financeiro',   '98765432100', 12500.00),
    ('Fernanda Oliveira',    'Atendimento',  '11122233344', 4200.00),
    ('Rafael Santos',        'Tecnologia',   '55566677788', 8700.00),
    ('Juliana Mendes',       'RH',           '99988877766', 6300.00),
    ('Bruno Almeida',        'Financeiro',   '33344455566', 11000.00),
    ('Larissa Ferreira',     'Atendimento',  '77788899900', 4500.00),
    ('Thiago Rocha',         'Operações',    '44455566677', 7200.00);


-- ---------------------------------------------------------------
-- 4. VIEW: vw_funcionarios_publico
--    Expõe APENAS Nome e Departamento — oculta CPF e Salario
-- ---------------------------------------------------------------
CREATE OR REPLACE VIEW vw_funcionarios_publico AS
    SELECT
        ID,
        Nome,
        Departamento
    FROM Funcionarios;

COMMENT ON VIEW vw_funcionarios_publico IS
    'View pública que expõe apenas Nome e Departamento. CPF e Salário estão ocultados para proteger dados sensíveis.';


-- ---------------------------------------------------------------
-- 5. USUÁRIO/ROLE: atendimento
--    Princípio do Menor Privilégio — acesso mínimo necessário
-- ---------------------------------------------------------------

-- Cria o role/usuário com senha (sem permissões por padrão)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atendimento') THEN
        CREATE ROLE atendimento WITH LOGIN PASSWORD 'Atend@2024!';
    END IF;
END
$$;

COMMENT ON ROLE atendimento IS 'Usuário de baixo privilégio para operações de atendimento ao cliente.';

-- ---------------------------------------------------------------
-- 6. CONCESSÃO DE PRIVILÉGIOS (DCL - Data Control Language)
--    Aplicação rigorosa do Princípio do Menor Privilégio
-- ---------------------------------------------------------------

-- IMPORTANTE: Revoga qualquer permissão padrão do PUBLIC no schema
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO atendimento;

-- Concede SELECT SOMENTE na view pública (nunca na tabela original)
GRANT SELECT ON vw_funcionarios_publico TO atendimento;

-- Garante que NÃO há acesso à tabela Funcionarios
-- (explícito para clareza — o REVOKE acima já cobre)
REVOKE ALL ON Funcionarios FROM atendimento;
REVOKE ALL ON Transacoes FROM atendimento;
