import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter';
import type { AnalyzedSource, DependencyLanguage, DependencySymbol, MapSource, RawImport } from './project-map-types';

const id = (...values: string[]) => createHash('sha256').update(values.join('\0')).digest('hex').slice(0, 24);
export const dependencyFileId = (file: string) => 'f_' + id(file);
const normalized = (file: string) =>
  process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);

function symbolFactory(file: string) {
  const duplicates = new Map<string, number>();
  return (
    name: string,
    owner: string | undefined,
    kind: DependencySymbol['kind'],
    line: number,
    column: number,
    endLine: number,
  ): DependencySymbol => {
    const qualifiedName = owner ? `${owner}.${name}` : name;
    const key = `${kind}\0${qualifiedName}`;
    const ordinal = duplicates.get(key) ?? 0;
    duplicates.set(key, ordinal + 1);
    return {
      id: 's_' + id(file, key, String(ordinal)),
      name,
      qualifiedName,
      ...(owner ? { owner } : {}),
      kind,
      file,
      line,
      column,
      endLine,
    };
  };
}

/** The compiler host sees only captured project sources: no project plugins, builds or imports execute. */
export class TypeScriptDependencyAnalyzer {
  private program?: ts.Program;
  private sourceCache = new Map<string, { fingerprint: string; source: ts.SourceFile }>();
  analyze(root: string, sources: MapSource[], signal?: AbortSignal): AnalyzedSource[] {
    const sourceMap = new Map(sources.map((source) => [normalized(source.absolute), source]));
    const options: ts.CompilerOptions = {
      allowJs: true,
      checkJs: true,
      noLib: true,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      jsx: ts.JsxEmit.Preserve,
      skipLibCheck: true,
    };
    const directories = new Set<string>();
    for (const source of sources) {
      let directory = path.dirname(source.absolute);
      for (;;) {
        directories.add(normalized(directory));
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    const host: ts.CompilerHost = {
      getSourceFile: (filename) => {
        const item = sourceMap.get(normalized(filename));
        if (!item) return undefined;
        const cached = this.sourceCache.get(normalized(filename));
        if (cached?.fingerprint === item.fingerprint) return cached.source;
        const source = ts.createSourceFile(item.absolute, item.content, ts.ScriptTarget.Latest, true);
        this.sourceCache.set(normalized(filename), { fingerprint: item.fingerprint, source });
        return source;
      },
      getDefaultLibFileName: () => '',
      writeFile: () => {},
      getCurrentDirectory: () => root,
      getDirectories: (directory) => [...directories].filter((value) => path.dirname(value) === normalized(directory)),
      fileExists: (filename) => sourceMap.has(normalized(filename)),
      readFile: (filename) => sourceMap.get(normalized(filename))?.content,
      directoryExists: (directory) => directories.has(normalized(directory)),
      getCanonicalFileName: normalized,
      useCaseSensitiveFileNames: () => process.platform !== 'win32',
      getNewLine: () => '\n',
      realpath: (filename) => filename,
    };
    this.program = ts.createProgram({
      rootNames: sources.map((source) => source.absolute),
      options,
      host,
      oldProgram: this.program,
    });
    const checker = this.program.getTypeChecker();
    const outputs = new Map<string, AnalyzedSource>();
    const declarations = new Map<ts.Node, DependencySymbol>();
    for (const source of sources) {
      signal?.throwIfAborted();
      const ast = this.program.getSourceFile(source.absolute)!;
      const output: AnalyzedSource = { path: source.path, symbols: [], imports: [], calls: [], diagnostics: [] };
      outputs.set(source.path, output);
      const makeSymbol = symbolFactory(source.path);
      const visit = (node: ts.Node, owner?: string) => {
        let symbol: DependencySymbol | undefined;
        const named = node as ts.Node & { name?: ts.Node };
        const callable =
          ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isConstructorDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node);
        if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && named.name) {
          const start = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          symbol = makeSymbol(
            named.name.getText(ast),
            owner,
            'class',
            start.line + 1,
            start.character + 1,
            ast.getLineAndCharacterOfPosition(node.end).line + 1,
          );
        } else if (callable) {
          const assigned =
            ts.isVariableDeclaration(node.parent) ||
            ts.isPropertyAssignment(node.parent) ||
            ts.isPropertyDeclaration(node.parent)
              ? node.parent
              : undefined;
          const name = ts.isConstructorDeclaration(node)
            ? 'constructor'
            : (named.name?.getText(ast) ?? assigned?.name.getText(ast));
          if (name) {
            const start = ast.getLineAndCharacterOfPosition(node.getStart(ast));
            symbol = makeSymbol(
              name,
              owner,
              ts.isConstructorDeclaration(node)
                ? 'constructor'
                : ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
                  ? 'method'
                  : 'function',
              start.line + 1,
              start.character + 1,
              ast.getLineAndCharacterOfPosition(node.end).line + 1,
            );
            if (assigned) declarations.set(assigned, symbol);
          }
        }
        if (symbol) {
          output.symbols.push(symbol);
          declarations.set(node, symbol);
        }
        ts.forEachChild(node, (child) => visit(child, symbol?.qualifiedName ?? owner));
      };
      visit(ast);
      for (const diagnostic of this.program.getSyntacticDiagnostics(ast))
        output.diagnostics.push({
          file: source.path,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').slice(0, 300),
        });
    }
    for (const source of sources) {
      signal?.throwIfAborted();
      const ast = this.program.getSourceFile(source.absolute)!;
      const output = outputs.get(source.path)!;
      const location = (node: ts.Node) => {
        const position = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        return { file: source.path, line: position.line + 1, column: position.character + 1 };
      };
      const visit = (node: ts.Node, caller = dependencyFileId(source.path)) => {
        const declared = declarations.get(node);
        if (declared && declared.kind !== 'class') caller = declared.id;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const module = node.moduleSpecifier.text;
          const resolved = ts.resolveModuleName(module, source.absolute, options, host).resolvedModule;
          const target = resolved && sourceMap.get(normalized(resolved.resolvedFileName));
          output.imports.push({
            ...location(node),
            source: module,
            names: [],
            resolvedFiles: target ? [target.path] : [],
          });
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const expression = node.expression;
          if (
            ts.isCallExpression(node) &&
            (expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(expression) && expression.text === 'require')) &&
            node.arguments?.[0] &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            const module = node.arguments[0].text;
            const resolved = ts.resolveModuleName(module, source.absolute, options, host).resolvedModule;
            const target = resolved && sourceMap.get(normalized(resolved.resolvedFileName));
            output.imports.push({
              ...location(node),
              source: module,
              names: [],
              resolvedFiles: target ? [target.path] : [],
            });
          }
          let definition: ts.Declaration | undefined;
          const signature = checker.getResolvedSignature(node);
          definition = signature?.declaration;
          if (!definition) {
            let symbol = checker.getSymbolAtLocation(expression);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            definition = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
          }
          const target = definition && declarations.get(definition);
          const property = ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression);
          output.calls.push({
            ...location(node),
            expression: expression.getText(ast).slice(0, 300),
            name: ts.isPropertyAccessExpression(expression)
              ? expression.name.text
              : expression.getText(ast).slice(0, 200),
            caller,
            target: target?.id,
            confidence: target ? (property || ts.isNewExpression(node) ? 'inferred' : 'confirmed') : 'unresolved',
            reason: target
              ? property
                ? 'Compiler-resolved member; runtime dispatch may differ.'
                : undefined
              : 'No captured project implementation could be resolved by the TypeScript compiler.',
          });
        }
        ts.forEachChild(node, (child) => visit(child, caller));
      };
      visit(ast);
    }
    for (const key of this.sourceCache.keys()) if (!sourceMap.has(key)) this.sourceCache.delete(key);
    return [...outputs.values()];
  }
}

