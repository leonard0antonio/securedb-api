// =============================================================
// server.js - API REST com Segurança na Camada de Banco de Dados
// Demonstra: Check Constraints, Views e Princípio do Menor Privilégio
// =============================================================

'use strict';

const express = require('express');
const { Pool }  = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------------------------------------------------------------
// POOLS DE CONEXÃO — Duas identidades distintas no banco
// ---------------------------------------------------------------

/**
 * Pool ADMIN
 * Usuário com privilégios completos. Usado para operações
 * administrativas, como inserir transações.
 */
const poolAdmin = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'securedb',
  user:     process.env.DB_USER     || 'admin',
  password: process.env.DB_PASSWORD || 'Admin@2024!',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * Pool ATENDIMENTO
 * Usuário de baixíssimo privilégio. Possui APENAS SELECT
 * na view vw_funcionarios_publico — nada mais.
 * Qualquer tentativa de acessar outra tabela será bloqueada
 * diretamente pelo PostgreSQL.
 */
const poolAtendimento = new Pool({
  host:     process.env.DB_HOST              || 'localhost',
  port:     Number(process.env.DB_PORT)      || 5432,
  database: process.env.DB_NAME             || 'securedb',
  user:     process.env.DB_ATEND_USER       || 'atendimento',
  password: process.env.DB_ATEND_PASSWORD   || 'Atend@2024!',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Eventos de erro nas pools (evita crashes por conexão perdida)
poolAdmin.on('error',      (err) => console.error('[Pool Admin] Erro inesperado:', err.message));
poolAtendimento.on('error',(err) => console.error('[Pool Atendimento] Erro inesperado:', err.message));


// ---------------------------------------------------------------
// MAPEAMENTO DE ERROS DO POSTGRESQL → RESPOSTAS HTTP AMIGÁVEIS
// ---------------------------------------------------------------

/**
 * Traduz erros nativos do PostgreSQL em mensagens legíveis.
 * Os códigos de erro seguem o padrão oficial:
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 *
 * @param {Error} err - Erro lançado pela biblioteca `pg`
 * @returns {{ status: number, message: string }}
 */
function traduzirErroPg(err) {
  // 23514 = check_violation (Check Constraint violada)
  if (err.code === '23514') {
    switch (err.constraint) {
      case 'chk_valor_positivo':
        return {
          status: 400,
          message: 'O valor da transação deve ser maior que zero. Valores negativos ou zerados não são permitidos.',
        };
      case 'chk_contas_diferentes':
        return {
          status: 400,
          message: 'A conta de origem e a conta de destino não podem ser iguais. Transferências para a própria conta são bloqueadas.',
        };
      default:
        return {
          status: 400,
          message: `Violação de regra de negócio no banco de dados (constraint: ${err.constraint}).`,
        };
    }
  }

  // 23502 = not_null_violation
  if (err.code === '23502') {
    return {
      status: 400,
      message: `O campo "${err.column}" é obrigatório e não pode ser nulo.`,
    };
  }

  // 23505 = unique_violation
  if (err.code === '23505') {
    return {
      status: 409,
      message: 'Registro duplicado. Um dos valores já existe na base de dados.',
    };
  }

  // 42501 = insufficient_privilege (Princípio do Menor Privilégio em ação)
  if (err.code === '42501') {
    return {
      status: 403,
      message: 'Acesso negado pelo banco de dados. O usuário não possui privilégios para executar esta operação.',
    };
  }

  // Erro genérico (não expõe detalhes internos ao cliente)
  return {
    status: 500,
    message: 'Erro interno no servidor. Contate o administrador.',
  };
}


// ---------------------------------------------------------------
// ROTA 1 — POST /transacoes
// Usa a pool ADMIN para inserir uma transação.
// Demonstra a captura das Check Constraints do PostgreSQL.
// ---------------------------------------------------------------

/**
 * @route   POST /transacoes
 * @access  Admin Pool
 * @body    { conta_origem: string, conta_destino: string, valor: number }
 *
 * Possíveis erros tratados:
 *  - valor <= 0          → 400 (chk_valor_positivo violada)
 *  - conta_origem === conta_destino → 400 (chk_contas_diferentes violada)
 *  - campos faltando     → 400 (validação prévia)
 */
app.post('/transacoes', async (req, res) => {
  const { conta_origem, conta_destino, valor } = req.body;

  // --- Validação superficial (antes de chegar ao banco) ---
  if (!conta_origem || !conta_destino || valor === undefined) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Campos obrigatórios ausentes: conta_origem, conta_destino e valor.',
    });
  }

  const sql = `
    INSERT INTO Transacoes (Conta_Origem, Conta_Destino, Valor)
    VALUES ($1, $2, $3)
    RETURNING ID, Conta_Origem, Conta_Destino, Valor, Criado_Em
  `;

  try {
    const result = await poolAdmin.query(sql, [conta_origem, conta_destino, valor]);
    const transacao = result.rows[0];

    console.log(`[POST /transacoes] ✅ Transação #${transacao.id} inserida com sucesso.`);

    return res.status(201).json({
      sucesso: true,
      mensagem: 'Transação registrada com sucesso.',
      dados: {
        id:            transacao.id,
        conta_origem:  transacao.conta_origem,
        conta_destino: transacao.conta_destino,
        valor:         parseFloat(transacao.valor),
        criado_em:     transacao.criado_em,
      },
    });

  } catch (err) {
    // O PostgreSQL rejeita a inserção — traduzimos o erro para o cliente
    const { status, message } = traduzirErroPg(err);

    console.warn(
      `[POST /transacoes] ⚠️  Inserção rejeitada pelo banco.`,
      `| Código PG: ${err.code}`,
      `| Constraint: ${err.constraint || 'N/A'}`,
      `| HTTP: ${status}`,
    );

    return res.status(status).json({
      sucesso: false,
      mensagem: message,
      detalhe_tecnico: {
        pg_code:    err.code,
        constraint: err.constraint || null,
      },
    });
  }
});


