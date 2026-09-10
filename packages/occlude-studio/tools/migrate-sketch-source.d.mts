/**
 * Types for the store-migration rewriter. It is plain JS — the studio's own
 * scripts and `rewrite-sketch-history.sh` import it directly — but the
 * library's typecheck covers `packages/occlude/tools`, where
 * `store-sweep --migrate` compiles the store as this pass would leave it.
 *
 * Only `migrateSketchSource` is imported from TypeScript. The other exports
 * (the chain readers and `rewriteProducers`) are shaped around the migration
 * tool's internal step records, so declaring them here would be guesswork;
 * a TypeScript caller that needs one should declare it properly then.
 */
export function migrateSketchSource(src: string): string;
