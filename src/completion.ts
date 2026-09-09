import ts from '@typescript/typescript6';
import type { Completion } from '@codemirror/autocomplete';
import { catalog, type Scene } from './core';

/** Completion and validation read the same installed metadata, including third-party fields/ports. */
export function dslCompletions(source: string, position: number, scene?: Scene): Completion[] {
  const member = /([\w$]+)\.[\w$]*$/.exec(source.slice(0, position));
  if (member) {
    const node = scene?.nodes.find(node => node.variable === member[1]);
    if (node) return Object.entries(catalog[node.kind].ports).map(([label, port]) => ({ label, type: 'property', detail: `${port.role} · ${port.direction}` }));
  }
  // TypeScript's recovery parser can still identify a property object during incomplete typing.
  const file = ts.createSourceFile('completion.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Map<string, string>();
  for (const statement of file.statements) if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
    for (const binding of statement.importClause.namedBindings.elements) aliases.set(binding.name.text, binding.propertyName?.text ?? binding.name.text);
  }
  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (node.getFullStart() > position || node.end < position) return;
    if (ts.isCallExpression(node)) call = node;
    ts.forEachChild(node, visit);
  }; visit(file);
  if (call && ts.isIdentifier(call.expression)) {
    const name = aliases.get(call.expression.text) ?? call.expression.text;
    const kind = name === 'component' && call.arguments[0] && ts.isStringLiteral(call.arguments[0]) ? call.arguments[0].text : name;
    const definition = catalog[kind];
    if (definition) {
      const object = call.arguments.find(arg => ts.isObjectLiteralExpression(arg));
      if (object && position >= object.getStart()) {
        for (const property of object.properties) if (ts.isPropertyAssignment(property) && property.initializer.getStart() <= position && property.end >= position) {
          const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : '';
          const field = definition.fields[key];
          if (field?.choices) return field.choices.map(label => ({ label, type: 'enum', detail: field.label }));
        }
        return Object.entries(definition.fields).map(([label, field]) => ({ label, type: 'property', detail: `${field.label}${field.unit ? ` · ${field.unit}` : ''}${field.min !== undefined ? ` · ${field.min}…${field.max}` : ''}${field.scope === 'layout' ? ' · оформление' : ''}` }));
      }
    }
  }
  return [
    ...[...Object.keys(catalog), 'component', 'runtime', 'connect', 'tap'].map(label => ({ label, type: 'function', detail: '@scada/core' })),
    ...(scene?.nodes ?? []).filter(n => n.variable).map(n => ({ label: n.variable, type: 'variable', detail: n.id })),
  ];
}
