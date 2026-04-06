/**
 * Node ID generation for the new file-path-based qualified name format.
 *
 * This replaces the old dotted module path format with a more stable
 * file-path-based ID, inspired by GitNexus.
 *
 * Old format: `pi-code-graph.src.lib.vector-store.VectorStore.upsert`
 * New format: `src/lib/vector-store.ts:VectorStore.upsert`
 *
 * Changes:
 * - File paths replace dotted module paths (more stable, matches filesystem)
 * - `project` is a separate property, not part of the QN
 * - Methods use `Class.method` (dot-separated within file)
 * - Optional `#arity` suffix for overload disambiguation
 *
 * Node properties:
 *   qualified_name: "src/lib/foo.ts:Foo.bar"   (path:local — globally unique within project)
 *   project:        "pi-code-graph"            (separate property for project filtering)
 *   file_path:      "src/lib/foo.ts"           (the file portion)
 *   local_name:     "Foo.bar"                  (the in-file name portion)
 *   name:           "bar"                      (the short name)
 */

import { sep, posix } from 'node:path';

/** Separator between file path and local name in a qualified name. */
export const QN_PATH_SEP = ':';

/** Separator between class name and method name within a qualified name. */
export const QN_LOCAL_SEP = '.';

/** Separator for arity suffix on overloaded methods. */
export const QN_ARITY_SEP = '#';

/**
 * Normalize a file path to use forward slashes (POSIX style).
 * This makes IDs portable across Windows/Unix.
 */
export function normalizeFilePath(filePath: string): string {
  if (sep === '/') return filePath;
  return filePath.split(sep).join('/');
}

/**
 * Build a qualified name for a code element.
 *
 * @param filePath  Repo-relative path with forward slashes (e.g., "src/lib/foo.ts")
 * @param localName In-file name, possibly dotted (e.g., "MyClass.method", "helperFn")
 * @param arity     Optional parameter count for overload disambiguation
 */
export function buildQualifiedName(
  filePath: string,
  localName: string,
  arity?: number
): string {
  const normalized = normalizeFilePath(filePath);
  const arityTag = arity !== undefined ? `${QN_ARITY_SEP}${arity}` : '';
  return `${normalized}${QN_PATH_SEP}${localName}${arityTag}`;
}

/**
 * Build a qualified name for a Module node.
 * Modules use just the file path, no local name.
 */
export function buildModuleQualifiedName(filePath: string): string {
  return normalizeFilePath(filePath);
}

/**
 * Build a qualified name for an external package node.
 * External packages have no project or file path.
 *
 * @param packageName  npm package name (e.g., "@scope/pkg", "lodash")
 */
export function buildExternalQualifiedName(packageName: string): string {
  return `external:${packageName}`;
}

/**
 * Parse a qualified name back into its components.
 * Returns null if the QN doesn't match the expected format.
 */
export function parseQualifiedName(qn: string): {
  filePath: string;
  localName: string;
  arity?: number;
} | null {
  // Find the last colon that separates path from local name
  // (file paths shouldn't contain colons in normal cases)
  const colonIdx = qn.lastIndexOf(QN_PATH_SEP);
  if (colonIdx === -1) return null;

  const filePath = qn.slice(0, colonIdx);
  let localName = qn.slice(colonIdx + 1);
  let arity: number | undefined;

  // Strip arity suffix
  const arityIdx = localName.lastIndexOf(QN_ARITY_SEP);
  if (arityIdx !== -1) {
    const arityStr = localName.slice(arityIdx + 1);
    const parsed = parseInt(arityStr, 10);
    if (!isNaN(parsed)) {
      arity = parsed;
      localName = localName.slice(0, arityIdx);
    }
  }

  return { filePath, localName, arity };
}

/**
 * Extract the short name (last segment after the dot) from a local name.
 *  "MyClass.myMethod" → "myMethod"
 *  "helperFn"         → "helperFn"
 */
export function extractShortName(localName: string): string {
  const idx = localName.lastIndexOf(QN_LOCAL_SEP);
  return idx === -1 ? localName : localName.slice(idx + 1);
}

/**
 * Extract the container (class/object) name from a local name.
 *  "MyClass.myMethod" → "MyClass"
 *  "helperFn"         → null
 */
export function extractContainerName(localName: string): string | null {
  const idx = localName.lastIndexOf(QN_LOCAL_SEP);
  return idx === -1 ? null : localName.slice(0, idx);
}

/**
 * Build a method local name from class + method.
 *  ("MyClass", "myMethod") → "MyClass.myMethod"
 */
export function buildMethodLocalName(className: string, methodName: string): string {
  return `${className}${QN_LOCAL_SEP}${methodName}`;
}
