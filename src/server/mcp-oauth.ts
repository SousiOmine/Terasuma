import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { auth } from "@modelcontextprotocol/client";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/**
 * OAuth で使う値（クライアント登録・トークン・PKCE の検証子）を文字列で保存する口。
 * 認可の開始とコールバックは別々の要求になるため、値はプロセスをまたいで残す必要がある。
 */
export type OAuthStorage = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  keys(): string[];
};

/** 認可サーバーごとに分けて保存する鍵。 */
const key = {
  client: (issuer: string) => `client:${issuer}`,
  tokens: (issuer: string) => `tokens:${issuer}`,
  lastIssuer: "lastIssuer",
  codeVerifier: "codeVerifier",
  discovery: "discovery",
};

/**
 * 保存するクライアント情報。
 * 登録した redirect_uri も一緒に持ち、待ち受けポートが変わったら登録し直せるようにする。
 */
type StoredClientInformation = StoredOAuthClientInformation & { redirectUri?: string };

/**
 * JSON ファイル 1 つに保存する OAuthStorage。
 * トークンを含むため、ディレクトリとファイルの権限は本人だけに絞る。
 * 読めないファイルは黙って作り直さず、そのまま失敗させる（トークンを失ったことに気づけるように）。
 */
export function createFileOAuthStorage(path: string): OAuthStorage {
  let cache: Record<string, string> | null = null;

  function load(): Record<string, string> {
    if (cache !== null) return cache;
    if (!existsSync(path)) {
      cache = {};
      return cache;
    }

    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${path} の内容は JSON のオブジェクトにしてください`);
    }
    cache = raw as Record<string, string>;
    return cache;
  }

  function flush(data: Record<string, string>): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);

    cache = data;
  }

  return {
    get(name) {
      return load()[name];
    },
    set(name, value) {
      flush({ ...load(), [name]: value });
    },
    delete(name) {
      const data = { ...load() };
      delete data[name];
      flush(data);
    },
    keys() {
      return Object.keys(load());
    },
  };
}

/** 認可の状態を引き継ぐための state。コールバックをどのサーバーのものか判別する印でもある。 */
const STATE_PREFIX = "terasuma";

/** 認可コードを受け取るパス。実際の URL は待ち受けているホストとポートで組み立てる。 */
export const OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

export function stateFor(serverId: string): string {
  return `${STATE_PREFIX}.${serverId}.${crypto.randomUUID()}`;
}

/** state からサーバー id を取り出す。形が違えば null（知らない state のコールバックとして弾く）。 */
export function serverIdFromState(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 3 || parts[0] !== STATE_PREFIX) return null;
  return parts[1] ?? null;
}

/**
 * 1 つの MCP サーバー分の OAuth クライアント。
 *
 * 認可サーバーの探索・動的クライアント登録・PKCE・トークンの更新は公式 SDK の auth() が行い、
 * ここはその入出力（保存と redirect URL の受け取り）だけを担う。
 * クライアントの同一性は設定ではなく登録で決まるため、saveClientInformation を実装して
 * 動的クライアント登録を有効にしてある（自分で登録した情報を持ち込む必要がない）。
 */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly serverId: string;
  private readonly callbackUrl: URL;
  private readonly storage: OAuthStorage;
  /** redirectToAuthorization に渡された URL。認可の開始時にここから取り出す。 */
  private authorizationUrl: string | null = null;

  constructor(options: { serverId: string; redirectUrl: URL; storage: OAuthStorage }) {
    this.serverId = options.serverId;
    this.callbackUrl = options.redirectUrl;
    this.storage = options.storage;
  }

  get redirectUrl(): string {
    return this.callbackUrl.toString();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Terasuma",
      redirect_uris: [this.callbackUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return stateFor(this.serverId);
  }

  /**
   * 登録済みのクライアント情報。未登録なら undefined を返し、SDK に登録させる。
   * 登録した redirect_uri が今のコールバック先と違う場合は、登録済みとして使えない
   * （待ち受けポートが変わったときに、古い登録のまま認可へ進まないようにするため）。
   */
  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const issuer = ctx?.issuer;
    if (issuer === undefined) return undefined;

    const stored = this.read<StoredClientInformation>(key.client(issuer));
    if (stored === undefined) return undefined;

    return stored.redirectUri === this.callbackUrl.toString() ? stored : undefined;
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): void {
    const issuer = clientInformation.issuer ?? ctx?.issuer;
    if (issuer === undefined) throw new Error("クライアント情報を保存する認可サーバーが分かりません");

    const stored: StoredClientInformation = { ...clientInformation, issuer, redirectUri: this.callbackUrl.toString() };
    this.storage.set(key.client(issuer), JSON.stringify(stored));
  }

  /** トークン。issuer が分かる読み出しはその分だけ、分からない読み出しは直近のものを返す。 */
  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    const issuer = ctx?.issuer ?? this.storage.get(key.lastIssuer);
    if (issuer === undefined) return undefined;

    return this.read<StoredOAuthTokens>(key.tokens(issuer));
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    const issuer = tokens.issuer ?? ctx?.issuer;
    if (issuer === undefined) throw new Error("トークンを保存する認可サーバーが分かりません");

    this.storage.set(key.tokens(issuer), JSON.stringify({ ...tokens, issuer }));
    this.storage.set(key.lastIssuer, issuer);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.storage.set(key.codeVerifier, codeVerifier);
  }

  codeVerifier(): string {
    const verifier = this.storage.get(key.codeVerifier);
    if (verifier === undefined)
      throw new Error("認可コードを引き換えるための検証子がありません（認可をやり直してください）");
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.storage.set(key.discovery, JSON.stringify(state));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.read<OAuthDiscoveryState>(key.discovery);
  }

  /** 認可画面の URL。開くのは呼び出し側（画面）の役目なので、ここでは控えるだけにする。 */
  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl.toString();
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const prefixes: string[] = [];
    if (scope === "client" || scope === "all") prefixes.push("client:");
    if (scope === "tokens" || scope === "all") prefixes.push("tokens:");
    if (scope === "all") prefixes.push("lastIssuer");
    if (scope === "verifier" || scope === "all") prefixes.push(key.codeVerifier);
    if (scope === "discovery" || scope === "all") prefixes.push(key.discovery);

    for (const name of this.storage.keys()) {
      if (prefixes.some((prefix) => name === prefix || name.startsWith(prefix))) this.storage.delete(name);
    }
  }

  /** 認可のために開く URL。まだ受け取っていなければ null。 */
  takeAuthorizationUrl(): string | null {
    return this.authorizationUrl;
  }

  private read<T>(name: string): T | undefined {
    const raw = this.storage.get(name);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
}

/** MCP サーバーの接続に必要な OAuth の材料。 */
export type McpOAuthMaterial = {
  serverId: string;
  serverUrl: string;
  /** 認可コードの受け取り先。実際に待ち受けているアドレスにすること。 */
  redirectUrl: URL;
  storage: OAuthStorage;
};

/** 認可の開始結果。認可が要らない（既存のトークンで足りる）こともある。 */
export type AuthorizationStart = { kind: "authorized" } | { kind: "redirect"; url: string };

/**
 * 認可を始める。既存のトークンで足りれば何も開かずに authorized を返し、
 * 要る場合はブラウザで開くための URL を返す（PKCE の検証子と探索結果は storage に残る）。
 */
export async function startMcpAuthorization(material: McpOAuthMaterial): Promise<AuthorizationStart> {
  const provider = new McpOAuthProvider(material);
  const result = await auth(provider, { serverUrl: material.serverUrl });
  if (result === "AUTHORIZED") return { kind: "authorized" };

  const url = provider.takeAuthorizationUrl();
  if (url === null) throw new Error("認可 URL を受け取れませんでした");
  return { kind: "redirect", url };
}

/** コールバックで受け取った認可コードをトークンに交換する。 */
export async function finishMcpAuthorization(
  material: McpOAuthMaterial & { code: string; iss: string | null },
): Promise<void> {
  const provider = new McpOAuthProvider(material);
  const result = await auth(provider, {
    serverUrl: material.serverUrl,
    authorizationCode: material.code,
    ...(material.iss === null ? {} : { iss: material.iss }),
  });

  if (result !== "AUTHORIZED") throw new Error(`認可を完了できませんでした（${result}）`);
}
