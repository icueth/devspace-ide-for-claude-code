import 'highlight.js/styles/github-dark.css';

import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import ReactMarkdown from 'react-markdown';

interface MarkdownPreviewProps {
  markdown: string;
}

export function MarkdownPreview({ markdown }: MarkdownPreviewProps) {
  // `absolute inset-0` anchors the scroll container to the parent's real size —
  // a plain `h-full` loses its height when the grandparent is a shrinkable
  // flex child, breaking scrolling inside the split view.
  return (
    <div className="relative h-full w-full">
      <div className="prose prose-invert absolute inset-0 max-w-none overflow-auto px-6 py-5 text-[13.5px] leading-relaxed">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: true }]]}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}
