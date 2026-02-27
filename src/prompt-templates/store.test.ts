import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PromptTemplateStore, MAX_TEMPLATE_NAME_LENGTH, MAX_TEMPLATE_CONTENT_LENGTH } from "./store.js";
import { BUILTIN_TEMPLATES } from "./builtins/index.js";

let store: PromptTemplateStore;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "prompt-template-store-test-"));
  store = await PromptTemplateStore.create(join(tmpDir, "test.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("PromptTemplateStore — CRUD", () => {
  it("returns empty list when no templates exist", () => {
    expect(store.listPromptTemplates()).toEqual([]);
  });

  it("creates and retrieves a template", () => {
    const tpl = store.createPromptTemplate({
      name: "My Template",
      role: "worker",
      content: "You are a helpful assistant.",
    });
    expect(tpl.name).toBe("My Template");
    expect(tpl.role).toBe("worker");
    expect(tpl.content).toBe("You are a helpful assistant.");
    expect(tpl.builtin).toBe(false);
    expect(tpl.description).toBe("");
    expect(tpl.id).toBeTruthy();

    const found = store.getPromptTemplateById(tpl.id);
    expect(found).toEqual(tpl);
  });

  it("creates a template with optional description", () => {
    const tpl = store.createPromptTemplate({
      name: "Described",
      role: "orchestrator",
      content: "Lead the team.",
      description: "A team leader template",
    });
    expect(tpl.description).toBe("A team leader template");
  });

  it("creates a template with a caller-provided id", () => {
    const tpl = store.createPromptTemplate({
      id: "my-custom-id",
      name: "Custom ID",
      role: "worker",
      content: "Hello",
    });
    expect(tpl.id).toBe("my-custom-id");
    expect(store.getPromptTemplateById("my-custom-id")).toEqual(tpl);
  });

  it("lists templates sorted builtins-first then by creation order", () => {
    store.seedBuiltins(BUILTIN_TEMPLATES);
    store.createPromptTemplate({ name: "User A", role: "worker", content: "a" });
    store.createPromptTemplate({ name: "User B", role: "orchestrator", content: "b" });

    const list = store.listPromptTemplates();
    // Builtins come first (builtin DESC), then user-created in creation order
    const builtinCount = BUILTIN_TEMPLATES.length;
    expect(list.length).toBe(builtinCount + 2);
    for (let i = 0; i < builtinCount; i++) {
      expect(list[i].builtin).toBe(true);
    }
    expect(list[builtinCount].name).toBe("User A");
    expect(list[builtinCount + 1].name).toBe("User B");
  });

  it("updates a user-created template", () => {
    const tpl = store.createPromptTemplate({
      name: "Original",
      role: "worker",
      content: "Original content",
    });
    const updated = store.updatePromptTemplate(tpl.id, {
      name: "Renamed",
      content: "New content",
    });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.content).toBe("New content");
    expect(updated?.role).toBe("worker"); // unchanged

    const fetched = store.getPromptTemplateById(tpl.id);
    expect(fetched?.name).toBe("Renamed");
    expect(fetched?.content).toBe("New content");
  });

  it("returns null when updating a non-existent template", () => {
    expect(store.updatePromptTemplate("nonexistent", { name: "X" })).toBeNull();
  });

  it("deletes a user-created template", () => {
    const tpl = store.createPromptTemplate({
      name: "ToDelete",
      role: "worker",
      content: "bye",
    });
    expect(store.deletePromptTemplate(tpl.id)).toBe(true);
    expect(store.getPromptTemplateById(tpl.id)).toBeNull();
  });

  it("returns false when deleting a non-existent template", () => {
    expect(store.deletePromptTemplate("nonexistent")).toBe(false);
  });

  it("returns null for non-existent template", () => {
    expect(store.getPromptTemplateById("nope")).toBeNull();
  });
});

