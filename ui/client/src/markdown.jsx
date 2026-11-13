// Small Markdown renderer for assistant answers: paragraphs, headings, bullet and numbered lists, **bold**,
// `inline code`, and fenced code blocks. Text is rendered as React nodes, never as HTML, so answers cannot inject markup.
import { Fragment } from "react";

function inline(text, key) {
  const parts = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<Fragment key={`${key}-t${i++}`}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={`${key}-b${i++}`} className="font-semibold">{tok.slice(2, -2)}</strong>);
    else parts.push(<code key={`${key}-c${i++}`} className="rounded bg-background/70 px-1 py-px font-mono text-[12px]">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(<Fragment key={`${key}-t${i++}`}>{text.slice(last)}</Fragment>);
  return parts;
}

// Table separator row, e.g. |---|:--:| or --- | ---
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function Markdown({ text = "" }) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;
    if (/^\s*```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={key} className="overflow-x-auto rounded-md bg-background/70 p-2 font-mono text-[12px] leading-relaxed">{code.join("\n")}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push(<div key={key} className="font-semibold">{inline(h[2], key)}</div>);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-[13px]">
            <thead className="bg-background/60">
              <tr>{head.map((c, j) => <th key={j} className="border-b px-2.5 py-1.5 text-left font-semibold">{inline(c, `${key}-h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="odd:bg-background/30">
                  {head.map((_, j) => <td key={j} className="border-t px-2.5 py-1.5 align-top">{inline(r[j] ?? "", `${key}-${ri}-${j}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push(<ul key={key} className="list-disc space-y-1 pl-5">{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={key} className="list-decimal space-y-1 pl-5">{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ol>);
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para = [];
    // Always take the current line: a line that starts a block but was not recognized above (e.g. "| text" without a
    // separator row) must still be consumed, otherwise this loop never advances and the page hangs.
    para.push(lines[i++]);
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*(```|#{1,4}\s|[-*]\s|\d+[.)]\s|\|)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key} className="whitespace-pre-line">{inline(para.join("\n"), key)}</p>);
  }
  return <div className="space-y-2 break-words">{blocks}</div>;
}
