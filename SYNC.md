# Base44 ↔ GitHub ↔ Moon local

Este fluxo é por aplicativo e não depende da conta, pasta ou banco do desenvolvedor
do Moon. Não usa `eject`, não cria cópia na conta Base44 e não sincroniza registros
entre os bancos. O Base44 continua usando seu próprio backend na prévia hospedada;
a cópia de execução Moon usa o banco configurado localmente.

## Primeira configuração

1. O proprietário conecta o aplicativo ao GitHub pelo painel Base44 usando a
   integração **bidirecional** (Builder ou superior). A branch precisa ser `main`.
2. Com Git instalado e autenticado no seu computador, clone esse repositório completo e entre na raiz do aplicativo. O Moon não cria
   nem conecta contas/repositórios no Base44 automaticamente.
3. Prepare o banco e o contrato:

```sh
moon db .
moon sync init
git status
git add .gitignore moon/schema.json moon.contract.json moon/AI-INSTRUCTIONS.md
git commit -m "Configure Moon integration contract"
moon sync push
moon run
```

No Base44, adicione às instruções da IA: **“Leia `moon.contract.json` e
`moon/AI-INSTRUCTIONS.md` antes de editar. Preserve a integração. Proponha mudanças
de estrutura em `moon/schema.proposed.json`, sem alterar o schema aceito.”**
O JSON não é um mecanismo de execução automática da IA e não garante obediência.

O cliente original Base44 deve estar presente no código compartilhado. Aplicativos
convertidos por versões antigas do Moon precisam recuperar o cliente, Vite e
dependências originais a partir de um backup ou clone antes de iniciar este fluxo.
Não envie dependências `file:` apontando para o SDK instalado no seu computador.

## Dia a dia

```sh
moon sync status
moon sync pull
moon run
# Edite os arquivos originais, revise e faça commit pelo Git/VS Code.
moon sync push
```

Push não faz commit automaticamente, não usa force e não publica o aplicativo
Base44 para os usuários. Pull só aceita avanço direto de commits (fast-forward).
Alterações locais sem commit ou históricos divergentes interrompem a operação:
resolva pelo Git/VS Code antes de repetir. Não há stash nem resolução automática
que escolha uma versão e descarte a outra.

`moon run` instala/adapta uma cópia em `.moon/runtime-*`; não substitui o cliente,
Vite ou dependências do código compartilhado. Edite os arquivos originais e
reinicie `moon run` para atualizar a cópia: esta primeira versão não espelha
edições ao vivo. As cópias geradas permanecem locais e não devem ser editadas.
Os comandos antigos `dev`/`start` não implementam esta cópia: use `moon run`.

## Alterações de banco

```sh
moon db diff
moon db migrate
# Após revisão e backup:
moon db migrate --apply
```

A IA/desenvolvedor propõe o schema completo em `moon/schema.proposed.json`; o
usuário final não preenche campos/tabelas. Diff não conecta ao banco. Migrate sem
`--apply` apenas mostra o plano. A aplicação exige que o plano salvo pela revisão
ainda corresponda exatamente à proposta atual. A aplicação automática suporta novas tabelas e
colunas opcionais em PostgreSQL, Supabase e MySQL. Remoções, renomeações, mudanças
de tipos/acesso, novos campos obrigatórios ou FKs em tabelas existentes exigem
revisão técnica/backfill e são bloqueados. Firestore requer revisão e publicação
explícita das regras; `db migrate` não o implementa ainda.

Depois de aplicar, o schema aceito e contrato são atualizados para um novo commit.
Outros computadores com o contrato anterior bloquearão essa mudança até revisão
e migração local: não há coordenação automática entre vários bancos de pessoas
diferentes. Git não carrega credenciais nem aplica migrações nos outros ambientes.

PostgreSQL reverte a migração em caso de falha dentro da transação. MySQL confirma
DDL implicitamente: falha parcial exige revisão, nunca uma tentativa de apagar e
recriar tabelas. Não há rollback automático de uma migração já confirmada.
`moon/database-report.json` registra os schemas anterior/aplicado para diagnóstico.
Falhas de disco após confirmar o banco podem exigir recuperação desse registro;
não existe transação distribuída entre Git, arquivos e banco.

## Proteções e limites

- Configuração/conexão e credenciais ficam em arquivos ignorados pelo Git.
- O contrato público contém o schema, provedor e instruções, nunca as credenciais.
- O vínculo local fica nos metadados Git e não é enviado ao repositório.
- Arquivos protegidos são verificados contra uma referência local, não contra o
  contrato recebido da IA. O remoto não pode simplesmente redefinir a proteção.
- Pull inspeciona os commits antes de atualizar os arquivos; push inspeciona os
  commits a enviar. Arquivos sensíveis e padrões conhecidos de credenciais são
  bloqueados inclusive se removidos no último commit. Isto não é um detector
  universal de segredos: revise seus commits e ative secret scanning no GitHub.
- A proteção não impede um push direto do Base44/Git/VS Code. Ela atua nos comandos
  Moon; não instala regras de branch, hooks ou interceptadores na plataforma.
- Preservar os arquivos protegidos não prova compatibilidade semântica de todo
  código novo. Novas consultas, autenticação, funções e UI precisam de testes do app.
- No clone de outro computador, configure seu banco e execute `moon sync init`:
  contratos existentes compatíveis são vinculados sem sobrescrevê-los.
- Se você reconfigurar a conexão local ao mesmo provedor, revise a mudança e use
  `moon sync init --refresh-local`. Isso não aprova alterações de schema/cliente.
- `moon run` também confere o contrato vinculado, inclusive após um pull feito
  diretamente pelo Git. Isso não substitui os testes de funcionalidade do app.

Referência oficial consultada: [Integração GitHub Base44](https://docs.base44.com/developers/app-code/local-development/github).
