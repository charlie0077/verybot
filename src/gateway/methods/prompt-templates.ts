import { emit } from "../../events.js";
import type { PromptTemplateStore } from "../../prompt-templates/store.js";
import { MAX_TEMPLATE_NAME_LENGTH, MAX_TEMPLATE_CONTENT_LENGTH } from "../../prompt-templates/store.js";

const VALID_ROLES = new Set(["orchestrator", "worker"]);

export function promptTemplateMethods(promptTemplateStore: PromptTemplateStore) {
  return {
    /** List all prompt templates. */
    "promptTemplates.list": async () => {
      return { promptTemplates: promptTemplateStore.listPromptTemplates() };
    },

    /** Get a single prompt template by id. */
    "promptTemplates.get": async (params: unknown) => {
      const { id } = (params ?? {}) as { id?: string };
      if (!id || typeof id !== "string") throw new Error("id is required");
      const promptTemplate = promptTemplateStore.getPromptTemplateById(id);
      if (!promptTemplate) throw new Error(`Template not found: ${id}`);
      return { promptTemplate };
    },

    /** Create a new prompt template. */
    "promptTemplates.create": async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const name = p.name as string | undefined;
      const role = p.role as string | undefined;
      const content = p.content as string | undefined;

      if (!name || typeof name !== "string") throw new Error("name is required");
      if (name.trim().length === 0) throw new Error("name cannot be empty");
      if (name.length > MAX_TEMPLATE_NAME_LENGTH) throw new Error(`name exceeds maximum length of ${MAX_TEMPLATE_NAME_LENGTH}`);
      if (!role || !VALID_ROLES.has(role)) throw new Error("role must be 'orchestrator' or 'worker'");
      if (typeof content !== "string") throw new Error("content is required");
      if (content.length > MAX_TEMPLATE_CONTENT_LENGTH) throw new Error(`content exceeds maximum length of ${MAX_TEMPLATE_CONTENT_LENGTH}`);

      const promptTemplate = promptTemplateStore.createPromptTemplate({
        name: name.trim(),
        description: typeof p.description === "string" ? p.description : "",
        role: role as "orchestrator" | "worker",
        content,
      });
      emit("promptTemplateChange", { action: "created", promptTemplate });
      return { promptTemplate };
    },

    /** Fork an existing template into a user-editable copy. */
    "promptTemplates.fork": async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = p.id as string | undefined;
      if (!id || typeof id !== "string") throw new Error("id is required");

      if (p.name !== undefined && (typeof p.name !== "string" || (p.name as string).trim().length === 0)) {
        throw new Error("name cannot be empty");
      }
      if (typeof p.name === "string" && p.name.length > MAX_TEMPLATE_NAME_LENGTH) {
        throw new Error(`name exceeds maximum length of ${MAX_TEMPLATE_NAME_LENGTH}`);
      }
      if (p.description !== undefined && typeof p.description !== "string") {
        throw new Error("description must be a string");
      }

      const promptTemplate = promptTemplateStore.forkPromptTemplate(id, {
        name: typeof p.name === "string" ? p.name.trim() : undefined,
        description: typeof p.description === "string" ? p.description : undefined,
      });
      if (!promptTemplate) throw new Error(`Template not found: ${id}`);
      emit("promptTemplateChange", { action: "created", promptTemplate });
      return { promptTemplate };
    },

    /** Update an existing prompt template (rejects builtins). */
    "promptTemplates.update": async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const id = p.id as string | undefined;
      if (!id || typeof id !== "string") throw new Error("id is required");
      if (p.name !== undefined && (typeof p.name !== "string" || (p.name as string).trim().length === 0)) {
        throw new Error("name cannot be empty");
      }
      if (p.role !== undefined && !VALID_ROLES.has(p.role as string)) {
        throw new Error("role must be 'orchestrator' or 'worker'");
      }

      const promptTemplate = promptTemplateStore.updatePromptTemplate(id, {
        name: typeof p.name === "string" ? (p.name as string).trim() : undefined,
        description: typeof p.description === "string" ? p.description : undefined,
        role: VALID_ROLES.has(p.role as string) ? (p.role as "orchestrator" | "worker") : undefined,
        content: typeof p.content === "string" ? p.content : undefined,
      });
      if (!promptTemplate) throw new Error(`Template not found: ${id}`);
      emit("promptTemplateChange", { action: "updated", promptTemplate });
      return { promptTemplate };
    },

    /** Delete a prompt template (rejects builtins). */
    "promptTemplates.delete": async (params: unknown) => {
      const { id } = (params ?? {}) as { id?: string };
      if (!id || typeof id !== "string") throw new Error("id is required");
      const deleted = promptTemplateStore.deletePromptTemplate(id);
      if (!deleted) throw new Error(`Template not found: ${id}`);
      emit("promptTemplateChange", { action: "deleted", id });
      return { status: "ok" };
    },
  };
}
