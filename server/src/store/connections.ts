import type { Db } from "../db.js";
import { nowIso } from "../lib/ids.js";
import type { Vault } from "../security/vault.js";

export type ProviderId = "slack" | "notion";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scopes: string[];
  accountId?: string;
  accountName?: string;
}

/** Connection metadata that is safe to return to the browser. */
export interface ConnectionInfo {
  provider: ProviderId;
  accountId: string | null;
  accountName: string | null;
  scopes: string[];
  expiresAt: number | null;
  connectedAt: string;
  updatedAt: string;
}

interface Row {
  provider: ProviderId;
  account_id: string | null;
  account_name: string | null;
  scopes: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: number | null;
  created_at: string;
  updated_at: string;
}

const aad = (workspaceId: string, provider: ProviderId) => `${workspaceId}:${provider}`;

/**
 * Every method takes the workspace id first; there is deliberately no way to
 * read a connection without naming the tenant it belongs to.
 */
export class ConnectionStore {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
  ) {}

  save(workspaceId: string, provider: ProviderId, tokens: TokenSet): void {
    const now = nowIso();
    const ad = aad(workspaceId, provider);
    this.db
      .prepare(
        `INSERT INTO connections
           (workspace_id, provider, account_id, account_name, scopes, access_token_enc, refresh_token_enc, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, provider) DO UPDATE SET
           account_id = excluded.account_id,
           account_name = excluded.account_name,
           scopes = excluded.scopes,
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        workspaceId,
        provider,
        tokens.accountId ?? null,
        tokens.accountName ?? null,
        tokens.scopes.join(" "),
        this.vault.encrypt(tokens.accessToken, ad),
        tokens.refreshToken ? this.vault.encrypt(tokens.refreshToken, ad) : null,
        tokens.expiresAt ?? null,
        now,
        now,
      );
  }

  getTokens(workspaceId: string, provider: ProviderId): TokenSet | undefined {
    const row = this.row(workspaceId, provider);
    if (!row) return undefined;
    const ad = aad(workspaceId, provider);
    return {
      accessToken: this.vault.decrypt(row.access_token_enc, ad),
      refreshToken: row.refresh_token_enc ? this.vault.decrypt(row.refresh_token_enc, ad) : undefined,
      expiresAt: row.expires_at ?? undefined,
      scopes: row.scopes ? row.scopes.split(" ") : [],
      accountId: row.account_id ?? undefined,
      accountName: row.account_name ?? undefined,
    };
  }

  list(workspaceId: string): ConnectionInfo[] {
    const rows = this.db
      .prepare("SELECT * FROM connections WHERE workspace_id = ? ORDER BY provider")
      .all(workspaceId) as unknown as Row[];
    return rows.map(toInfo);
  }

  delete(workspaceId: string, provider: ProviderId): boolean {
    const result = this.db
      .prepare("DELETE FROM connections WHERE workspace_id = ? AND provider = ?")
      .run(workspaceId, provider);
    return result.changes > 0;
  }

  private row(workspaceId: string, provider: ProviderId): Row | undefined {
    return this.db
      .prepare("SELECT * FROM connections WHERE workspace_id = ? AND provider = ?")
      .get(workspaceId, provider) as Row | undefined;
  }
}

function toInfo(row: Row): ConnectionInfo {
  return {
    provider: row.provider,
    accountId: row.account_id,
    accountName: row.account_name,
    scopes: row.scopes ? row.scopes.split(" ") : [],
    expiresAt: row.expires_at,
    connectedAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