describe("PromptTemplateStore — validation", () => {
  it("rejects empty name", () => {
    expect(() =>
      store.createPromptTemplate({ name: "", role: "worker", content: "x" }),
    ).toThrow(/name is required/);
  });

  it("rejects whitespace-only name", () => {
    expect(() =>
      store.createPromptTemplate({ name: "   ", role: "worker", content: "x" }),
    ).toThrow(/name is required/);
  });

  it("rejects name exceeding max length", () => {
    const longName = "a".repeat(MAX_TEMPLATE_NAME_LENGTH + 1);
    expect(() =>
      store.createPromptTemplate({ name: longName, role: "worker", content: "x" }),
    ).toThrow(/maximum length/);
  });

  it("rejects content exceeding max length", () => {
    const longContent = "a".repeat(MAX_TEMPLATE_CONTENT_LENGTH + 1);
    expect(() =>
      store.createPromptTemplate({ name: "Big", role: "worker", content: longContent }),
    ).toThrow(/maximum length/);
  });

  it("rejects invalid role", () => {
    expect(() =>
      store.createPromptTemplate({ name: "Bad", role: "manager" as "worker", content: "x" }),
    ).toThrow(/must be 'orchestrator' or 'worker'/);
  });

  it("enforces unique template names", () => {
    store.createPromptTemplate({ name: "Unique", role: "worker", content: "a" });
    expect(() =>
      store.createPromptTemplate({ name: "Unique", role: "worker", content: "b" }),
    ).toThrow(/already exists/);
  });

  it("enforces unique names on update", () => {
    store.createPromptTemplate({ name: "First", role: "worker", content: "a" });
    const second = store.createPromptTemplate({ name: "Second", role: "worker", content: "b" });
    expect(() =>
      store.updatePromptTemplate(second.id, { name: "First" }),
    ).toThrow(/already exists/);
  });

  it("validates fields on update", () => {
    const tpl = store.createPromptTemplate({ name: "OK", role: "worker", content: "x" });
    expect(() =>
      store.updatePromptTemplate(tpl.id, { role: "boss" as "worker" }),
    ).toThrow(/must be 'orchestrator' or 'worker'/);
  });
});

describe("PromptTemplateStore — builtins", () => {
  it("seeds built-in templates", () => {
    store.seedBuiltins(BUILTIN_TEMPLATES);
    const list = store.listPromptTemplates();
    expect(list.length).toBe(BUILTIN_TEMPLATES.length);
    for (const tpl of list) {
      expect(tpl.builtin).toBe(true);
    }
  });

  it("upserts built-in templates on re-seed", () => {
    store.seedBuiltins(BUILTIN_TEMPLATES);
    const before = store.getPromptTemplateById(BUILTIN_TEMPLATES[0].id);

    // Re-seed with modified content
    const modified = BUILTIN_TEMPLATES.map((t) => ({ ...t, content: "Updated: " + t.content }));
    store.seedBuiltins(modified);

    const after = store.getPromptTemplateById(BUILTIN_TEMPLATES[0].id);
    expect(after?.content).toContain("Updated:");
    // ID and createdAt preserved
    expect(after?.id).toBe(before?.id);
    expect(after?.createdAt).toBe(before?.createdAt);
    // updatedAt should be refreshed
    expect(after?.updatedAt).toBeGreaterThanOrEqual(before!.updatedAt);
    // Total count unchanged
    expect(store.listPromptTemplates().length).toBe(BUILTIN_TEMPLATES.length);
  });

  it("rejects update of a built-in template", () => {
    store.seedBuiltins(BUILTIN_TEMPLATES);
    const builtin = store.getPromptTemplateById(BUILTIN_TEMPLATES[0].id)!;
    expect(() =>
      store.updatePromptTemplate(builtin.id, { name: "Hacked" }),
    ).toThrow(/Cannot modify a built-in template/);
  });

  it("rejects deletion of a built-in template", () => {
    store.seedBuiltins(BUILTIN_TEMPLATES);
    const builtin = store.getPromptTemplateById(BUILTIN_TEMPLATES[0].id)!;
    expect(() => store.deletePromptTemplate(builtin.id)).toThrow(/Cannot delete a built-in template/);
  });

  it("forks a built-in template into a user-editable copy", () => {
    store.seedBuiltins(BUILTIN_TEMPLATES);
    const builtin = store.getPromptTemplateById(BUILTIN_TEMPLATES[0].id)!;

    const forked = store.forkPromptTemplate(builtin.id);
    expect(forked).not.toBeNull();
    expect(forked?.builtin).toBe(false);
    expect(forked?.name).toBe(`${builtin.name} (Copy)`);
    expect(forked?.role).toBe(builtin.role);
    expect(forked?.content).toBe(builtin.content);
    expect(forked?.description).toBe(builtin.description);
  });

  it("uses numbered suffixes when a fork name already exists", () => {
    store.seedBuiltins(BUILTIN_TEMPLATES);
    const builtin = store.getPromptTemplateById(BUILTIN_TEMPLATES[0].id)!;
    store.createPromptTemplate({
      name: `${builtin.name} (Copy)`,
      role: builtin.role,
      content: "existing copy",
    });

    const forked = store.forkPromptTemplate(builtin.id);
    expect(forked?.name).toBe(`${builtin.name} (Copy 2)`);
  });

  it("returns null when forking a missing template", () => {
    expect(store.forkPromptTemplate("missing-template")).toBeNull();
  });

  it("allows deleting user templates even after builtins are seeded", () => {
    store.seedBuiltins(BUILTIN_TEMPLATES);
    const user = store.createPromptTemplate({ name: "User", role: "worker", content: "x" });
    expect(store.deletePromptTemplate(user.id)).toBe(true);
    // Builtins still intact
    expect(store.listPromptTemplates().length).toBe(BUILTIN_TEMPLATES.length);
  });
});
