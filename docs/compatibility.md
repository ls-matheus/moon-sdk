# Compatibilidade Base44

O alvo desta revisão é o SDK oficial **@base44/sdk 0.8.48**, fornecido como referência.
O Moon **não certifica compatibilidade com qualquer aplicativo Base44**. Uma interface
JavaScript não contém a implementação dos serviços hospedados, registros, contas,
regras de acesso, integrações OAuth ou funções externas de cada aplicativo.

## Referência verificável

`bin/base44-reference.json` registra exports, assinaturas de 19 interfaces e hashes
dos arquivos originais. `bin/compatibility-catalog.mjs` classifica os métodos por
implementação local, dependência de configuração ou necessidade de adaptador.
A classificação descreve a disponibilidade da interface, não equivalência completa
de comportamento, desempenho ou autorização em todos os provedores.

Para atualizar a referência sem executar o SDK oficial:

```sh
node bin/reference-contract.mjs /caminho/javascript-sdk
```

Os contratos extraídos seguem a licença em `bin/BASE44-REFERENCE-LICENSE.txt`.

## Execução automática

| Área | Implementação e limites |
| --- | --- |
| Apps Vite | Cópia local preserva arquivos do app, plugins, CSS, build e aliases; redireciona imports de `@base44/sdk`, inclusive fora de `base44Client`. Configurações objeto, função e função assíncrona são aceitas. Outros frameworks precisam de adaptador de build. |
| Dependências Base44 | SDK e plugin Base44 são removidos do package.json da cópia. O cliente local não chama esses serviços. Chamadas HTTP explícitas no código do próprio app precisam de revisão. |
| Entidades | `list`, `filter`, `get`, `create`, `update`, `delete`, `bulkCreate`, `bulkUpdate`. Filtros avançados MongoDB, `deleteMany`, `updateMany`, `importEntities` e `subscribe` exigem implementação adicional. `bulkUpdate` pode concluir parcialmente. |
| Supabase | Cliente direto tem envelopes de auth normalizados; perfil usa user metadata; `role` vem de app metadata, não do perfil editável. RLS continua sendo obrigatória. |
| Firestore | Leitura pública não exige sessão no adaptador. O Web SDK aceita skip lendo e descartando os documentos anteriores, com custo proporcional ao offset. Escritas públicas continuam bloqueadas pelas regras do Moon. |
| Autenticação | Login, cadastro, perfil, logout e verificação de sessão pelo provedor. OAuth/OTP dependem das capacidades dele. Tokens, contas, convites, recuperação por token e SSO Base44 não são automaticamente transferidos. `auth.me()` do cliente compatível rejeita com 401 quando não há usuário. |
| Configuração pública | `app.getPublicSettings()` retorna ID e política local. `authUi.mode: "public"` permite abrir o frontend sem o bootstrap de login; não concede acesso ao banco. |
| Funções | `functions/name.ts`, `base44/functions/name.ts` e `base44/functions/name/entry.ts`, com `export default` ou `Deno.serve(handler)`. Ambiguidade é recusada. Imports relativos estáticos funcionam; pacotes externos, imports calculados, APIs Deno e Node precisam de adaptação. |
| HTTP | `functions.invoke` aceita JSON e multipart; `functions.fetch` preserva método, query string, headers, corpo binário e status. Respostas são **bufferizadas**, não streaming. Limites: 1 MB e 90 segundos. `fetchWithAuth` só envia sessão a rotas da própria origem; não implementa essas rotas por si só. |
| IA | `integrations.Core.InvokeLLM` aceita prompt e JSON Schema. Backend usa a chave configurada, valida sessão e valida o JSON retornado. Arquivos, busca na internet, agentes persistentes e AI Gateway exigem adaptadores. |
| Atividade | `appLogs.logUserInApp` guarda até 1.000 visitas no armazenamento deste navegador. Não gera estatísticas globais. Analytics está desativado por padrão no runtime; ativá-lo exige adaptador. |
| Outros serviços | Upload persistente, e-mail, geração de imagem, extração de documentos, conectores, SSO, actors e integrações customizadas exigem serviços próprios. Não recebem respostas de sucesso fictícias. |
| Privilégios | `asServiceRole` só existe no executor backend; usa as permissões explícitas configuradas por função e mantém isolamento de entidades owner. Não reproduz bypass irrestrito do Base44. |

Funções puramente computacionais não exigem conexão com um banco. Continuam
autenticadas por padrão; funções públicas precisam de `localFunctions.<nome>.access`
igual a `public`. IA pública também exige `allowAI: true` na função.

## Adaptadores do aplicativo

`src/moon.adapters.js` ou `.ts` pode exportar implementações para `auth`, `entities`,
`integrations`, `functions`, `agents`, `connectors`, `app`, `appLogs`, `analytics`,
`aiGateway` e `actors`. Essas implementações pertencem ao aplicativo; são carregadas
no frontend e não podem conter credenciais administrativas. Por exemplo, conectar
UploadFile a uma função de upload já implementada no próprio backend:

```js
import { createClient } from '@base44/sdk';

export default {
  integrations: {
    Core: {
      async UploadFile({ file }) {
        const form = new FormData();
        form.append('file', file);
        const response = await createClient({}).functions.fetch('upload', {
          method: 'POST', body: form,
        });
        if (!response.ok) throw new Error('Upload recusado');
        return response.json(); // O backend deve retornar { file_url: "..." }.
      },
    },
  },
};
```

Isso não cria armazenamento nem permissões: a função `upload` deve implementá-los.
Recursos sem implementação lançam `MoonCompatibilityError` com código
`MOON_UNSUPPORTED`, status 501 e o caminho da funcionalidade.

## Verificação por aplicativo

```sh
moon inspect ./meu-app
moon inspect ./meu-app --json
moon run ./meu-app
```

A inspeção resolve imports, aliases e métodos desestruturados sem executar o app.
Aponta recursos sem adaptação, alguns filtros incompatíveis, imports internos e
referências hospedadas. Código gerado dinamicamente e efeitos de plugins podem
escapar da análise. A existência de `moon.adapters` indica revisão manual, não
certificação. O JSON sempre mantém `verdict: "not_verified"`.

Para aprovar um app é necessário testar suas telas e fluxos com o banco, login,
permissões e serviços escolhidos. O build e os testes do SDK não substituem isso.
Produção precisa de hospedagem para o frontend e o backend `/api`; apenas publicar
arquivos estáticos não oferece banco, autenticação e funções.

## Validação desta implementação

Os testes incluem build real de um app Vite sem carregar módulos Base44, preservação
de configuração/plugins, CRUD, sessão/perfil Supabase com doubles, consultas Firestore
com doubles, diagnóstico por AST e requisições HTTP locais de funções/IA (upstream
simulado, sem cobrança). A suíte também inclui testes com PostgreSQL, MySQL e Firestore
emulado, executados somente quando esses serviços estão configurados.
