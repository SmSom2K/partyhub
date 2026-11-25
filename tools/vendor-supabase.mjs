import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const project = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  absWorkingDir: project,
  stdin: {
    contents: "export { createClient } from '@supabase/supabase-js';",
    resolveDir: project,
    sourcefile: 'supabase-browser.js',
  },
  outfile: 'vendor/supabase.js',
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'eof',
  metafile: true,
});

const dependencies = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const modules = input.split('node_modules/');
  if (modules.length === 1) continue;
  const [first, second] = modules.at(-1).split('/');
  const name = first.startsWith('@') ? first + '/' + second : first;
  const root = input.slice(0, input.lastIndexOf('node_modules/') + 'node_modules/'.length) + name;
  dependencies.add(root);
}

const notices = [];
for (const pkg of [...dependencies].sort()) {
  const directory = path.join(project, pkg);
  const meta = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const files = (await readdir(directory)).filter(file => /^(license|copyright|notice)([._-]|$)/i.test(file)).sort();
  if (!files.length) throw new Error('Missing license notice for ' + meta.name);
  const licenses = await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')));
  notices.push(meta.name + ' ' + meta.version + '\n\n' + licenses.map(license => license.replace(/\r\n/g, '\n').trim()).join('\n\n'));
}
await writeFile(path.join(project, 'vendor', 'LICENSES.txt'), notices.join('\n\n-----\n\n') + '\n');
