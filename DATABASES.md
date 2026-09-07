# Assistente de banco de dados

Na pasta do aplicativo, execute:

```sh
moon db .
moon run .
```

O usuário não precisa criar tabelas nem informar campos, tipos ou relacionamentos.
O assistente pergunta o serviço, os dados de acesso e confirma alterações no servidor.
Se existir `moon/schema.json`, reutiliza o esquema; também importa campos de
`base44/entities/*.json` e JSONC. Sem esses arquivos, analisa estaticamente JavaScript/
TypeScript e as gravações `entities.Nome.create`, `update` e `bulkCreate` com listas
literais. Resolve tipos, variáveis, interfaces e spreads usando o compilador TypeScript,
sem executar o código do aplicativo. Dependências de tipos precisam estar disponíveis.
Campos inferidos são opcionais; números usam ponto flutuante para não truncar valores.
Objetos e listas usam JSON. Regras obrigatórias explícitas são preservadas na importação.
Tipos dinâmicos, conflitos e entidades apenas lidas sem definição interrompem a operação
antes de conectar ao banco, com arquivo/linha para revisão técnica. Não solicita que o
usuário leigo desenhe um esquema. Outras APIs/linguagens ainda precisam de um importador.
O padrão automático é acesso por proprietário autenticado; definições Base44 com regras
de acesso personalizadas ficam privadas, pois essas regras não podem ser traduzidas
com segurança por suposição. Isso pode exigir adaptação técnica de apps compartilhados.
Relacionamentos são preservados quando declarados no esquema Moon; não são inventados
a partir de nomes como `cliente_id`. O arquivo gerado pode ser inspecionado por um técnico,
mas não precisa ser preenchido pelo usuário.
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
`moon db diff` compara `moon/schema.proposed.json` com o schema aceito;
`moon db migrate --apply` aplica apenas migrações aditivas suportadas após revisão.
Consulte [SYNC.md](SYNC.md) para limites por provedor e proteção do contrato.

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
