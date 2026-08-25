/**
 * Busca de colaboradores Viasoft no Active Directory (`search_ad_users`).
 *
 * Sem `AD_URL` configurado, cai para o adapter mock lendo um JSON local — útil para
 * desenvolvimento e testes sem depender de infraestrutura de AD real. Para produção,
 * implemente `LdapDirectoryAdapter` (ex: com a lib `ldapts`) preservando a mesma interface.
 */

import { readFile } from "node:fs/promises";

export interface AdUser {
  name: string;
  username: string;
  email: string;
  department?: string;
  title?: string;
}

export interface DirectoryAdapter {
  search(query: string, limit: number): Promise<AdUser[]>;
}

const MOCK_FILE = process.env.AD_MOCK_FILE ?? "./data/local/ad_users.json";

class MockDirectoryAdapter implements DirectoryAdapter {
  async search(query: string, limit: number): Promise<AdUser[]> {
    const q = query.trim().toLowerCase();
    let users: AdUser[] = [];
    try {
      const raw = await readFile(MOCK_FILE, "utf8");
      users = JSON.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const filtered = q
      ? users.filter(
          (u) =>
            u.name.toLowerCase().includes(q) ||
            u.username.toLowerCase().includes(q) ||
            u.email.toLowerCase().includes(q),
        )
      : users;
    return filtered.slice(0, limit);
  }
}

class LdapDirectoryAdapter implements DirectoryAdapter {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_query: string, _limit: number): Promise<AdUser[]> {
    throw new Error(
      "LdapDirectoryAdapter não implementado. Configure AD_URL/AD_BIND_DN/AD_BIND_PASSWORD/AD_BASE_DN " +
        "e implemente a busca real (ex: com a lib `ldapts`) antes de usar em produção.",
    );
  }
}

function selectAdapter(): DirectoryAdapter {
  return process.env.AD_URL ? new LdapDirectoryAdapter() : new MockDirectoryAdapter();
}

const adapter = selectAdapter();

export async function searchAdUsers(query: string, limit = 10): Promise<AdUser[]> {
  return adapter.search(query, limit);
}
