import ts from 'typescript';
import { ToolFailure } from './tool-outcome';

type Primitive = string | number | boolean | null;
export type RecordValue = Primitive | Primitive[];
const fail = () =>
  new Error(
    'Record must be one unambiguous static object with literal fields; executable, duplicate or computed properties are not supported.',
  );
function propertyName(node: ts.PropertyName): string {
  if ((ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) && node.text !== '__proto__')
    return node.text;
  throw fail();
}
function literal(node: ts.Expression): RecordValue {
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((element) => {
      const value = literal(element);
      if (Array.isArray(value)) throw fail();
      return value;
    });
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text);
  throw fail();
}
function catalogSource(source: string, variable: string) {
  const file = ts.createSourceFile('record.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw fail();
  const candidates: ts.ObjectLiteralExpression[] = [];
  // Only top-level declarations; never evaluate or follow references into code.
  for (const statement of file.statements)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === variable &&
          declaration.initializer &&
          ts.isObjectLiteralExpression(declaration.initializer)
        )
          candidates.push(declaration.initializer);
      }
    }
  if (candidates.length !== 1) throw fail();
  return { file, catalog: candidates[0] };
}

export function listProjectRecords(source: string, variable: string, offset = 0, limit = 20) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new Error('Use a nonnegative offset and a page limit from 1 to 50.');
  const { catalog } = catalogSource(source, variable);
  const keys = catalog.properties.map(property => {
    if (!ts.isPropertyAssignment(property)) throw fail();
    const key = propertyName(property.name);
    if (!key.length || key.length > 500) throw new Error('Catalog keys must contain 1–500 characters to be addressed by record tools.');
    return key;
  });
  if (new Set(keys).size !== keys.length) throw fail();
  const page: string[] = [];
  let characters = 0;
  for (const key of keys.slice(offset, offset + limit)) {
    const size = JSON.stringify(key).length + 1;
    if (characters + size > 10000) break;
    page.push(key); characters += size;
  }
  return { keys: page, totalRecords: keys.length, offset, nextOffset: offset + page.length < keys.length ? offset + page.length : null };
}

function locate(source: string, variable: string, key: string) {
  const { file, catalog } = catalogSource(source, variable);
  const matches = catalog.properties.filter((property) => {
    if (!ts.isPropertyAssignment(property)) throw fail();
    return propertyName(property.name) === key;
  });
  if (!matches.length) {
    let suggestedKey: string | undefined;
    try {
      const decoded = JSON.parse(key);
      if (typeof decoded === 'string' && catalog.properties.some(property =>
        ts.isPropertyAssignment(property) && propertyName(property.name) === decoded)) suggestedKey = decoded;
    } catch { /* Suggest only an exact existing key, never silently repair it. */ }
    throw new ToolFailure('RECORD_NOT_FOUND', `No record has the exact key ${JSON.stringify(key)}. Use list_project_records and copy its string key without adding quote characters; numeric-looking keys are strings too.`,
      { requestedKey: key, ...(suggestedKey === undefined ? {} : { suggestedKey }), nextAction: 'Retry read_project_record with the exact returned string key; keep path and variable unchanged. This is a missing key, not unsupported catalog syntax.' });
  }
  if (matches.length !== 1) throw fail();
  const initializer = (matches[0] as ts.PropertyAssignment).initializer;
  if (!ts.isObjectLiteralExpression(initializer)) throw fail();
  const fields: Record<string, RecordValue> = Object.create(null);
  const nodes = new Map<string, ts.PropertyAssignment>();
  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property)) throw fail();
    const name = propertyName(property.name);
    if (nodes.has(name)) throw fail();
    fields[name] = literal(property.initializer);
    nodes.set(name, property);
  }
  return { file, object: initializer, fields, nodes };
}

export function readProjectRecord(source: string, variable: string, key: string) {
  const { fields } = locate(source, variable, key);
  if (JSON.stringify(fields).length > 20000)
    throw new Error('Record exceeds the 20,000 character result limit. Inspect a smaller source region.');
  return fields;
}

export function patchProjectRecord(
  source: string,
  variable: string,
  key: string,
  fields: Record<string, RecordValue>,
): string {
  const { file, object, nodes } = locate(source, variable, key);
  const changes: { start: number; end: number; text: string }[] = [];
  const additions: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (name === '__proto__') throw fail();
    const property = nodes.get(name);
    const text = JSON.stringify(value);
    if (property) changes.push({ start: property.initializer.getStart(file), end: property.initializer.end, text });
    else additions.push(`${JSON.stringify(name)}: ${text}`);
  }
  if (additions.length) {
    const last = object.properties.at(-1);
    const point = last?.end ?? object.getStart(file) + 1;
    changes.push({ start: point, end: point, text: `${last ? ',' : ''} ${additions.join(', ')}` });
  }
  let next = source;
  for (const change of changes.sort((a, b) => b.start - a.start))
    next = next.slice(0, change.start) + change.text + next.slice(change.end);
  // Parse and locate again so generated content cannot silently become invalid.
  locate(next, variable, key);
  return next;
}
