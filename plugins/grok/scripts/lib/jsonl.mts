/** 改行が届くまでは断片を保持し、完成した行だけを一度連結する。 */
export class JsonlFramer {
  declare onLine: (line: string) => void;
  declare fragments: string[];
  declare closed: boolean;
  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
    this.fragments = [];
    this.closed = false;
  }

  push(chunk: string) {
    if (this.closed) return;
    let start = 0;
    let end;
    while ((end = chunk.indexOf("\n", start)) !== -1) {
      const fragment = chunk.slice(start, end);
      const line = this.fragments.length ? this.fragments.join("") + fragment : fragment;
      this.fragments = [];
      this.onLine(line);
      if (this.closed) return;
      start = end + 1;
    }
    if (start < chunk.length) this.fragments.push(chunk.slice(start));
  }

  close() {
    this.closed = true;
    this.fragments = [];
  }
}