// ---------------------------------------------------------------
// ROTA 2A — GET /atendimento/funcionarios  ✅ PERMITIDO
// Usa a pool ATENDIMENTO para consultar APENAS a view pública.
// O PostgreSQL autoriza pois o usuário tem SELECT na view.
// ---------------------------------------------------------------

/**
 * @route   GET /atendimento/funcionarios
 * @access  Atendimento Pool (menor privilégio)
 *
 * Retorna somente ID, Nome e Departamento — CPF e Salário
 * são automaticamente omitidos pela definição da view.
 */
app.get('/atendimento/funcionarios', async (req, res) => {
  const sql = 'SELECT ID, Nome, Departamento FROM vw_funcionarios_publico ORDER BY Nome';

  try {
    const result = await poolAtendimento.query(sql);

    console.log(`[GET /atendimento/funcionarios] ✅ ${result.rowCount} funcionário(s) retornado(s) via view pública.`);

    return res.status(200).json({
      sucesso: true,
      fonte:   'vw_funcionarios_publico (view — dados sensíveis ocultados)',
      total:   result.rowCount,
      dados:   result.rows,
    });

  } catch (err) {
    const { status, message } = traduzirErroPg(err);
    console.error('[GET /atendimento/funcionarios] ❌ Erro:', err.message);
    return res.status(status).json({ sucesso: false, mensagem: message });
  }
});


// ---------------------------------------------------------------
// ROTA 2B — GET /atendimento/falha  ❌ PROPOSITALMENTE FALHO
// Usa a pool ATENDIMENTO tentando acessar a TABELA ORIGINAL.
// O PostgreSQL BLOQUEIA — o usuário não tem privilégio algum
// sobre a tabela Funcionarios. Isso prova o menor privilégio.
// ---------------------------------------------------------------

/**
 * @route   GET /atendimento/falha
 * @access  Atendimento Pool (menor privilégio) — ACESSO NEGADO PELO BANCO
 *
 * Este endpoint existe para DEMONSTRAR que o banco de dados
 * aplica o bloqueio mesmo que o código tente burlar a view.
 * O erro 42501 (insufficient_privilege) será retornado pelo PG.
 */
