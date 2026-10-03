import type { lookup } from "node:dns/promises";
import { describe, expect, it, vi } from "vitest";
import { WebResearchService } from "../src/main/web-research";

const publicLookup = (async () => [{
  address: "93.184.216.34",
  family: 4,
}]) as unknown as typeof lookup;

describe("WebResearchService", () => {
  it("searches and reads bounded public sources", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("https://html.duckduckgo.com/html/")) {
        return new Response(
          '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Frelease&amp;rut=abc">Example &amp; Release</a>',
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      if (url === "https://example.com/release") {
        return new Response(
          "<html><head><title>Release Notes</title><style>hidden</style></head><body><script>ignore()</script><h1>Version 7</h1><p>Released today.</p></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WebResearchService({
      fetch: fetchMock,
      lookup: publicLookup,
    });

    await expect(service.research("TypeScript 7", 1)).resolves.toEqual({
      query: "TypeScript 7",
      readableSourceCount: 1,
      sources: [{
        title: "Release Notes",
        url: "https://example.com/release",
        content: "Version 7 Released today.",
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects local, private, and authenticated URLs", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = new WebResearchService({
      fetch: fetchMock,
      lookup: publicLookup,
    });

    await expect(service.fetchPage("http://localhost/admin")).rejects.toThrow(
      "Local and private network URLs",
    );
    await expect(service.fetchPage("http://127.0.0.1/admin")).rejects.toThrow(
      "Local and private network URLs",
    );
    await expect(
      service.fetchPage("https://user:password@example.com/"),
    ).rejects.toThrow("Authenticated URLs");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects hostnames resolving to private addresses", async () => {
    const privateLookup = (async () => [{
      address: "192.168.1.20",
      family: 4,
    }]) as unknown as typeof lookup;
    const fetchMock = vi.fn<typeof fetch>();
    const service = new WebResearchService({
      fetch: fetchMock,
      lookup: privateLookup,
    });

    await expect(
      service.fetchPage("https://internal.example/"),
    ).rejects.toThrow("Local and private network URLs");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates redirects before following them", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      }),
    );
    const service = new WebResearchService({
      fetch: fetchMock,
      lookup: publicLookup,
    });

    await expect(
      service.fetchPage("https://example.com/redirect"),
    ).rejects.toThrow("Local and private network URLs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects downloads and truncates oversized text responses", async () => {
    const downloadService = new WebResearchService({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("binary", {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
      lookup: publicLookup,
    });
    await expect(
      downloadService.fetchPage("https://example.com/archive.zip"),
    ).rejects.toThrow("Unsupported public page content type");

    const oversizedService = new WebResearchService({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("x".repeat(1_000_001), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
      lookup: publicLookup,
    });
    const oversized = await oversizedService.fetchPage(
      "https://example.com/large",
    );
    expect(oversized.content).toHaveLength(5_000);
  });
});
