export interface FilterResult {
  allowed: boolean;
  reason?: string;
}

export interface ContentFilterConfig {
  /**
   * Maximum allowed message length in characters.
   * Messages exceeding this are rejected. Default: 8000.
   */
  maxLength?: number;
  /**
   * Blocklist of exact words/phrases (case-insensitive).
   * Replace at runtime via setBlocklist().
   */
  blocklist?: string[];
}

export class ContentFilter {
  private maxLength: number;
  private blocklist: string[] = [];

  constructor(config: ContentFilterConfig = {}) {
    this.maxLength = config.maxLength ?? 8_000;
    if (config.blocklist) {
      this.setBlocklist(config.blocklist);
    }
  }

  setBlocklist(words: string[]): void {
    this.blocklist = words.map((w) => w.toLowerCase());
  }

  check(text: string): FilterResult {
    if (text.length > this.maxLength) {
      return { allowed: false, reason: `message exceeds max length (${this.maxLength})` };
    }

    const lower = text.toLowerCase();
    for (const word of this.blocklist) {
      if (lower.includes(word)) {
        return { allowed: false, reason: "message contains blocked content" };
      }
    }

    return { allowed: true };
  }
}
