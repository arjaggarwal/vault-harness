// The to-do list, as a native job: no model call, just a parser.
//
// tasks/todo.md has an `## Open` and a `## Done` section of Markdown
// checkboxes. Sorting moves checked items to Done and orders Open by priority
// tag (#urgent, #high, none, #low), then due date (📅 2026-11-25 or
// due:2026-11-25), then original order. Indented lines under an item travel
// with it. Every line in the file survives the sort; the test checks that.

export interface Todo {
  raw: string;
  /** Indented lines that belong to this item. */
  children: string[];
  done: boolean;
  priority: number;
  due?: string;
  index: number;
}

const PRIORITY: Record<string, number> = { "#urgent": 0, "#high": 1, "#low": 3 };

function priorityOf(line: string): number {
  for (const [tag, p] of Object.entries(PRIORITY)) if (line.toLowerCase().includes(tag)) return p;
  return 2;
}

function dueOf(line: string): string | undefined {
  return line.match(/(?:📅|due:)\s*(\d{4}-\d{2}-\d{2})/)?.[1];
}

const ITEM = /^- \[( |x|X)\] /;

export function parseTodos(text: string): Todo[] {
  const out: Todo[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(ITEM);
    if (m) {
      out.push({ raw: line, children: [], done: m[1] !== " ", priority: priorityOf(line), due: dueOf(line), index: out.length });
    } else if (/^\s+\S/.test(line) && out.length > 0) {
      out[out.length - 1].children.push(line);
    }
  }
  return out;
}

export function compareTodos(a: Todo, b: Todo): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  return a.index - b.index;
}

interface Section {
  heading: string;
  lines: string[];
}

function splitSections(text: string): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  for (const line of text.replace(/\n+$/, "").split("\n")) {
    if (/^## /.test(line)) sections.push({ heading: line, lines: [] });
    else if (sections.length === 0) preamble.push(line);
    else sections[sections.length - 1].lines.push(line);
  }
  return { preamble, sections };
}

/** Items are blocks: the checkbox line plus its indented children. Other lines are kept as-is. */
function itemsAndRest(lines: string[]): { items: Todo[]; rest: string[] } {
  const items: Todo[] = [];
  const rest: string[] = [];
  for (const line of lines) {
    const m = line.match(ITEM);
    if (m) items.push({ raw: line, children: [], done: m[1] !== " ", priority: priorityOf(line), due: dueOf(line), index: items.length });
    else if (/^\s+\S/.test(line) && items.length > 0) items[items.length - 1].children.push(line);
    else if (line.trim() !== "") rest.push(line);
  }
  return { items, rest };
}

const block = (t: Todo) => [t.raw, ...t.children];

export interface SortResult {
  text: string;
  open: number;
  movedToDone: number;
  changed: boolean;
}

export function sortTodoFile(text: string): SortResult {
  const { preamble, sections } = splitSections(text);
  let open = sections.find((s) => /^## open\b/i.test(s.heading));
  let done = sections.find((s) => /^## done\b/i.test(s.heading));
  if (!open) {
    open = { heading: "## Open", lines: [] };
    sections.unshift(open);
  }
  if (!done) {
    done = { heading: "## Done", lines: [] };
    sections.push(done);
  }
  const o = itemsAndRest(open.lines);
  const d = itemsAndRest(done.lines);
  const nowDone = o.items.filter((t) => t.done);
  const stillOpen = o.items.filter((t) => !t.done).sort(compareTodos);
  const reopened = d.items.filter((t) => !t.done);
  const openItems = [...stillOpen, ...reopened.map((t, i) => ({ ...t, index: stillOpen.length + i }))].sort(compareTodos);
  const doneItems = [...nowDone, ...d.items.filter((t) => t.done)];

  open.lines = ["", ...o.rest, ...openItems.flatMap(block), ""];
  done.lines = ["", ...d.rest, ...doneItems.flatMap(block), ""];

  const out = [...preamble, ...sections.flatMap((s) => [s.heading, ...s.lines])]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
  return { text: out, open: openItems.length, movedToDone: nowDone.length, changed: out !== text };
}
