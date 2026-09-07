# Assistente de banco de dados

Na pasta do aplicativo, execute:

```sh
moon db .
moon run .
```

O assistente pergunta provedor, entidades/campos, acesso, autenticação e credenciais.
Se existir `moon/schema.json`, reutiliza o esquema; também importa campos de
`base44/entities/*.json` e JSONC. Sem esses arquivos, encontra nomes de entidades
no código e pede os tipos: não tenta adivinhar estruturas a partir de regex.
`moon db . --plan` gera o plano sem acessar um banco.

O esquema comum usa string, integer, number, boolean, json, datetime e uuid.
id, created_at e updated_at são automáticos. Entidades owner incluem user_id;
private significa acesso apenas pelo backend. Exemplo:

```json
{
  "version": 1,
  "entities": {
    "Note": {
      "access": "owner",
      "fields": {
        "title": { "type": "string", "required": true },
        "done": { "type": "boolean" },
        "metadata": { "type": "json" }
      }
    }
  }
}
```

## Suporte e requisitos

- PostgreSQL: servidor existente e usuário com CREATE DATABASE (se o banco ainda
  não existir), CREATE TABLE e permissões de consulta/gravação.
- MySQL 8: mesmas permissões; usa mysql2 diretamente, sem instalar o cliente mysql.
- Supabase: projeto existente, conexão PostgreSQL administrativa, URL e chave
  pública. Gera RLS por proprietário. Não cria conta/organização/projeto pago.
- Firebase: projeto Google/Firebase existente, Firestore Native (default),
  conta de serviço com permissões Datastore e Firebase Rules, região para criação.
  Publica regras somente após autorização explícita para substituir as existentes.
  A conta de serviço não é copiada para o aplicativo.
- SQL genérico: solicita PostgreSQL ou MySQL. SQL Server, Oracle, SQLite, MongoDB
  e demais motores não são implementados por um rótulo genérico.

PostgreSQL/MySQL usam Supabase Auth ou Firebase Auth para autenticar usuários.
O navegador acessa /api/database no backend Moon em loopback; senhas SQL ficam
somente no .env.local. O backend verifica o token e aplica o filtro de proprietário
mesmo se o navegador enviar outro user_id. Configure os provedores de login e
domínios permitidos na conta de autenticação escolhida.

## Consistência e limites

O provisionamento registra o hash do schema e verifica colunas, tipos e
nulabilidade. Em PostgreSQL, falhas revertem a transação; MySQL confirma DDL
implicitamente e pode exigir revisão após uma falha parcial. Tabelas existentes
sem registro Moon e alterações de schema são bloqueadas para evitar perda de
dados: migração e backfill precisam de revisão, não são executados silenciosamente.

Há validação de leitura/gravação administrativa em uma tabela/documento de teste.
Isso não certifica OAuth, e-mail, regras personalizadas ou todas as consultas do
aplicativo. O relatório moon/database-report.json distingue essas verificações.
Firestore não suporta foreign keys SQL; schemas com references são recusados
nesse provedor. Índices compostos dependem das consultas e precisam ser definidos
quando o Firestore solicitar. O backend local não substitui um backend de produção.

Os testes de CI usam PostgreSQL 16, MySQL 8 e Firestore Emulator com regras de
proprietário. APIs administrativas cloud dependem de credenciais e IAM reais;
o teste do emulador não certifica criação de projetos ou permissões cloud.

Para consumir o SDK diretamente:

```js
import { createClient, createSqlAdapter } from "@moon/sdk";
const moon = createClient(createSqlAdapter(executor, "mysql", schema));
```

O executor deve oferecer query e transaction; use uma conexão exclusiva por
transação. O schema permite normalizar booleanos, JSON e datas na resposta.
