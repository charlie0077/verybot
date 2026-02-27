import { logger } from "../logger.js";

export interface EmbeddingProvider {
  id: string;
  model: string;
  /** Returns embedding vector, or undefined if model is not ready yet. */
  embed(text: string): Promise<number[] | undefined>;
  embedBatch(texts: string[]): Promise<(number[] | undefined)[]>;
  /** True once the model is downloaded and loaded. */
  ready: boolean;
}

const DEFAULT_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

function normalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((v) => (Number.isFinite(v) ? v : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, v) => sum + v * v, 0));
  if (magnitude < 1e-10) return sanitized;
  return sanitized.map((v) => v / magnitude);
}

/**
 * Create a local embedding provider using node-llama-cpp.
 * The model is downloaded and loaded in the background — embed() returns
 * undefined until ready, so the system falls back to FTS5-only search.
 * Returns null if node-llama-cpp is not installed.
 */
export async function createEmbeddingProvider(
  provider: "local" | "none",
  modelPath?: string,
): Promise<EmbeddingProvider | null> {
  if (provider === "none") return null;

  let nodeLlamaCpp: typeof import("node-llama-cpp");
  try {
    nodeLlamaCpp = await import("node-llama-cpp");
  } catch {
    logger.warn("node-llama-cpp not installed. Falling back to FTS5-only search.");
    return null;
  }

  const { getLlama, resolveModelFile, LlamaLogLevel } = nodeLlamaCpp;

  type LlamaType = Awaited<ReturnType<typeof getLlama>>;
  type LlamaModelType = Awaited<ReturnType<LlamaType["loadModel"]>>;
  type EmbeddingContextType = Awaited<ReturnType<LlamaModelType["createEmbeddingContext"]>>;

  let ctx: EmbeddingContextType | null = null;
  const resolvedModel = modelPath || DEFAULT_MODEL;

  const ep: EmbeddingProvider = {
    id: "local",
    model: resolvedModel,
    ready: false,
    async embed(text: string) {
      if (!ctx) return undefined;
      const result = await ctx.getEmbeddingFor(text);
      return normalizeEmbedding(Array.from(result.vector));
    },
    async embedBatch(texts: string[]) {
      if (!ctx) return texts.map(() => undefined);
      return Promise.all(
        texts.map(async (t) => {
          const result = await ctx!.getEmbeddingFor(t);
          return normalizeEmbedding(Array.from(result.vector));
        }),
      );
    },
  };

  // Background init — download model + load context, never blocks startup
  (async () => {
    try {
      logger.info(`Embedding model loading in background (${resolvedModel})...`);
      const llama = await getLlama({ logLevel: LlamaLogLevel.error });
      const resolved = await resolveModelFile(resolvedModel);
      const model = await llama.loadModel({ modelPath: resolved });
      ctx = await model.createEmbeddingContext();
      ep.ready = true;
      logger.info("Embedding model ready.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Embedding model failed to load: ${msg}. Using FTS5-only search.`);
    }
  })();

  return ep;
}
