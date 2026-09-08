import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export function extractReference(directory) {
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@base44/sdk') throw new Error('A referência deve ser o SDK oficial @base44/sdk.');
  const selected = new Set(['Base44Client', 'AuthModule', 'InternalAuthModule', 'EntityHandler', 'FunctionsModule', 'AgentsModule', 'CoreIntegrations', 'CustomIntegrationsModule', 'ConnectorsModule', 'UserConnectorsModule', 'AiGatewayModule', 'AppModule', 'AppLogsModule', 'AnalyticsModule', 'ActorsModule', 'ActorRef', 'ActorClient', 'Connection', 'SsoModule']);
  const files = [resolve(directory, 'src/client.types.ts'), ...readdirSync(resolve(directory, 'src/modules')).filter(name => name.endsWith('.types.ts')).map(name => resolve(directory, 'src/modules', name))];
  const interfaces = {}, hashes = {};
  for (const file of files) {
    const text = readFileSync(file, 'utf8'), parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const node of parsed.statements) {
      if (!(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) || !selected.has(node.name.text)) continue;
      const members = node.members || (ts.isTypeLiteralNode(node.type) ? node.type.members : []);
      interfaces[node.name.text] = {
        file: relative(directory, file).replaceAll('\\', '/'),
        extends: node.heritageClauses?.flatMap(clause => clause.types.map(type => type.expression.getText(parsed))) || [],
        members: members.filter(member => member.name).map(member => ({ name: member.name.getText(parsed).replace(/^['"]|['"]$/g, ''), kind: ts.isMethodSignature(member) || member.type && ts.isFunctionTypeNode(member.type) ? 'method' : 'property', signature: member.getText(parsed).replace(/\s+/g, ' ') })),
      };
      hashes[relative(directory, file).replaceAll('\\', '/')] = createHash('sha256').update(text).digest('hex');
    }
  }
  for (const name of selected) if (!interfaces[name]) throw new Error('Contrato oficial ausente: ' + name);
  const indexText = readFileSync(resolve(directory, 'src/index.ts'), 'utf8');
  const index = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true);
  const exports = index.statements.filter(node => ts.isExportDeclaration(node) && !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause))
    .flatMap(node => node.exportClause.elements.filter(item => !item.isTypeOnly).map(item => item.name.text));
  hashes['src/index.ts'] = createHash('sha256').update(indexText).digest('hex');
  return { package: pkg.name, version: pkg.version, source: 'https://github.com/base44/javascript-sdk', hashes, exports, interfaces };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , directory, output = 'bin/base44-reference.json'] = process.argv;
  if (!directory) throw new Error('Uso: node bin/reference-contract.mjs <pasta-sdk-oficial> [arquivo.json]');
  const contract = extractReference(resolve(directory));
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(contract, null, 2) + '\n');
  console.log(`Referência ${contract.version}: ${Object.keys(contract.interfaces).length} interfaces.`);
}
