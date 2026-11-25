declare module 'word-extractor' {
  export interface WordDocument {
    getBody(): string;
    getHeaders(options?: { includeFooters?: boolean }): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getTextboxes(options?: { includeBody?: boolean }): string;
  }

  export default class WordExtractor {
    extract(source: Buffer | string): Promise<WordDocument>;
  }
}
