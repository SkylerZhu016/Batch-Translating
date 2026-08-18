import { sha256Bytes } from '../hash.js';
import type { ParagraphManifest, TextSegmentManifest } from '../types.js';
import {
  ancestorElements,
  childNodes,
  descendantElements,
  localName,
  nodePath,
  type DomDocument,
  type DomElement,
  type DomNode,
} from '../xml.js';

const ALWAYS_BLOCK = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'dt',
  'dd',
  'figcaption',
  'caption',
  'td',
  'th',
]);
const CONDITIONAL_BLOCK = new Set(['li', 'blockquote', 'div', 'section']);
const NON_TRANSLATABLE = new Set(['script', 'style', 'svg', 'math', 'noscript']);

export function extractParagraphs(document: DomDocument, chapterId: string): ParagraphManifest[] {
  const root = document.documentElement;
  const candidates = descendantElements(root).filter(isParagraphElement);
  const selected = candidates.filter((element) => {
    if (ALWAYS_BLOCK.has(localName(element))) return true;
    return !descendantElements(element).some((child) => ALWAYS_BLOCK.has(localName(child)) || localName(child) === 'li');
  });

  const paragraphs: ParagraphManifest[] = [];
  for (const element of selected) {
    const rawSegments = collectTextNodes(element);
    if (rawSegments.length === 0) continue;
    const ordinal = paragraphs.length + 1;
    const paragraphId = `${chapterId}-p${String(ordinal).padStart(4, '0')}`;
    const segments: TextSegmentManifest[] = rawSegments.map(({ node, protectedMarkup }, index) => ({
      segment_id: `${paragraphId}-s${String(index + 1).padStart(3, '0')}`,
      node_path: nodePath(element, node),
      source_text: node.nodeValue ?? '',
      source_hash: sha256Bytes(node.nodeValue ?? ''),
      protected_markup: protectedMarkup,
    }));
    const sourceText = normalizeProse(element.textContent ?? '');
    paragraphs.push({
      paragraph_id: paragraphId,
      chapter_id: chapterId,
      ordinal,
      element_path: nodePath(root, element),
      source_text: sourceText,
      source_hash: sha256Bytes(sourceText),
      segments,
    });
  }
  return paragraphs;
}

function isParagraphElement(element: DomElement): boolean {
  const name = localName(element);
  return ALWAYS_BLOCK.has(name) || CONDITIONAL_BLOCK.has(name);
}

function collectTextNodes(root: DomElement): Array<{ node: DomNode; protectedMarkup: boolean }> {
  const result: Array<{ node: DomNode; protectedMarkup: boolean }> = [];
  const visit = (node: DomNode): void => {
    if (node.nodeType === 1 && NON_TRANSLATABLE.has(localName(node as DomElement))) return;
    if (node.nodeType === 3 && /\S/u.test(node.nodeValue ?? '')) {
      const ancestors = ancestorElements(node, root);
      result.push({
        node,
        protectedMarkup: ancestors.some(isProtectedInline),
      });
      return;
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
  return result;
}

function isProtectedInline(element: DomElement): boolean {
  const name = localName(element);
  if (name === 'a') return true;
  if (name === 'code' || name === 'kbd' || name === 'samp') return true;
  const epubType = element.getAttribute('epub:type') ?? element.getAttribute('type');
  return epubType?.split(/\s+/u).some((value) => value === 'noteref' || value === 'pagebreak') ?? false;
}

function normalizeProse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}
