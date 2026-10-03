import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const USER_AGENT = "Spectre-Web-Research/1.0";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_PAGE_CHARACTERS = 5_000;
const MAX_SEARCH_RESULTS = 8;
const MAX_RESEARCH_SOURCES = 3;

export interface WebSearchResult {
  title: string;
  url: string;
}

export interface WebPageResult {
  title: string;
  url: string;
  content: string;
}

export interface WebResearchSource extends WebSearchResult {
  content?: string;
  error?: string;
}

export interface WebResearchResult {
  query: string;
  readableSourceCount: number;
  sources: WebResearchSource[];
}

export interface WebResearchOptions {
  fetch?: typeof fetch;
  lookup?: typeof lookup;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ");
}

function htmlToText(value: string): string {
  return decodeHtml(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

function readableHtmlRegion(value: string): string {
  return value.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? value.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? value.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    ?? value;
}

function isReadableContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith("text/html")
    || normalized.startsWith("text/plain")
    || normalized.startsWith("application/xhtml+xml")
    || normalized.startsWith("application/json");
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateIpv4(mapped);
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff");
}

function parseSearchResults(html: string, limit: number): WebSearchResult[] {
  const results: Array<WebSearchResult & { index: number; quality: number }> = [];
  const pattern =
    /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const rawUrl = decodeHtml(match[1]);
    const redirect = new URL(rawUrl, "https://duckduckgo.com");
    const target = redirect.searchParams.get("uddg") ?? redirect.toString();
    const url = new URL(target);
    if (!["http:", "https:"].includes(url.protocol)) continue;
    const title = htmlToText(match[2]);
    if (!title) continue;
    const hostname = url.hostname.toLowerCase();
    const quality =
      (
        hostname.endsWith(".gov")
        || hostname.endsWith(".edu")
        || hostname === "wikipedia.org"
        || hostname.endsWith(".wikipedia.org")
        || hostname === "britannica.com"
        || hostname.endsWith(".britannica.com")
        || hostname === "who.int"
        || hostname.endsWith(".who.int")
      )
        ? 20
        : (
            hostname === "researchgate.net"
            || hostname.endsWith(".researchgate.net")
            || url.pathname.toLowerCase().endsWith(".pdf")
          )
          ? -10
          : 0;
    results.push({
      title,
      url: url.toString(),
      index: results.length,
      quality,
    });
  }
  return results
    .sort((left, right) =>
      right.quality - left.quality || left.index - right.index)
    .slice(0, limit)
    .map(({ title, url }) => ({ title, url }));
}

export class WebResearchService {
  private readonly fetchImpl: typeof fetch;
  private readonly lookupImpl: typeof lookup;

  constructor(options: WebResearchOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.lookupImpl = options.lookup ?? lookup;
  }

  async search(query: string, limit = MAX_SEARCH_RESULTS): Promise<WebSearchResult[]> {
    const normalizedQuery = query.replace(/\s+/g, " ").trim();
    if (!normalizedQuery) throw new Error("Web search query cannot be empty");
    if (normalizedQuery.length > 500) {
      throw new Error("Web search query cannot exceed 500 characters");
    }
    const boundedLimit = Math.min(
      Math.max(Math.trunc(limit), 1),
      MAX_SEARCH_RESULTS,
    );
    const endpoint = new URL(SEARCH_ENDPOINT);
    endpoint.searchParams.set("q", normalizedQuery);
    const response = await this.fetchPublic(endpoint);
    const results = parseSearchResults(response.body, boundedLimit);
    if (results.length === 0) {
      throw new Error("Public web search returned no readable results");
    }
    return results;
  }

  async fetchPage(rawUrl: string): Promise<WebPageResult> {
    const response = await this.fetchPublic(new URL(rawUrl));
    const contentType = response.contentType.toLowerCase();
    const titleMatch = response.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch
      ? htmlToText(titleMatch[1])
      : new URL(response.url).hostname;
    const content = contentType.startsWith("text/html")
      || contentType.startsWith("application/xhtml+xml")
      ? htmlToText(readableHtmlRegion(response.body))
      : response.body.replace(/\s+/g, " ").trim();
    if (!content) throw new Error("Public page contained no readable text");
    return {
      title,
      url: response.url,
      content: content.slice(0, MAX_PAGE_CHARACTERS),
    };
  }

  async research(
    query: string,
    limit = MAX_RESEARCH_SOURCES,
  ): Promise<WebResearchResult> {
    const boundedLimit = Math.min(
      Math.max(Math.trunc(limit), 1),
      MAX_RESEARCH_SOURCES,
    );
    const results = await this.search(query, MAX_SEARCH_RESULTS);
    const sources: WebResearchSource[] = [];
    let readableSourceCount = 0;
    for (const result of results) {
      try {
        sources.push({
          ...result,
          ...(await this.fetchPage(result.url)),
        });
        readableSourceCount += 1;
      } catch (error) {
        sources.push({
          ...result,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (readableSourceCount >= boundedLimit) break;
    }
    return {
      query: query.trim(),
      readableSourceCount,
      sources,
    };
  }

  private async assertPublicUrl(url: URL): Promise<void> {
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Web research permits only HTTP and HTTPS URLs");
    }
    if (url.username || url.password) {
      throw new Error("Authenticated URLs are not permitted");
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      !hostname
      || hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
    ) {
      throw new Error("Local and private network URLs are not permitted");
    }
    if (isIP(hostname)) {
      if (isPrivateIp(hostname)) {
        throw new Error("Local and private network URLs are not permitted");
      }
      return;
    }
    const addresses = await this.lookupImpl(hostname, {
      all: true,
      verbatim: true,
    });
    if (
      addresses.length === 0
      || addresses.some((entry) => isPrivateIp(entry.address))
    ) {
      throw new Error("Local and private network URLs are not permitted");
    }
  }

  private async fetchPublic(
    initialUrl: URL,
  ): Promise<{ body: string; contentType: string; url: string }> {
    let url = initialUrl;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await this.assertPublicUrl(url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "text/html,text/plain,application/xhtml+xml,application/json",
            "User-Agent": USER_AGENT,
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error("Public web request timed out");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Public web redirect omitted a location");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Public web request returned HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "text/plain";
      if (!isReadableContentType(contentType)) {
        throw new Error(`Unsupported public page content type: ${contentType}`);
      }
      return {
        body: await this.readBoundedBody(response),
        contentType,
        url: response.url || url.toString(),
      };
    }
    throw new Error("Public web request exceeded five redirects");
  }

  private async readBoundedBody(response: Response): Promise<string> {
    if (!response.body) throw new Error("Public web response had no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - bytes;
      if (value.byteLength > remaining) {
        body += decoder.decode(value.slice(0, remaining), { stream: true });
        bytes = MAX_RESPONSE_BYTES;
        await reader.cancel();
        break;
      }
      bytes += value.byteLength;
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  }
}

export const webResearchService = new WebResearchService();
