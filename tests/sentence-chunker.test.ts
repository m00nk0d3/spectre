import { describe, expect, it } from "vitest";
import { SentenceChunker } from "../src/main/sentence-chunker";

describe("SentenceChunker", () => {
  it("emits complete sentences without corrupting punctuation", () => {
    const chunker = new SentenceChunker();

    expect(chunker.push("Olá, tudo bem? Próxima")).toEqual(["Olá, tudo bem?"]);
    expect(chunker.flush()).toEqual(["Próxima"]);
  });

  it("waits for strategic commas on longer clauses", () => {
    const chunker = new SentenceChunker({ minCommaChunkLength: 20 });

    expect(chunker.push("Esta frase curta, continua")).toEqual([]);
    expect(chunker.push(" por mais algum tempo, e segue")).toEqual([
      "Esta frase curta, continua por mais algum tempo,",
    ]);
  });

  it("splits oversized text at a word boundary", () => {
    const chunker = new SentenceChunker({ maxChunkLength: 20 });
    const chunks = chunker.push("uma frase bastante longa sem pontuação alguma");

    expect(chunks).toEqual(["uma frase bastante", "longa sem pontuação"]);
    expect(chunker.flush()).toEqual(["alguma"]);
  });

  it("emits terminal punctuation as soon as it arrives", () => {
    const chunker = new SentenceChunker();

    expect(chunker.push("Resposta completa.")).toEqual(["Resposta completa."]);
    expect(chunker.push(" Outra:")).toEqual(["Outra:"]);
  });
});
