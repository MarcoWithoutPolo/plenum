import { Children, memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@/lib/api';

/** Council citations like [Claude] or [Claude, Codex] become small chips. */
const CITATION =
  /\[((?:Claude|Codex|Antigravity|Gemini|Synthesizer)(?: \([^)\]]*\))?(?:, (?:Claude|Codex|Antigravity|Gemini|Synthesizer)(?: \([^)\]]*\))?)*)\]/g;

function cite(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== 'string') return child;
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of child.matchAll(CITATION)) {
      const at = match.index ?? 0;
      if (at > last) parts.push(child.slice(last, at));
      for (const name of match[1]!.split(', ')) {
        const provider = name.split(' ')[0]!.toLowerCase();
        parts.push(
          <span
            key={`${at}-${name}`}
            className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-line bg-sunken px-1.5 align-[1px] text-[11px] font-medium text-muted"
          >
            {provider !== 'synthesizer' && (
              <span
                className="size-1.5 rounded-full"
                style={{ background: `var(--${provider})` }}
              />
            )}
            {name}
          </span>,
        );
      }
      last = at + match[0].length;
    }
    if (parts.length === 0) return child;
    if (last < child.length) parts.push(child.slice(last));
    return parts;
  });
}

const components: Components = {
  p: ({ children }) => <p>{cite(children)}</p>,
  li: ({ children }) => <li>{cite(children)}</li>,
  td: ({ children }) => <td>{cite(children)}</td>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void api().openExternal(href);
      }}
    >
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className={`prose-chat ${streaming ? 'caret' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
