import crypto from "crypto";
import * as dns from "dns";
import { Resolver } from "dns/promises";
import https from "https";
import axios, { AxiosInstance } from "axios";
import { logOutboundRequestError, logOutboundRequestStart, logOutboundRequestSuccess, redactObject } from "@/lib/http-log";
import type { OkxCredentials, OkxEnv, OkxResponse } from "./types";

const DEMO_FLAG_HEADER = "x-simulated-trading";
const INVALID_DNS_ADDRESSES = new Set(["0.0.0.0", "::", "127.0.0.1", "::1"]);
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_DNS_SERVERS = (process.env.OKX_DNS_FALLBACK_SERVERS || "1.1.1.1,8.8.8.8")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const DNS_OVER_HTTPS_ENDPOINTS = (
  process.env.OKX_DOH_ENDPOINTS ||
  "https://dns.google/resolve,https://cloudflare-dns.com/dns-query"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

type CachedDnsRecord = {
  expiresAt: number;
  addresses: dns.LookupAddress[];
};

type LookupOptionsInput = number | dns.LookupOneOptions | dns.LookupAllOptions;
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

const fallbackResolver = new Resolver();
if (FALLBACK_DNS_SERVERS.length > 0) {
  fallbackResolver.setServers(FALLBACK_DNS_SERVERS);
}

const dnsCache = new Map<string, CachedDnsRecord>();

function isInvalidAddress(address: string) {
  return INVALID_DNS_ADDRESSES.has(address);
}

function pickAddress(addresses: dns.LookupAddress[], familyPreference: number) {
  if (familyPreference === 4 || familyPreference === 6) {
    return addresses.find((item) => item.family === familyPreference) || addresses[0];
  }
  return addresses[0];
}

function toFamilyNumber(family: number | "IPv4" | "IPv6" | undefined) {
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;
  if (family === 4 || family === 6) return family;
  return 0;
}

function normalizeAddresses(addresses: dns.LookupAddress[]) {
  return addresses.filter((item) => !isInvalidAddress(item.address));
}

function getCachedAddresses(hostname: string) {
  const cached = dnsCache.get(hostname);
  if (!cached) return undefined;
  if (cached.expiresAt < Date.now()) {
    dnsCache.delete(hostname);
    return undefined;
  }
  return cached.addresses;
}

function setCachedAddresses(hostname: string, addresses: dns.LookupAddress[]) {
  dnsCache.set(hostname, {
    addresses,
    expiresAt: Date.now() + DNS_CACHE_TTL_MS,
  });
}

async function resolveUsingFallbackDns(hostname: string) {
  const cached = getCachedAddresses(hostname);
  if (cached && cached.length > 0) {
    return cached;
  }

  const [v4, v6] = await Promise.allSettled([fallbackResolver.resolve4(hostname), fallbackResolver.resolve6(hostname)]);
  const addresses: dns.LookupAddress[] = [];

  if (v4.status === "fulfilled") {
    addresses.push(...v4.value.map((address) => ({ address, family: 4 })));
  }
  if (v6.status === "fulfilled") {
    addresses.push(...v6.value.map((address) => ({ address, family: 6 })));
  }

  const usable = normalizeAddresses(addresses);
  if (usable.length > 0) {
    setCachedAddresses(hostname, usable);
  }

  return usable;
}

function parseDohAnswer(answers: unknown, dnsType: number) {
  if (!Array.isArray(answers)) return [];

  return answers
    .map((item) => {
      if (typeof item !== "object" || item === null) return null;
      const record = item as { type?: unknown; data?: unknown };
      if (record.type !== dnsType || typeof record.data !== "string") return null;
      return record.data;
    })
    .filter((item): item is string => Boolean(item));
}

async function resolveUsingDoh(hostname: string) {
  const addresses: dns.LookupAddress[] = [];

  for (const endpoint of DNS_OVER_HTTPS_ENDPOINTS) {
    const query = new URL(endpoint);
    query.searchParams.set("name", hostname);
    query.searchParams.set("type", "A");
    const requestLog = logOutboundRequestStart({
      channel: "network",
      method: "GET",
      url: query.toString(),
      meta: {
        dnsType: "A",
        hostname,
      },
    });

    try {
      const response = await fetch(query.toString(), {
        headers: {
          Accept: "application/dns-json",
        },
        cache: "no-store",
      });

      logOutboundRequestSuccess(requestLog, response.status);

      if (!response.ok) {
        continue;
      }

      const body = (await response.json()) as { Answer?: unknown };
      const ipv4 = parseDohAnswer(body.Answer, 1);

      if (ipv4.length > 0) {
        addresses.push(...ipv4.map((address) => ({ address, family: 4 as const })));
      }
    } catch (error) {
      logOutboundRequestError(requestLog, error);
      // Continue to the next DoH endpoint.
    }
  }

  const usable = normalizeAddresses(addresses);
  if (usable.length > 0) {
    setCachedAddresses(hostname, usable);
  }

  return usable;
}

function createDnsFallbackLookup() {
  return (hostname: string, options: LookupOptionsInput, callback: LookupCallback) => {
    const wantAll = typeof options === "object" && options !== null && "all" in options ? Boolean(options.all) : false;
    const familyPreference =
      typeof options === "number"
        ? options
        : typeof options === "object" && options !== null && "family" in options
          ? toFamilyNumber(options.family)
          : 0;

    dns.lookup(hostname, { all: true, verbatim: false }, (lookupError, addresses) => {
      const usableAddresses = normalizeAddresses(addresses || []);
      if (usableAddresses.length > 0) {
        if (wantAll) {
          callback(null, usableAddresses);
          return;
        }

        const selected = pickAddress(usableAddresses, familyPreference);
        callback(null, selected.address, selected.family);
        return;
      }

      void (async () => {
        try {
          let fallbackAddresses = await resolveUsingFallbackDns(hostname);
          if (fallbackAddresses.length === 0) {
            fallbackAddresses = await resolveUsingDoh(hostname);
          }
          if (fallbackAddresses.length > 0) {
            if (wantAll) {
              callback(null, fallbackAddresses);
              return;
            }

            const selected = pickAddress(fallbackAddresses, familyPreference);
            callback(null, selected.address, selected.family);
            return;
          }
        } catch {
          // Ignore fallback DNS errors and return the original lookup failure.
        }

        const error =
          lookupError ||
          Object.assign(new Error(`DNS 解析失败: ${hostname}`), {
            code: "ENOTFOUND",
          });
        callback(error, wantAll ? [] : "", 0);
      })();
    });
  };
}

const okxHttpsAgent = new https.Agent({
  keepAlive: true,
  lookup: createDnsFallbackLookup(),
});

export class OkxClient {
  private http: AxiosInstance;

  constructor(
    private readonly env: OkxEnv,
    private readonly credentials?: OkxCredentials,
  ) {
    const baseURL =
      env === "live"
        ? process.env.OKX_LIVE_BASE_URL || "https://www.okx.com"
        : process.env.OKX_DEMO_BASE_URL || "https://www.okx.com";

    this.http = axios.create({
      baseURL,
      timeout: 10000,
      httpsAgent: okxHttpsAgent,
      headers: {
        "Content-Type": "application/json",
        ...(env === "demo" ? { [DEMO_FLAG_HEADER]: "1" } : {}),
      },
    });

    this.http.interceptors.request.use((config) => {
      const url = `${config.baseURL || ""}${config.url || ""}`;
      const handle = logOutboundRequestStart({
        channel: "okx",
        method: (config.method || "GET").toUpperCase(),
        url,
        meta: {
          params: config.params,
          data: config.data,
          headers: config.headers,
        },
      });

      (config as typeof config & { __requestLogHandle?: unknown }).__requestLogHandle = handle;
      return config;
    });

    this.http.interceptors.response.use(
      (response) => {
        const handle = (response.config as typeof response.config & { __requestLogHandle?: ReturnType<typeof logOutboundRequestStart> })
          .__requestLogHandle;
        if (handle) {
          logOutboundRequestSuccess(handle, response.status, {
            response: redactObject(response.data),
          });
        }
        return response;
      },
      (error) => {
        const config = error?.config as
          | (typeof error.config & { __requestLogHandle?: ReturnType<typeof logOutboundRequestStart> })
          | undefined;
        const handle = config?.__requestLogHandle;
        if (handle) {
          logOutboundRequestError(handle, error, {
            status: error?.response?.status || null,
            response: redactObject(error?.response?.data),
          });
        }
        return Promise.reject(error);
      },
    );
  }

  private sign(message: string) {
    if (!this.credentials?.apiSecret) return "";
    return crypto
      .createHmac("sha256", this.credentials.apiSecret)
      .update(message)
      .digest("base64");
  }

  private buildAuthHeaders(method: string, path: string, body?: object | string) {
    if (!this.credentials) return {};
    const ts = new Date().toISOString();
    const payload = body ? (typeof body === "string" ? body : JSON.stringify(body)) : "";
    const prehash = `${ts}${method.toUpperCase()}${path}${payload}`;

    return {
      "OK-ACCESS-KEY": this.credentials.apiKey,
      "OK-ACCESS-SIGN": this.sign(prehash),
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": this.credentials.passphrase,
      ...(this.env === "demo" ? { [DEMO_FLAG_HEADER]: "1" } : {}),
    };
  }

  private buildSignedPath(path: string, params?: Record<string, string | number>) {
    if (!params || Object.keys(params).length === 0) {
      return path;
    }

    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      search.append(key, String(value));
    }

    const query = search.toString();
    return query ? `${path}?${query}` : path;
  }

  async getPublic<T>(path: string, params?: Record<string, string | number>) {
    const response = await this.http.get<OkxResponse<T>>(path, { params });
    return response.data;
  }

  async getPrivate<T>(path: string, params?: Record<string, string | number>) {
    const signedPath = this.buildSignedPath(path, params);
    const headers = this.buildAuthHeaders("GET", signedPath);
    const response = await this.http.get<OkxResponse<T>>(path, { params, headers });
    return response.data;
  }

  async postPrivate<T>(path: string, body: object) {
    const headers = this.buildAuthHeaders("POST", path, body);
    const response = await this.http.post<OkxResponse<T>>(path, body, { headers });
    return response.data;
  }
}