const grammarNames: Partial<Record<DependencyLanguage, string>> = {
  python: 'python',
  java: 'java',
  csharp: 'c_sharp',
  go: 'go',
  rust: 'rust',
  c: 'c',
  cpp: 'cpp',
};
const definitions: Partial<Record<DependencyLanguage, Set<string>>> = {
  python: new Set(['function_definition']),
  java: new Set(['method_declaration', 'constructor_declaration']),
  csharp: new Set(['method_declaration', 'constructor_declaration', 'local_function_statement']),
  go: new Set(['function_declaration', 'method_declaration']),
  rust: new Set(['function_item']),
  c: new Set(['function_definition']),
  cpp: new Set(['function_definition']),
};
const containers = new Set([
  'class_definition',
  'class_declaration',
  'record_declaration',
  'struct_declaration',
  'class_specifier',
  'struct_specifier',
  'namespace_definition',
  'namespace_declaration',
  'file_scoped_namespace_declaration',
  'mod_item',
  'impl_item',
]);
const callKinds: Partial<Record<DependencyLanguage, Set<string>>> = {
  python: new Set(['call']),
  java: new Set(['method_invocation', 'object_creation_expression']),
  csharp: new Set(['invocation_expression', 'object_creation_expression']),
  go: new Set(['call_expression']),
  rust: new Set(['call_expression', 'macro_invocation']),
  c: new Set(['call_expression']),
  cpp: new Set(['call_expression', 'new_expression']),
};
let parserInitialization: Promise<void> | undefined;

