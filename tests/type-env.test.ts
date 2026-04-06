import { describe, it, expect, beforeAll } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import {
  buildTypeEnv,
  extractClassFields,
  extractSimpleTypeName,
  stripNullable,
  type ClassFieldRegistry,
} from '../src/lib/parsers/type-env.js';

// ============================================================================
// Parser setup helpers
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findWasm(relPath: string): string {
  const candidates = [
    join(__dirname, '..', 'node_modules', relPath),
    join(__dirname, '..', '..', 'node_modules', relPath),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Could not find WASM at any of: ${candidates.join(', ')}`);
}

let tsParser: Parser;
let tsLang: Language;

beforeAll(async () => {
  await Parser.init({
    locateFile: () => findWasm('web-tree-sitter/web-tree-sitter.wasm'),
  });
  tsLang = await Language.load(findWasm('@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm'));
  tsParser = new Parser();
  tsParser.setLanguage(tsLang);
});

function parseTs(source: string) {
  const tree = tsParser.parse(source);
  if (!tree) throw new Error('Parse failed');
  return tree.rootNode;
}

// ============================================================================
// Unit tests
// ============================================================================

describe('stripNullable', () => {
  it('strips union with null', () => {
    expect(stripNullable('User | null')).toBe('User');
  });
  it('strips union with undefined', () => {
    expect(stripNullable('User | undefined')).toBe('User');
  });
  it('strips trailing ?', () => {
    expect(stripNullable('User?')).toBe('User');
  });
  it('leaves plain type alone', () => {
    expect(stripNullable('User')).toBe('User');
  });
});

describe('extractClassFields', () => {
  it('extracts field with type annotation', () => {
    const root = parseTs(`
      class Foo {
        bar: Baz;
      }
    `);
    // Find the class_declaration node
    const classNode = root.descendantsOfType('class_declaration')[0];
    expect(classNode).toBeDefined();
    const fields = extractClassFields(classNode);
    expect(fields.get('bar')).toBe('Baz');
  });

  it('extracts multiple fields', () => {
    const root = parseTs(`
      class Foo {
        bar: Baz;
        qux: Quux;
        private zed: Zed;
      }
    `);
    const classNode = root.descendantsOfType('class_declaration')[0];
    const fields = extractClassFields(classNode);
    expect(fields.get('bar')).toBe('Baz');
    expect(fields.get('qux')).toBe('Quux');
    expect(fields.get('zed')).toBe('Zed');
  });

  it('extracts field from constructor param with modifier', () => {
    const root = parseTs(`
      class Foo {
        constructor(private readonly bar: Baz, public qux: Quux) {}
      }
    `);
    const classNode = root.descendantsOfType('class_declaration')[0];
    const fields = extractClassFields(classNode);
    expect(fields.get('bar')).toBe('Baz');
    expect(fields.get('qux')).toBe('Quux');
  });

  it('extracts field from new expression initializer', () => {
    const root = parseTs(`
      class Foo {
        bar = new Baz();
      }
    `);
    const classNode = root.descendantsOfType('class_declaration')[0];
    const fields = extractClassFields(classNode);
    expect(fields.get('bar')).toBe('Baz');
  });

  it('strips nullable wrappers', () => {
    const root = parseTs(`
      class Foo {
        bar: Baz | null;
      }
    `);
    const classNode = root.descendantsOfType('class_declaration')[0];
    const fields = extractClassFields(classNode);
    expect(fields.get('bar')).toBe('Baz');
  });
});

describe('buildTypeEnv', () => {
  it('records Tier 0 annotation types', () => {
    const root = parseTs(`
      const x: User = getUser();
      let y: Admin = getAdmin();
    `);
    const registry: ClassFieldRegistry = new Map();
    const env = buildTypeEnv(root, registry);

    // The first variable_declarator is at file scope
    const declarators = root.descendantsOfType('variable_declarator');
    expect(declarators.length).toBe(2);

    // Look up using the declarator node's identifier
    const xIdent = declarators[0].childForFieldName('name');
    expect(xIdent).toBeDefined();
    expect(env.lookup('x', xIdent!)).toBe('User');

    const yIdent = declarators[1].childForFieldName('name');
    expect(env.lookup('y', yIdent!)).toBe('Admin');
  });

  it('records Tier 1 constructor inference', () => {
    const root = parseTs(`
      const user = new User();
      const service = new MyService();
    `);
    const env = buildTypeEnv(root, new Map());

    const declarators = root.descendantsOfType('variable_declarator');
    expect(env.lookup('user', declarators[0])).toBe('User');
    expect(env.lookup('service', declarators[1])).toBe('MyService');
  });

  it('records Tier 2 assignment chain', () => {
    const root = parseTs(`
      const a = new User();
      const b = a;
    `);
    const env = buildTypeEnv(root, new Map());

    const declarators = root.descendantsOfType('variable_declarator');
    expect(env.lookup('a', declarators[0])).toBe('User');
    expect(env.lookup('b', declarators[1])).toBe('User');
  });

  it('resolves this to enclosing class', () => {
    const root = parseTs(`
      class MyClass {
        doWork() {
          this.helper();
        }
      }
    `);
    const env = buildTypeEnv(root, new Map());

    // Find a node inside the method body
    const callExpr = root.descendantsOfType('call_expression')[0];
    expect(callExpr).toBeDefined();
    const resolved = env.lookup('this', callExpr);
    expect(resolved).toBe('MyClass');
  });

  it('resolves deep field chain', () => {
    // Simulate class field registry built elsewhere
    const registry: ClassFieldRegistry = new Map([
      ['InteractiveMode', new Map([['session', 'Session']])],
      ['Session', new Map([['modelRegistry', 'ModelRegistry']])],
      ['ModelRegistry', new Map([['authStorage', 'AuthStorage']])],
    ]);

    const root = parseTs(`
      class InteractiveMode {
        doAuth() {
          this.session.modelRegistry.authStorage.login();
        }
      }
    `);
    const env = buildTypeEnv(root, registry);

    // resolveChain walks the field types
    const callExpr = root.descendantsOfType('call_expression')[0];
    expect(callExpr).toBeDefined();

    const chain = ['this', 'session', 'modelRegistry', 'authStorage'];
    const finalType = env.resolveChain(chain, callExpr);
    expect(finalType).toBe('AuthStorage');
  });

  it('returns undefined for unknown variables', () => {
    const root = parseTs(`
      const x: User = getUser();
    `);
    const env = buildTypeEnv(root, new Map());
    const declarator = root.descendantsOfType('variable_declarator')[0];
    expect(env.lookup('nonexistent', declarator)).toBeUndefined();
  });

  it('is scope-aware (function-local vars do not leak to file scope)', () => {
    const root = parseTs(`
      const outer: OuterType = new OuterType();
      function doWork() {
        const inner: InnerType = new InnerType();
      }
    `);
    const env = buildTypeEnv(root, new Map());

    // outer is in file scope
    const declarators = root.descendantsOfType('variable_declarator');
    const outerDecl = declarators[0];
    expect(env.lookup('outer', outerDecl)).toBe('OuterType');

    // inner is only visible inside doWork
    const innerDecl = declarators[1];
    expect(env.lookup('inner', innerDecl)).toBe('InnerType');

    // From file scope, inner is invisible
    expect(env.lookup('inner', outerDecl)).toBeUndefined();
  });
});

describe('extractSimpleTypeName', () => {
  it('extracts from identifier node', () => {
    const root = parseTs('let x: User;');
    const declarator = root.descendantsOfType('variable_declarator')[0];
    const typeAnn = declarator.childForFieldName('type');
    expect(typeAnn).toBeDefined();
    const inner = typeAnn!.namedChild(0);
    expect(extractSimpleTypeName(inner!)).toBe('User');
  });

  it('strips array suffix', () => {
    const root = parseTs('let x: User[];');
    const declarator = root.descendantsOfType('variable_declarator')[0];
    const typeAnn = declarator.childForFieldName('type');
    const inner = typeAnn!.namedChild(0);
    expect(extractSimpleTypeName(inner!)).toBe('User');
  });
});
