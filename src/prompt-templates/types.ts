export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  role: "orchestrator" | "worker";
  content: string;
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}
