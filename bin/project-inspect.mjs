import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { compileFunction } from './function-compiler.mjs';

// Read-only preflight. Static checks identify known limitations, not universal compatibility.
export function inspectProject(directory) {
  const errors = [], warnings = [], functions = [];
  function walk(folder, visit) {
    if (!existsSync(folder)) return;
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (item.isSymbolicLink() || ['node_modules', '.git', '.moon', 'dist'].includes(item.name)) continue;
      const file = resolve(folder, item.name);
      if (item.isDirectory()) walk(file, visit);
      else if (/\.[cm]?[jt]sx?$/.test(item.name)) visit(file);
    }
  }
  walk(resolve(directory, 'base44/functions'), file => {
    if (!/[/\\]entry\.[jt]s$/.test(file)) return;
    functions.push(relative(directory, file));
    try { compileFunction(readFileSync(file, 'utf8'), file, directory); }
    catch (error) { errors.push(relative(directory, file) + ': ' + error.message); }
  });
  for (const folder of ['src', 'base44']) walk(resolve(directory, folder), file => {
    const source = readFileSync(file, 'utf8');
    const label = relative(directory, file);
    if (/\.agents\s*\./.test(source)) warnings.push(label + ': agentes/conversas persistentes ainda não têm adaptação local.');
    if (/\.(?:UploadFile|SendEmail|GenerateImage|ExtractDataFromUploadedFile)\s*\(/.test(source)) warnings.push(label + ': integração externa precisa de adaptador próprio.');
    if (/\.asServiceRole\b/.test(source)) warnings.push(label + ': acesso administrativo não é irrestrito; entidades owner continuam isoladas por usuário.');
  });
  return { functions, errors, warnings: [...new Set(warnings)] };
}

export function printInspection(report, print = console.log) {
  print(`${report.functions.length} função(ões) analisada(s), ${report.errors.length} erro(s) de compatibilidade detectado(s).`);
  for (const error of report.errors) print('✗ ' + error);
  for (const warning of report.warnings) print('Aviso: ' + warning);
  print('A análise não executa o app nem valida credenciais. Exportar código não importa registros do banco Base44.');
}
