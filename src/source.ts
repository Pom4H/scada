import ts from '@typescript/typescript6';
import { catalog, defaults, type Scene, type Equipment, type Endpoint, type Link, type Value, type Kind } from './core';

export interface Span { from: number; to: number }
export interface Change extends Span { insert: string }
export interface SourceObject { span: Span; options: ts.ObjectLiteralExpression; fields: Map<string, ts.Expression>; statement: ts.Statement; variable: string }
export interface Compiled { scene: Scene; file: ts.SourceFile; objects: Map<string, SourceObject>; statements: Map<string, ts.Statement>; imports: Map<string, string> }
export class SourceError extends Error {
  constructor(message: string, public from = 0, public to = from + 1) { super(message); this.name = 'SourceError'; }
}
const has = (o: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(o, key);
const isEquipment = (v: unknown): v is Equipment => !!v && typeof v === 'object' && has(v, 'kind');
const isLink = (v: unknown): v is Link => !!v && typeof v === 'object' && has(v, 'from') && has(v, 'to');
const isEndpoint = (v: unknown): v is Endpoint => !!v && typeof v === 'object' && has(v, 'node') && has(v, 'port');
const literal = (n: ts.Expression): boolean => ts.isNumericLiteral(n) || ts.isStringLiteral(n) || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || (ts.isPrefixUnaryExpression(n) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(n.operator) && ts.isNumericLiteral(n.operand));

/** Read a bounded, declarative TypeScript subset. NEVER eval / new Function. */
export function compile(source: string): Compiled {
  if (source.length > 120_000) throw new SourceError('Максимальный размер проекта: 120 000 символов.');
  const file = ts.createSourceFile('scene.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) {
    const d = diagnostics[0]; throw new SourceError(ts.flattenDiagnosticMessageText(d.messageText, '\n'), d.start ?? 0, (d.start ?? 0) + (d.length ?? 1));
  }
  const scene: Scene = { nodes: [], links: [] };
  const objects = new Map<string, SourceObject>(); const statements = new Map<string, ts.Statement>();
  const values = new Map<string, unknown>(); const imports = new Map<string, string>();
  let statement: ts.Statement; let variable = ''; let steps = 0;
  function fail(n: ts.Node, message: string): never { throw new SourceError(message, n.getStart(file), n.getEnd()); }
  function evaluate(n: ts.Expression, depth = 0): unknown {
    if (++steps > 12_000 || depth > 80) fail(n, 'Слишком сложный проект.');
    const ev = (child: ts.Expression) => evaluate(child, depth + 1);
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) return ev(n.expression);
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(n)) {
      const a = ev(n.operand);
      if (typeof a === 'number' && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(n.operator)) return n.operator === ts.SyntaxKind.MinusToken ? -a : a;
      fail(n, 'Поддерживаются только числовые + и −.');
    }
    if (ts.isBinaryExpression(n)) {
      const a = ev(n.left), b = ev(n.right);
      if (typeof a !== 'number' || typeof b !== 'number') fail(n, 'Арифметика доступна только для чисел.');
      switch (n.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return a + b;
        case ts.SyntaxKind.MinusToken: return a - b;
        case ts.SyntaxKind.AsteriskToken: return a * b;
        case ts.SyntaxKind.SlashToken: return a / b;
        default: fail(n, 'Разрешены +, −, *, /.');
      }
    }
    if (ts.isIdentifier(n)) {
      if (!values.has(n.text)) fail(n, `Неизвестное имя «${n.text}». Объявите const до использования.`);
      return values.get(n.text);
    }
    if (ts.isPropertyAccessExpression(n)) {
      const object = ev(n.expression), port = n.name.text;
      if (!isEquipment(object) || !has(catalog[object.kind].ports, port)) fail(n, `Неизвестный порт «${port}».`);
      return { node: object.id, port } satisfies Endpoint;
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = imports.get(n.expression.text);
      if (!name) fail(n.expression, 'Вызов должен быть импортирован из "@scada/core".');
      if (name === 'connect') {
        if (n.arguments.length !== 2) fail(n, 'connect(from.outlet, to.inlet) принимает два порта.');
        const from = ev(n.arguments[0]), to = ev(n.arguments[1]);
        if (!isEndpoint(from) || !isEndpoint(to)) fail(n, 'Соединяйте порты: connect(pump.outlet, valve.inlet).');
        if (from.node === to.node) fail(n, 'Нельзя соединить элемент с самим собой.');
        for (const [endpoint, role] of [[from, 'out'], [to, 'in']] as const) {
          const node = scene.nodes.find(v => v.id === endpoint.node)!;
          if (catalog[node.kind].ports[endpoint.port].role !== role) fail(n, 'Соединение должно идти от выхода ко входу.');
          if (scene.links.some(l => [l.from, l.to].some(p => p.node === endpoint.node && p.port === endpoint.port))) fail(n, `Порт ${endpoint.node}.${endpoint.port} уже занят.`);
        }
        const edge: Link = { id: `${from.node}.${from.port}:${to.node}.${to.port}`, from, to, variable };
        scene.links.push(edge); statements.set(edge.id, statement); return edge;
      }
      if (name === 'tap') {
        if (n.arguments.length !== 2) fail(n, 'tap(line, instrument) принимает линию и прибор.');
        const line = ev(n.arguments[0]); const instrument = ev(n.arguments[1]);
        if (!isLink(line) || !isEquipment(instrument) || !catalog[instrument.kind].instrument) fail(n, 'tap ожидает connect(...) и pressure(...) или temperature(...).');
        if (instrument.tap) fail(n, 'Прибор уже подключён к линии.');
        instrument.tap = line.id; statements.set(`tap:${instrument.id}`, statement); return instrument;
      }
      if (has(catalog, name!)) {
        const kind = name as Kind, definition = catalog[kind];
        if (n.arguments.length !== 2 || !ts.isObjectLiteralExpression(n.arguments[1])) fail(n, `${name}("ID", { ... }) требует литерал объекта свойств.`);
        const id = ev(n.arguments[0]);
        if (typeof id !== 'string' || !/^[\p{L}\p{N}_.-]{1,48}$/u.test(id)) fail(n.arguments[0], 'ID: 1–48 букв, цифр, точек, дефисов или подчёркиваний.');
        if (objects.has(id)) fail(n, `Повторный ID: ${id}.`);
        if (scene.nodes.length >= 48) fail(n, 'В этой версии максимум 48 элементов на сцене.');
        const options = n.arguments[1] as ts.ObjectLiteralExpression;
        const fields = new Map<string, ts.Expression>(); const props = defaults(kind);
        for (const p of options.properties) {
          if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) fail(p, 'Только явные свойства: x: 100. Spread, методы и shorthand не поддерживаются.');
          const key = p.name.text;
          if (!has(definition.fields, key)) fail(p.name, `У ${name} нет свойства «${key}».`);
          if (fields.has(key)) fail(p.name, `Повторное свойство: ${key}.`);
          const value = ev(p.initializer); const f = definition.fields[key];
          if (typeof value !== typeof f.default) fail(p.initializer, `«${key}» ожидает ${typeof f.default}.`);
          if (typeof value === 'number' && (!Number.isFinite(value) || value < f.min! || value > f.max!)) fail(p.initializer, `${key}: значение должно быть от ${f.min} до ${f.max}.`);
          if (f.choices && !f.choices.includes(String(value))) fail(p.initializer, `${key}: ${f.choices.join(' / ')}.`);
          props[key] = value as Value; fields.set(key, p.initializer);
        }
        const item: Equipment = { id, kind, props, variable };
        scene.nodes.push(item); statements.set(id, statement);
        objects.set(id, { span: { from: n.getStart(file), to: n.getEnd() }, options, fields, statement, variable });
        return item;
      }
      fail(n, `Неизвестная функция DSL: ${name}.`);
    }
    fail(n, 'Это декларативный TypeScript DSL. Циклы, произвольные функции, DOM и сетевые вызовы здесь не выполняются.');
  }
  for (const s of file.statements) {
    statement = s; variable = '';
    if (ts.isImportDeclaration(s)) {
      if (!ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== '@scada/core') fail(s, 'Разрешён только импорт из "@scada/core".');
      const binding = s.importClause?.namedBindings;
      if (!binding || !ts.isNamedImports(binding)) fail(s, 'Используйте именованные импорты: import { pump } from "@scada/core".');
      for (const item of binding.elements) {
        const remote = item.propertyName?.text ?? item.name.text;
        if (!has(catalog, remote) && !['connect', 'tap'].includes(remote)) fail(item, `Неизвестный экспорт: ${remote}.`);
        if (imports.has(item.name.text) || values.has(item.name.text)) fail(item, 'Повторное имя импорта.');
        imports.set(item.name.text, remote);
      }
    } else if (ts.isVariableStatement(s)) {
      if (!(s.declarationList.flags & ts.NodeFlags.Const) || s.declarationList.declarations.length !== 1) fail(s, 'Одна декларация const на строку; let и var не поддерживаются.');
      const d = s.declarationList.declarations[0];
      if (!ts.isIdentifier(d.name) || !d.initializer) fail(s, 'Используйте const name = ...;');
      variable = d.name.text;
      if (values.has(variable) || imports.has(variable)) fail(d.name, `Повторное имя: ${variable}.`);
      values.set(variable, evaluate(d.initializer));
    } else if (ts.isExpressionStatement(s)) {
      if (!ts.isCallExpression(s.expression)) fail(s, 'Здесь ожидается connect(...) или tap(...).');
      evaluate(s.expression);
    } else if (s.kind !== ts.SyntaxKind.EmptyStatement) fail(s, 'Поддерживаются import, const, connect и tap.');
  }
  for (const item of scene.nodes) if (catalog[item.kind].instrument && !item.tap) throw new SourceError(`${item.id}: подключите прибор через tap(line, ...).`, objects.get(item.id)!.span.from, objects.get(item.id)!.span.to);
  return { scene, file, objects, statements, imports };
}
export function editable(compiled: Compiled, id: string, key: string): boolean { const p = compiled.objects.get(id)?.fields.get(key); return !p || literal(p); }
export function applyChanges(source: string, changes: readonly Change[]): string {
  let result = source;
  const sorted = [...changes].sort((a, b) => b.from - a.from);
  for (let i = 0; i < sorted.length; i++) { const c = sorted[i]; if (i && c.to > sorted[i - 1].from) throw new Error('Overlapping source changes'); result = result.slice(0, c.from) + c.insert + result.slice(c.to); }
  return result;
}
/** Surgical edits preserve comments, order, quote style and all unrelated code. */
export function patchFields(source: string, id: string, patch: Record<string, Value>): Change[] {
  const compiled = compile(source), object = compiled.objects.get(id), node = compiled.scene.nodes.find(n => n.id === id);
  if (!object || !node) throw new SourceError(`Элемент ${id} не найден.`);
  const changes: Change[] = []; const missing: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!has(catalog[node.kind].fields, key)) throw new SourceError(`Неизвестное свойство: ${key}.`);
    const old = object.fields.get(key);
    if (old && !literal(old)) throw new SourceError(`${id}.${key} вычисляется выражением. Измените его в коде; визуальный редактор не перезаписывает формулы.`, old.getStart(), old.getEnd());
    const text = typeof value === 'string' ? (old?.getText().startsWith("'") ? `'${value.replace(/'/g, "\\'")}'` : JSON.stringify(value)) : String(value);
    if (old) changes.push({ from: old.getStart(compiled.file), to: old.getEnd(), insert: text });
    else missing.push(`${key}: ${text}`);
  }
  if (missing.length) changes.push({ from: object.options.getStart(compiled.file) + 1, to: object.options.getStart(compiled.file) + 1, insert: ' ' + missing.join(', ') + ', ' });
  compile(applyChanges(source, changes)); // never commit invalid source
  return changes;
}
export function removeObject(source: string, id: string): Change[] {
  const c = compile(source); const removed = new Set<string>([id]);
  for (const l of c.scene.links) if (l.id === id || l.from.node === id || l.to.node === id) removed.add(l.id);
  for (const n of c.scene.nodes) if (n.tap && removed.has(n.tap)) { removed.add(n.id); removed.add(`tap:${n.id}`); }
  if (c.scene.nodes.find(n => n.id === id)?.tap) removed.add(`tap:${id}`);
  const statements = new Set([...removed].map(key => c.statements.get(key)).filter(Boolean) as ts.Statement[]);
  const changes = [...statements].map(s => ({ from: s.getStart(c.file), to: s.getEnd(), insert: '' }));
  compile(applyChanges(source, changes)); return changes;
}
export function ensureImport(source: string, names: string[]): string {
  const c = compile(source); const missing = names.filter(name => ![...c.imports.values()].includes(name));
  if (!missing.length) return source;
  return `import { ${missing.join(', ')} } from "@scada/core";\n` + source;
}
export function appendEquipment(source: string, kind: Kind, x: number, y: number): string {
  const c = compile(source); let i = 1; const prefix = { tank: 'T', pump: 'P', valve: 'V', flowmeter: 'F', exchanger: 'HX', outlet: 'OUT', pressure: 'PT', temperature: 'TT' }[kind];
  while (c.scene.nodes.some(n => n.id === `${prefix}-${100 + i}`) || c.file.text.includes(`${kind}${i}`)) i++;
  if (catalog[kind].instrument) throw new SourceError('Выберите трубопровод, затем добавьте отвод с прибором.');
  const local = [...c.imports].find(([, remote]) => remote === kind)?.[0] ?? kind;
  const result = ensureImport(source, [kind]) + `\nconst ${kind}${i} = ${local}("${prefix}-${100 + i}", { x: ${x}, y: ${y} });\n`;
  compile(result); return result;
}
export function appendConnection(source: string, from: Endpoint, to: Endpoint): string {
  const c = compile(source); const a = c.objects.get(from.node)?.variable, b = c.objects.get(to.node)?.variable;
  if (!a || !b) throw new SourceError('Для соединения у элементов должны быть имена const.');
  const fn = [...c.imports].find(([, remote]) => remote === 'connect')?.[0] ?? 'connect';
  let i = 1; while (new RegExp(`\\bline${i}\\b`).test(source)) i++;
  const result = ensureImport(source, ['connect']) + `\nconst line${i} = ${fn}(${a}.${from.port}, ${b}.${to.port});\n`;
  compile(result); return result;
}
export function appendTap(source: string, lineId: string, kind: 'pressure' | 'temperature'): string {
  const c = compile(source), line = c.scene.links.find(l => l.id === lineId);
  if (!line) throw new SourceError('Выберите линию.');
  let text = source; let ref = line.variable;
  if (!ref) { let i = 1; while (new RegExp(`\\bline${i}\\b`).test(text)) i++; ref = `line${i}`; const s = c.statements.get(line.id)!; text = text.slice(0, s.getStart()) + `const ${ref} = ` + text.slice(s.getStart()); }
  let i = 101; const prefix = kind === 'pressure' ? 'PT' : 'TT'; while (c.objects.has(`${prefix}-${i}`)) i++;
  const local = [...c.imports].find(([, r]) => r === kind)?.[0] ?? kind;
  const tapName = [...c.imports].find(([, r]) => r === 'tap')?.[0] ?? 'tap';
  text = ensureImport(text, [kind, 'tap']) + `\n${tapName}(${ref}, ${local}("${prefix}-${i}", { at: 0.5, offset: 110 }));\n`;
  compile(text); return text;
}
export function formatSource(source: string): string { const c = compile(source); return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(c.file); }
