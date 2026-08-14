/**
 * Semantic recall math. The production embedder is optional and injected, so
 * this module contains only deterministic vector operations.
 */

export interface Embedder {
  /** Embed each text to a fixed-dimension vector (all vectors the same length). */
  embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity of two equal-length vectors; 0 for a zero vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Subtract the centroid of `vectors` from each vector. */
export function meanCenter(vectors: number[][]): number[][] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const centroid = new Array<number>(dim).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dim; i += 1) centroid[i]! += vector[i]!;
  }
  for (let i = 0; i < dim; i += 1) centroid[i]! /= vectors.length;
  return vectors.map((vector) => vector.map((value, index) => value - centroid[index]!));
}

/**
 * Score a query against documents using the documents' centroid. A one-document
 * corpus uses raw cosine because it has no meaningful centroid. With two or
 * more documents, both the query and documents are centered on the document
 * centroid. An empty result for a non-empty corpus means the query was exactly
 * at that centroid, leaving no direction to rank.
 *
 * Callers must first validate equal, non-zero dimensions and finite values.
 */
export function centeredCosineScores(queryVec: number[], docVecs: number[][]): number[] {
  if (docVecs.length === 0) return [];
  if (docVecs.length === 1) return [cosineSimilarity(queryVec, docVecs[0]!)];

  const dim = queryVec.length;
  const centroid = new Array<number>(dim).fill(0);
  for (const vector of docVecs) {
    for (let i = 0; i < dim; i += 1) centroid[i]! += vector[i]!;
  }
  for (let i = 0; i < dim; i += 1) centroid[i]! /= docVecs.length;

  const centeredQuery = queryVec.map((value, index) => value - centroid[index]!);
  if (centeredQuery.every((value) => value === 0)) return [];
  return docVecs.map((vector) =>
    cosineSimilarity(
      centeredQuery,
      vector.map((value, index) => value - centroid[index]!),
    ),
  );
}
