/**
 * Drain: online log template mining (He, Zhu, Zheng, Lyu, "Drain: An Online Log Parsing Approach with Fixed Depth
 * Tree", ICWS 2017). Written for Clickland from the paper; ClickStack ships a port of the Python `drain3` package
 * (research/clickstack.md §4).
 *
 * A message is masked (numbers, ids, addresses become placeholders), split on whitespace, routed down a fixed-depth
 * tree by its length and first tokens, and joined to the most similar cluster in that leaf when the share of equal
 * tokens reaches `similarity`; the cluster's template keeps the equal tokens and turns the others into `<*>`.
 */

export interface DrainOptions {
  /** Tree depth including the root and the length level (the paper's d; 4 means two token levels). */
  depth?: number;
  similarity?: number;
  maxChildren?: number;
  maxClusters?: number;
}

export interface Pattern {
  template: string;
  count: number;
  example: string;
  services: string[];
}

const WILDCARD = '<*>';

const MASKS: [RegExp, string][] = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<IP>'],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<TIME>'],
  [/\b0x[0-9a-f]+\b/gi, '<HEX>'],
  [/\b[0-9a-f]{16,}\b/gi, '<HEX>'],
  [/(?<![\w.])[-+]?\d+(?:\.\d+)?(?:ms|s|us|ns|kb|mb|gb|%)?(?![\w.])/gi, '<NUM>'],
];

export function maskMessage(message: string): string {
  let out = message;
  for (const [re, label] of MASKS) out = out.replace(re, label);
  return out;
}

interface Cluster {
  tokens: string[];
  count: number;
  example: string;
  services: Set<string>;
}

interface Node {
  children: Map<string, Node>;
  clusters: Cluster[];
}

const newNode = (): Node => ({ children: new Map(), clusters: [] });
const hasDigit = (t: string) => /\d/.test(t);

export class Drain {
  private readonly root = newNode();
  private readonly all: Cluster[] = [];
  private readonly depth: number;
  private readonly similarity: number;
  private readonly maxChildren: number;
  private readonly maxClusters: number;

  constructor(options: DrainOptions = {}) {
    this.depth = Math.max(3, options.depth ?? 4);
    this.similarity = options.similarity ?? 0.4;
    this.maxChildren = options.maxChildren ?? 100;
    this.maxClusters = options.maxClusters ?? 1000;
  }

  add(message: string, service = ''): void {
    const tokens = maskMessage(message.trim()).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return;
    const leaf = this.leaf(tokens);
    let best: Cluster | undefined;
    let bestScore = -1;
    let bestParams = -1;
    for (const cluster of leaf.clusters) {
      const [score, params] = this.score(cluster.tokens, tokens);
      if (score > bestScore || (score === bestScore && params > bestParams)) {
        best = cluster;
        bestScore = score;
        bestParams = params;
      }
    }
    if (best && bestScore >= this.similarity) {
      best.tokens = best.tokens.map((t, i) => (t === tokens[i] ? t : WILDCARD));
      best.count++;
      if (service) best.services.add(service);
      return;
    }
    if (this.all.length >= this.maxClusters) return;
    const cluster: Cluster = { tokens, count: 1, example: message, services: new Set(service ? [service] : []) };
    leaf.clusters.push(cluster);
    this.all.push(cluster);
  }

  /** The paper's similarity: the share of positions with equal tokens (wildcards don't count), and the wildcards. */
  private score(template: string[], tokens: string[]): [number, number] {
    let same = 0;
    let params = 0;
    for (let i = 0; i < template.length; i++) {
      if (template[i] === WILDCARD) params++;
      else if (template[i] === tokens[i]) same++;
    }
    return [same / template.length, params];
  }

  private leaf(tokens: string[]): Node {
    const child = (parent: Node, key: string): Node => {
      let found = parent.children.get(key);
      if (!found) {
        found = newNode();
        parent.children.set(key, found);
      }
      return found;
    };
    let node = child(this.root, String(tokens.length));
    // The paper's depth counts the root, the length level and the leaf: depth 4 routes on one token.
    const levels = Math.min(this.depth - 3, tokens.length);
    for (let i = 0; i < levels; i++) {
      // Tokens with digits are likely variables: route them through the wildcard child.
      const token = hasDigit(tokens[i]!) ? WILDCARD : tokens[i]!;
      const existing = node.children.get(token);
      node = existing ?? child(node, node.children.size < this.maxChildren ? token : WILDCARD);
    }
    return node;
  }

  patterns(): Pattern[] {
    return this.all
      .map((c) => ({
        template: c.tokens.join(' '),
        count: c.count,
        example: c.example,
        services: [...c.services].sort(),
      }))
      .sort((a, b) => b.count - a.count);
  }
}

export function minePatterns(rows: { text: string; service?: string }[], options?: DrainOptions): Pattern[] {
  const drain = new Drain(options);
  for (const row of rows) drain.add(row.text, row.service);
  return drain.patterns();
}
