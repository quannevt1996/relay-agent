import type { Db } from "../db.js";
import { newId, nowIso } from "../lib/ids.js";

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export class WorkspaceStore {
  constructor(private readonly db: Db) {}

  create(name = "My workspace", id = newId("ws")): Workspace {
    const workspace = { id, name, createdAt: nowIso() };
    this.db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(id, name, workspace.createdAt);
    return workspace;
  }

  get(id: string): Workspace | undefined {
    const row = this.db.prepare("SELECT id, name, created_at FROM workspaces WHERE id = ?").get(id) as
      | { id: string; name: string; created_at: string }
      | undefined;
    return row && { id: row.id, name: row.name, createdAt: row.created_at };
  }

  getOrCreate(id: string, name?: string): Workspace {
    return this.get(id) ?? this.create(name, id);
  }
}
