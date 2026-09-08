import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

export function functionEntries(directory) {
  const root = realpathSync(directory), found = new Map();
  for (const folder of ['base44/functions', 'functions']) {
    const base = resolve(root, folder);
    if (!existsSync(base)) continue;
    const visit = current => {
      if (!realpathSync(current).startsWith(root + sep)) throw new Error('Função fora do projeto.');
      for (const item of readdirSync(current, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error('Funções não podem usar links simbólicos.');
        const file = resolve(current, item.name);
        if (item.isDirectory()) { if (!['node_modules', '.git', '.moon'].includes(item.name)) visit(file); continue; }
        if (!/\.[jt]s$/.test(item.name)) continue;
        const path = relative(base, file).replaceAll('\\', '/');
        // Flat legacy functions and the current <name>/entry.ts convention.
        if (path.includes('/') && !/\/entry\.[jt]s$/.test(path)) continue;
        const name = path.replace(/\/entry\.[jt]s$/, '').replace(/\.[jt]s$/, '');
        if (found.has(name)) throw new Error('Função ambígua: ' + name);
        found.set(name, file);
      }
    };
    if (statSync(base).isDirectory()) visit(base);
  }
  return found;
}

export function resolveFunctionEntry(directory, name) {
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(name)) throw new Error('Nome de função inválido.');
  const entry = functionEntries(directory).get(name);
  if (!entry) throw Object.assign(new Error('Função não encontrada no projeto: ' + name), { status: 404 });
  return entry;
}
