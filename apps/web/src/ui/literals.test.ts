// Texto suelto (#73): todo lo que lee el PM pasa por el catálogo. Este test recorre los .ts/.tsx de ui/ con el parser
// de TypeScript y falla si encuentra un literal visible con letras fuera de `copy.ts`: texto JSX, atributos visibles
// (aria-label, placeholder, title, alt, label) y los campos que pintan los avisos (`title`, `text`, `body`).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// en jsdom, `URL` es el del DOM: la carpeta sale de `import.meta.dirname` (Node/vitest)
const UI_DIR = import.meta.dirname;

/** Lista corta y explícita: archivo → literales permitidos. */
const EXCEPTIONS: Record<string, readonly string[]> = {
  // la marca se escribe igual en todos los idiomas
  'Entry.tsx': ['dagyard'],
  'Hud.tsx': ['dagyard'],
};

const VISIBLE_ATTRS = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'placeholder', 'title', 'alt', 'label']);
const VISIBLE_PROPS = new Set(['title', 'text', 'body']);
const LETTER = /\p{L}/u;

/** Los literales que una expresión puede pintar tal cual (no los que solo compara o pasa a una función). */
function shown(e: ts.Expression): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.map((s) => s.literal.text)];
  if (ts.isParenthesizedExpression(e)) return shown(e.expression);
  if (ts.isConditionalExpression(e)) return [...shown(e.whenTrue), ...shown(e.whenFalse)];
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return shown(e.right);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken)
      return [...shown(e.left), ...shown(e.right)];
  }
  return [];
}

export function looseText(source: string, fileName: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const add = (texts: string[]) => {
    for (const raw of texts) {
      const text = raw.replace(/\s+/g, ' ').trim();
      if (LETTER.test(text)) found.push(text);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add([node.text]);
    else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) add(shown(node.expression));
    else if (ts.isJsxAttribute(node) && VISIBLE_ATTRS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) add([init.text]);
      else if (ts.isJsxExpression(init) && init.expression) add(shown(init.expression));
    } else if (ts.isPropertyAssignment(node) && VISIBLE_PROPS.has(node.name.getText(sf))) add(shown(node.initializer));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function uiFiles(): string[] {
  return readdirSync(UI_DIR)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'copy.ts')
    .sort();
}

describe('texto suelto en ui/', () => {
  it('la sonda caza lo que tiene que cazar', () => {
    const bad = `
      export const A = () => (
        <div title="Hola" aria-label={ok ? 'Cerrar' : COPY.close}>
          Texto suelto {' · ahora en '} {who ? \`\${who} respondió\` : X}
          <input placeholder="Pega tu clave" />
        </div>
      );
      const toast = { kind: 'work', title: n.title, text: 'se agregó al plan' };`;
    expect(looseText(bad, 'bad.tsx')).toEqual(['Hola', 'Cerrar', 'Texto suelto', '· ahora en', 'respondió', 'Pega tu clave', 'se agregó al plan']);
  });

  it('no confunde comparaciones, clases ni claves con texto', () => {
    const fine = `
      export const B = () => (
        <div className={\`stage \${s}\`} role="group" aria-hidden="true">
          {blocker.kind === 'access' && blocker.label ? blocker.label : blocker.question}
          {COPY.close} · {roman(1)} ×
          {items.map((x) => x.join(' · '))}
        </div>
      );
      const k = { kind: 'work', title: n.title, text: COPY.added };`;
    expect(looseText(fine, 'fine.tsx')).toEqual([]);
  });

  it('ningún archivo de ui/ tiene texto visible fuera del catálogo', () => {
    const files = uiFiles();
    expect(files.length).toBeGreaterThan(5);
    const offenders: Record<string, string[]> = {};
    for (const f of files) {
      const allowed = EXCEPTIONS[f] ?? [];
      const loose = looseText(readFileSync(join(UI_DIR, f), 'utf8'), f).filter((s) => !allowed.includes(s));
      if (loose.length) offenders[f] = loose;
    }
    expect(offenders).toEqual({});
  });
});