app.get('/atendimento/falha', async (req, res) => {
  // ⚠️  ATENÇÃO: Esta query tenta acessar diretamente a tabela
  //    protegida com o usuário 'atendimento'. O PostgreSQL irá
  //    rejeitar com: ERROR 42501 - insufficient_privilege
  const sqlProibido = 'SELECT * FROM Funcionarios';

  console.warn('[GET /atendimento/falha] ⚠️  Tentando acessar tabela protegida com usuário de baixo privilégio...');

  try {
    await poolAtendimento.query(sqlProibido);

    // Se chegarmos aqui, houve uma falha de configuração de segurança!
    console.error('[GET /atendimento/falha] 🚨 FALHA DE SEGURANÇA: O banco deveria ter bloqueado este acesso!');
    return res.status(200).json({
      sucesso: true,
      aviso:   '🚨 FALHA DE SEGURANÇA! O usuário atendimento conseguiu ler a tabela Funcionarios. Revise as permissões.',
    });

  } catch (err) {
    // ✅ COMPORTAMENTO ESPERADO: O banco bloqueou o acesso
    const { status, message } = traduzirErroPg(err);

    console.log(
      `[GET /atendimento/falha] ✅ Banco bloqueou corretamente.`,
      `| Código PG: ${err.code} (insufficient_privilege)`,
    );

    return res.status(status === 500 ? 403 : status).json({
      sucesso:     false,
      mensagem:    message,
      demonstracao: {
        descricao:    'Este endpoint prova que o Princípio do Menor Privilégio está funcionando.',
        usuario_db:   'atendimento',
        acao_tentada: 'SELECT * FROM Funcionarios (tabela protegida)',
        resultado:    'Bloqueado pelo PostgreSQL antes de qualquer dado ser lido.',
        pg_code:      err.code,
        pg_message:   err.message,
      },
    });
  }
});


// ---------------------------------------------------------------
// ROTA RAIZ — GET /  (documentação inline)
// ---------------------------------------------------------------
app.get('/', (_req, res) => {
  res.status(200).json({
    api:     'SecureDB API',
    versao:  '1.0.0',
    descricao: 'Demonstração de práticas de segurança na camada de banco de dados PostgreSQL.',
    rotas: [
      {
        metodo:   'POST',
        caminho:  '/transacoes',
        descricao: 'Insere uma transação. Testa Check Constraints (valor > 0, contas diferentes).',
        body_exemplo: { conta_origem: '0001-1', conta_destino: '0002-2', valor: 150.00 },
      },
      {
        metodo:   'GET',
        caminho:  '/atendimento/funcionarios',
        descricao: 'Lista funcionários via VIEW pública (CPF e Salário ocultados). Usa pool do usuário atendimento.',
      },
      {
        metodo:   'GET',
        caminho:  '/atendimento/falha',
        descricao: 'Endpoint propositalmente falho: tenta acessar a tabela Funcionarios com o usuário atendimento. O banco bloqueia (403).',
      },
    ],
  });
});


// ---------------------------------------------------------------
// INICIALIZAÇÃO DO SERVIDOR
// ---------------------------------------------------------------
async function iniciar() {
  try {
    // Verifica conectividade das duas pools antes de subir o servidor
    console.log('🔌 Verificando conexão com o banco de dados...');

    const clientAdmin = await poolAdmin.connect();
    console.log('  ✅ Pool Admin conectada com sucesso.');
    clientAdmin.release();

    const clientAtend = await poolAtendimento.connect();
    console.log('  ✅ Pool Atendimento conectada com sucesso.');
    clientAtend.release();

    app.listen(PORT, () => {
      console.log('');
      console.log('🚀 SecureDB API rodando!');
      console.log(`   Endereço : http://localhost:${PORT}`);
      console.log(`   Endpoints:`);
      console.log(`     POST  http://localhost:${PORT}/transacoes`);
      console.log(`     GET   http://localhost:${PORT}/atendimento/funcionarios`);
      console.log(`     GET   http://localhost:${PORT}/atendimento/falha  ← deve retornar 403`);
      console.log('');
    });

  } catch (err) {
    console.error('❌ Falha ao conectar ao banco de dados:', err.message);
    console.error('   Certifique-se de que o container PostgreSQL está rodando: docker-compose up -d');
    process.exit(1);
  }
}

iniciar();
