# @moon/sdk

Moon é um SDK autônomo para aplicações exportadas. Ele usa contratos locais e não depende de um provedor específico ou de um runtime hospedado.

O primeiro adaptador compatível é o cliente do Supabase já criado pela aplicação:

```js
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@moon/sdk';

const supabase = createSupabaseClient(url, anonKey);
const sdk = createClient(supabase);

const notes = await sdk.entities.Notes.list('-updated_at', 200);
await sdk.entities.Notes.create({ title: 'Olá' });
```

A API de entidades traduz `Notes` para a tabela `notes`. A segurança continua no banco, via RLS. Serviços exclusivos de uma plataforma hospedada devem ser implementados como adaptadores locais (por exemplo, Supabase Edge Functions), sem serem chamados diretamente pelo SDK.

## Adaptadores e dicionários

O núcleo não importa drivers de banco. O projeto fornece tradutores para:

- `createSupabaseAdapter`: cliente relacional com RLS;
- `createFirebaseAdapter`: Firestore, com coleções e documentos;
- `createSqlAdapter`: PostgreSQL, MySQL ou SQL genérico, usando um executor de backend.

Os dicionários exportados em `src/dictionaries.ts` traduzem nomes de tabelas/campos, operadores (`$eq`, `$gt`, `$in` etc.), aspas de identificadores e placeholders (`$1`, `?`, `@p1`). Novos bancos podem ser adicionados sem mudar a API das aplicações.

Exemplo SQL no backend:

```ts
const database = createSqlAdapter({
  query: (text, parameters) => pool.query(text, parameters),
}, 'postgres');
const app = createClient(database);
```

Nunca exponha `pool`, senha ou chave administrativa no frontend. O navegador deve usar um adaptador público com as regras de segurança do próprio banco.

## Interface de terminal

O SDK é único e detecta automaticamente Windows e macOS. O `install.exe` prepara o ambiente visualmente no Windows; depois da instalação, o comando `moon` é disponibilizado automaticamente pelo npm.

Depois de instalar o pacote, a configuração é totalmente local:

```bash
moon init ./meu-app
moon link ./meu-app
moon doctor ./meu-app
moon test ./meu-app
moon build
moon start ./meu-app
moon run ./meu-app
```

O comando `link` pergunta o banco, grava `moon.config.json`, as variáveis específicas em `.env.local` e testa a conexão antes de concluir. `test` repete a verificação sem reconfigurar. `start` executa a preparação e inicia o app local. A CLI não possui fluxo de conta, publicação, exportação ou conexão com uma plataforma externa.

`run` é o comando universal: detecta banco por arquivos `.env`, dependências e código do projeto; reutiliza a configuração encontrada ou chama `link` quando não houver banco. Também analisa o código para detectar chatbot/LLM e só pergunta pela API de IA quando encontra esse recurso. Depois sobe o backend local em `http://localhost:8787` junto com o frontend definido no `package.json`. A chave de IA fica em `.env.local` e o backend só informa se ela existe; nunca entrega o segredo por uma rota HTTP.

O wizard é específico para cada opção: Supabase solicita URL e chave pública e valida uma chamada autenticada; Firebase solicita o Web App config e valida o projeto; PostgreSQL, MySQL e SQL solicitam uma connection string e validam host/porta, sendo marcados como backend-only. Segredos ficam somente no `.env.local` e nunca são gravados no JSON.
