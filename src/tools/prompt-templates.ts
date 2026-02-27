import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { PromptTemplateStore } from "../prompt-templates/store.js";
import { emit } from "../events.js";

const VALID_ROLES = ["orchestrator", "worker"] as const;

/**
 * Creates AI-facing tools for prompt template management.
 * Lets the LLM list, read, create, and update prompt templates.
 */
export function createPromptTemplateTools(store: PromptTemplateStore): ToolSet {
  const listTemplates = tool({
    description:
      "List all prompt templates. Returns name, role, and whether each is built-in.",
    inputSchema: z.object({}),
    execute: async () => {
      const templates = store.listPromptTemplates();
      if (templates.length === 0) return "No prompt templates found.";
      return templates
        .map((t) => `[${t.id}] ${t.name} (${t.role}${t.builtin ? ", builtin" : ""}) — ${t.description || "no description"}`)
        .join("\n");
    },
  });

  const getTemplate = tool({
    description:
      "Read the full content of a prompt template by ID or name.",
    inputSchema: z.object({
      id: z.string().optional().describe("Template ID"),
      name: z.string().optional().describe("Template name (used if id is not provided)"),
    }),
    execute: async ({ id, name }) => {
      if (!id && !name) return "Either id or name is required";
      let tpl = id ? store.getPromptTemplateById(id) : null;
      if (!tpl && name) {
        const all = store.listPromptTemplates();
        tpl = all.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
      }
      if (!tpl) return `Template not found: ${id ?? name}`;
      return [
        `**${tpl.name}** (${tpl.role}${tpl.builtin ? ", builtin" : ""})`,
        tpl.description ? `Description: ${tpl.description}` : "",
        `---`,
        tpl.content,
      ].filter(Boolean).join("\n");
    },
  });

  const createTemplate = tool({
    description:
      "Create a new prompt template.",
    inputSchema: z.object({
      name: z.string().describe("Template name (must be unique)"),
      description: z.string().optional().describe("Short description of the template"),
      role: z.enum(VALID_ROLES).describe("Role: orchestrator or worker"),
      content: z.string().max(50_000).describe("The prompt template content"),
    }),
    execute: async ({ name, description, role, content }) => {
      try {
        const tpl = store.createPromptTemplate({ name, description, role, content });
        emit("promptTemplateChange", { action: "created", promptTemplate: tpl });
        return `Template created: [${tpl.id}] ${tpl.name} (${tpl.role})`;
      } catch (err) {
        return `Failed to create template: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const updateTemplate = tool({
    description:
      "Update an existing prompt template. Cannot modify built-in templates.",
    inputSchema: z.object({
      id: z.string().describe("Template ID to update"),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe("New description"),
      role: z.enum(VALID_ROLES).optional().describe("New role"),
      content: z.string().max(50_000).optional().describe("New content"),
    }),
    execute: async ({ id, name, description, role, content }) => {
      try {
        const tpl = store.updatePromptTemplate(id, { name, description, role, content });
        if (!tpl) return `Template not found: ${id}`;
        emit("promptTemplateChange", { action: "updated", promptTemplate: tpl });
        return `Template updated: [${tpl.id}] ${tpl.name} (${tpl.role})`;
      } catch (err) {
        return `Failed to update template: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const forkTemplate = tool({
    description:
      "Fork an existing prompt template into a new user-editable copy. Useful for built-in templates.",
    inputSchema: z.object({
      id: z.string().describe("Template ID to fork"),
      name: z.string().optional().describe("Optional name for the forked template"),
      description: z.string().optional().describe("Optional description override"),
    }),
    execute: async ({ id, name, description }) => {
      try {
        const tpl = store.forkPromptTemplate(id, { name, description });
        if (!tpl) return `Template not found: ${id}`;
        emit("promptTemplateChange", { action: "created", promptTemplate: tpl });
        return `Template forked: [${tpl.id}] ${tpl.name} (${tpl.role})`;
      } catch (err) {
        return `Failed to fork template: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  const deleteTemplate = tool({
    description:
      "Delete a prompt template by ID. Cannot delete built-in templates.",
    inputSchema: z.object({
      id: z.string().describe("Template ID to delete"),
    }),
    execute: async ({ id }) => {
      try {
        const deleted = store.deletePromptTemplate(id);
        if (!deleted) return `Template not found: ${id}`;
        emit("promptTemplateChange", { action: "deleted", id });
        return `Template deleted: ${id}`;
      } catch (err) {
        return `Failed to delete template: ${err instanceof Error ? err.message : err}`;
      }
    },
  });

  return {
    prompt_template_list: listTemplates,
    prompt_template_get: getTemplate,
    prompt_template_create: createTemplate,
    prompt_template_fork: forkTemplate,
    prompt_template_update: updateTemplate,
    prompt_template_delete: deleteTemplate,
  };
}
