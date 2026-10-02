export interface SentenceChunkerOptions {
  minCommaChunkLength?: number;
  maxChunkLength?: number;
}

export class SentenceChunker {
  private buffer = "";
  private readonly minCommaChunkLength: number;
  private readonly maxChunkLength: number;

  constructor(options: SentenceChunkerOptions = {}) {
    this.minCommaChunkLength = options.minCommaChunkLength ?? 90;
    this.maxChunkLength = options.maxChunkLength ?? 220;
  }

  push(token: string): string[] {
    this.buffer += token;
    return this.drain(false);
  }

  flush(): string[] {
    return this.drain(true);
  }

  private drain(flush: boolean): string[] {
    const chunks: string[] = [];

    while (this.buffer.trim()) {
      const boundary = this.findBoundary(flush);
      if (boundary === -1) break;

      const chunk = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary).trimStart();
      if (chunk) chunks.push(chunk);
    }

    return chunks;
  }

  private findBoundary(flush: boolean): number {
    for (let index = 0; index < this.buffer.length; index += 1) {
      const character = this.buffer[index];
      const nextCharacter = this.buffer[index + 1];
      const hasBoundaryContext = nextCharacter === undefined
        ? true
        : /\s/.test(nextCharacter);

      if (/[.!?;:]/.test(character) && hasBoundaryContext) {
        return index + 1;
      }

      if (
        character === ","
        && index + 1 >= this.minCommaChunkLength
        && hasBoundaryContext
      ) {
        return index + 1;
      }
    }

    if (this.buffer.length >= this.maxChunkLength) {
      const candidate = this.buffer.slice(0, this.maxChunkLength + 1);
      const wordBoundary = candidate.lastIndexOf(" ");
      return wordBoundary > 0 ? wordBoundary : this.maxChunkLength;
    }

    return flush ? this.buffer.length : -1;
  }
}
