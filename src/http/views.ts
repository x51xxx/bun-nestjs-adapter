import { promises as fs } from 'fs';
import { extname } from 'path';

/**
 * Render a template file with the configured view engine (resolved lazily so
 * the engines stay optional peer dependencies).
 */
export async function renderTemplate(
  engine: string,
  filePath: string,
  options: object,
): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const template = await fs.readFile(filePath, 'utf8');

  if (engine === 'ejs' || ext === '.ejs') {
    const ejsModule = await import('ejs');
    const ejs = ejsModule.default || ejsModule;
    return ejs.render(template, options, { filename: filePath });
  }
  if (engine === 'hbs' || engine === 'handlebars' || ext === '.hbs') {
    const hbs = await import('handlebars');
    const compiled = hbs.compile(template);
    return compiled(options);
  }
  if (engine === 'pug' || ext === '.pug') {
    const pug = await import('pug');
    const compiled = pug.compile(template, { filename: filePath });
    return compiled(options);
  }

  throw new Error(`platform-bun: Unsupported view engine "${engine}"`);
}