function declaratorName(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'function_declarator') return node.childForFieldName('declarator');
  for (const child of node.namedChildren) {
    const found = declaratorName(child);
    if (found) return found;
  }
  return null;
}
function callableName(node: SyntaxNode): { name: string; receiver?: string } {
  const name = node.childForFieldName('name') ?? node.childForFieldName('field') ?? node.childForFieldName('attribute');
  const receiver =
    node.childForFieldName('object') ??
    node.childForFieldName('value') ??
    node.childForFieldName('argument') ??
    node.childForFieldName('expression') ??
    node.childForFieldName('operand') ??
    node.childForFieldName('scope');
  if (name) return { name: name.text, receiver: receiver?.text };
  if (node.type === 'generic_function' && node.childForFieldName('function'))
    return callableName(node.childForFieldName('function')!);
  const segments = node.text.split(/::|\.|->/);
  return {
    name: segments.at(-1)!.replace(/<.*>$/, ''),
    ...(segments.length > 1 ? { receiver: segments.slice(0, -1).join('.') } : {}),
  };
}

/** Tree-sitter establishes syntax; the graph linker labels its name-resolution calls inferred. */
export class TreeSitterDependencyAnalyzer {
  private languages = new Map<DependencyLanguage, Language>();
  constructor(private options: { runtimeRoot?: string; grammarRoot?: string } = {}) {}
  private async parser(language: DependencyLanguage): Promise<Parser> {
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const runtime = this.options.runtimeRoot
      ? path.join(this.options.runtimeRoot, 'web-tree-sitter.wasm')
      : require.resolve('web-tree-sitter/web-tree-sitter.wasm');
    parserInitialization ??= Parser.init({ locateFile: () => runtime });
    await parserInitialization;
    let grammar = this.languages.get(language);
    if (!grammar) {
      const name = grammarNames[language];
      if (!name) throw new Error(`No grammar for ${language}.`);
      const filename = this.options.grammarRoot
        ? path.join(this.options.grammarRoot, `tree-sitter-${name}.wasm`)
        : require.resolve(`@repomix/tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
      grammar = await Language.load(filename);
      this.languages.set(language, grammar);
    }
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser;
  }
  async analyze(source: MapSource, signal?: AbortSignal): Promise<AnalyzedSource> {
    signal?.throwIfAborted();
    const parser = await this.parser(source.language);
    const tree = parser.parse(source.content);
    if (!tree) {
      parser.delete();
      throw new Error('Parser returned no syntax tree.');
    }
    const output: AnalyzedSource = { path: source.path, symbols: [], imports: [], calls: [], diagnostics: [] };
    const makeSymbol = symbolFactory(source.path);
    let visited = 0;
    const location = (node: SyntaxNode) => ({
      file: source.path,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
    });
    const addImport = (node: SyntaxNode, specifier: string, names: RawImport['names'] = []) =>
      output.imports.push({ ...location(node), source: specifier, names });
    const visit = (node: SyntaxNode, owner?: string, caller = dependencyFileId(source.path)) => {
      if (++visited > 250000) return;
      if (visited % 1000 === 0) signal?.throwIfAborted();
      let nextOwner = owner,
        nextCaller = caller;
      if (containers.has(node.type)) {
        const name =
          node.childForFieldName('name') ?? (node.type === 'impl_item' ? node.childForFieldName('type') : null);
        if (name) {
          const symbol = makeSymbol(
            name.text,
            owner,
            'class',
            location(node).line,
            location(node).column,
            node.endPosition.row + 1,
          );
          output.symbols.push(symbol);
          nextOwner = symbol.qualifiedName;
        }
      }
      if (definitions[source.language]?.has(node.type)) {
        const nameNode = node.childForFieldName('name') ?? declaratorName(node);
        if (nameNode) {
          const parts = nameNode.text.split('::');
          const name = parts.pop()!;
          let declaringOwner = parts.length ? parts.join('.') : owner;
          const receiver = node.childForFieldName('receiver');
          if (receiver) {
            const parameter = receiver.namedChildren.find((child) => child.type === 'parameter_declaration');
            declaringOwner = parameter?.childForFieldName('type')?.text.replace(/^\*/, '') ?? declaringOwner;
          }
          const symbol = makeSymbol(
            name,
            declaringOwner,
            node.type.includes('constructor')
              ? 'constructor'
              : declaringOwner || node.type === 'method_declaration'
                ? 'method'
                : 'function',
            location(node).line,
            location(node).column,
            node.endPosition.row + 1,
          );
          output.symbols.push(symbol);
          nextOwner = symbol.qualifiedName;
          nextCaller = symbol.id;
        }
      }
      if (callKinds[source.language]?.has(node.type)) {
        const callee =
          node.childForFieldName('function') ??
          node.childForFieldName('name') ??
          node.childForFieldName('type') ??
          node.namedChildren[0];
        if (callee) {
          const named = callableName(callee);
          if (source.language === 'java') named.receiver = node.childForFieldName('object')?.text;
          output.calls.push({
            ...location(node),
            expression: callee.text.slice(0, 300),
            ...named,
            caller: nextCaller,
            ...(node.type === 'macro_invocation' ? { reason: 'Macro expansion is not executed.' } : {}),
          });
        }
      }
      if (source.language === 'python') {
        if (node.type === 'import_from_statement') {
          const module = node.childForFieldName('module_name');
          if (module)
            addImport(
              node,
              module.text,
              node.namedChildren
                .filter((child) => child.id !== module.id)
                .flatMap((child) => {
                  if (child.type === 'aliased_import')
                    return [
                      {
                        local: child.childForFieldName('alias')?.text ?? '',
                        imported: child.childForFieldName('name')?.text ?? '',
                      },
                    ];
                  return child.type === 'dotted_name' || child.type === 'identifier'
                    ? [{ local: child.text, imported: child.text }]
                    : [];
                }),
            );
        } else if (node.type === 'import_statement')
          for (const child of node.namedChildren) {
            const module = child.type === 'aliased_import' ? child.childForFieldName('name') : child;
            if (module)
              addImport(node, module.text, [
                { local: child.childForFieldName('alias')?.text ?? module.text.split('.')[0], imported: '*' },
              ]);
          }
      } else if (source.language === 'java') {
        if (node.type === 'package_declaration') output.moduleName = node.namedChildren[0]?.text;
        if (node.type === 'import_declaration') {
          const qualified = node.namedChildren.find(
            (child) => child.type === 'scoped_identifier' || child.type === 'identifier',
          );
          if (qualified) {
            const segments = qualified.text.split('.');
            const last = segments.pop()!;
            const isStatic = node.children.some((child) => child.type === 'static');
            addImport(node, isStatic ? segments.join('.') : qualified.text, [
              { local: last, imported: isStatic ? last : '*' },
            ]);
          }
        }
      } else if (source.language === 'csharp') {
        if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration')
          output.moduleName = node.childForFieldName('name')?.text;
        if (node.type === 'using_directive') {
          const qualified = node.childForFieldName('name') ?? node.namedChildren.at(-1);
          if (qualified) addImport(node, qualified.text);
        }
      } else if (source.language === 'go') {
        if (node.type === 'package_clause') output.moduleName = node.namedChildren[0]?.text;
        if (node.type === 'import_spec') {
          const specifier = node.childForFieldName('path');
          if (specifier) {
            const value = specifier.text.slice(1, -1);
            addImport(node, value, [
              { local: node.childForFieldName('name')?.text ?? value.split('/').at(-1)!, imported: '*' },
            ]);
          }
        }
      } else if (source.language === 'rust' && node.type === 'use_declaration') {
        const argument = node.childForFieldName('argument') ?? node.namedChildren[0];
        if (argument) {
          const parts = argument.text.split('::');
          const name = parts.pop()!;
          addImport(node, parts.join('::'), [{ local: name, imported: name }]);
        }
      } else if ((source.language === 'c' || source.language === 'cpp') && node.type === 'preproc_include') {
        const specifier = node.childForFieldName('path');
        if (specifier) addImport(node, specifier.text.slice(1, -1));
      }
      for (const child of node.namedChildren) visit(child, nextOwner, nextCaller);
    };
    try {
      visit(tree.rootNode);
      if (tree.rootNode.hasError)
        output.diagnostics.push({ file: source.path, message: 'Syntax errors detected; relationships are partial.' });
      if (visited > 250000)
        output.diagnostics.push({
          file: source.path,
          message: 'Syntax traversal limit reached; relationships are partial.',
        });
      return output;
    } finally {
      tree.delete();
      parser.delete();
    }
  }
}
