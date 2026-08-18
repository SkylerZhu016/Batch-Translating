import { DOMParser } from 'linkedom';

export interface DomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: ArrayLike<DomNode>;
  readonly parentNode: DomNode | null;
  nodeValue: string | null;
  textContent: string | null;
}

export interface DomElement extends DomNode {
  readonly localName?: string;
  readonly tagName?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

export interface DomDocument extends DomNode {
  readonly documentElement: DomElement;
  toString(): string;
}

export function parseXml(markup: string, label: string): DomDocument {
  const document = new DOMParser().parseFromString(markup, 'text/xml') as unknown as DomDocument;
  if (!document.documentElement) {
    throw new Error(`${label} has no document element`);
  }
  const parserErrors = descendants(document.documentElement).filter(
    (node): node is DomElement => node.nodeType === 1 && localName(node as DomElement) === 'parsererror',
  );
  if (parserErrors.length > 0) {
    throw new Error(`${label} is not well-formed XML: ${parserErrors[0]?.textContent ?? 'parser error'}`);
  }
  return document;
}

export function childNodes(node: DomNode): DomNode[] {
  return Array.from(node.childNodes);
}

export function descendants(node: DomNode): DomNode[] {
  const result: DomNode[] = [];
  for (const child of childNodes(node)) {
    result.push(child, ...descendants(child));
  }
  return result;
}

export function descendantElements(node: DomNode): DomElement[] {
  return descendants(node).filter((candidate): candidate is DomElement => candidate.nodeType === 1);
}

export function elementsByLocalName(node: DomNode, name: string): DomElement[] {
  const expected = name.toLowerCase();
  const own = node.nodeType === 1 && localName(node as DomElement) === expected ? [node as DomElement] : [];
  return [...own, ...descendantElements(node).filter((element) => localName(element) === expected)];
}

export function firstElementByLocalName(node: DomNode, name: string): DomElement | undefined {
  return elementsByLocalName(node, name)[0];
}

export function localName(element: DomElement): string {
  const raw = element.localName ?? element.tagName ?? element.nodeName;
  return raw.toLowerCase().split(':').at(-1) ?? raw.toLowerCase();
}

export function getAttribute(element: DomElement, name: string): string | undefined {
  const direct = element.getAttribute(name);
  if (direct !== null) return direct;
  const suffix = `:${name.toLowerCase()}`;
  const attributes = (element as unknown as { attributes?: ArrayLike<{ name: string; value: string }> }).attributes;
  if (!attributes) return undefined;
  return Array.from(attributes).find((attribute) => attribute.name.toLowerCase().endsWith(suffix))?.value;
}

export function nodePath(root: DomNode, node: DomNode): number[] {
  const reversed: number[] = [];
  let current: DomNode | null = node;
  while (current && current !== root) {
    const parent: DomNode | null = current.parentNode;
    if (!parent) throw new Error('Node is not a descendant of the requested root');
    const index = childNodes(parent).indexOf(current);
    if (index < 0) throw new Error('DOM child relationship is inconsistent');
    reversed.push(index);
    current = parent;
  }
  if (current !== root) throw new Error('Node is not a descendant of the requested root');
  return reversed.reverse();
}

export function resolveNodePath(root: DomNode, path: readonly number[]): DomNode | undefined {
  let current = root;
  for (const index of path) {
    const next = childNodes(current)[index];
    if (!next) return undefined;
    current = next;
  }
  return current;
}

export function nearestElement(node: DomNode | null): DomElement | undefined {
  let current = node;
  while (current) {
    if (current.nodeType === 1) return current as DomElement;
    current = current.parentNode;
  }
  return undefined;
}

export function ancestorElements(node: DomNode, boundary?: DomNode): DomElement[] {
  const result: DomElement[] = [];
  let current = node.parentNode;
  while (current && current !== boundary) {
    if (current.nodeType === 1) result.push(current as DomElement);
    current = current.parentNode;
  }
  return result;
}
