'use client';

import { Check, Copy } from 'lucide-react';
import { type ComponentProps, type ReactNode, isValidElement, useRef, useState } from 'react';

export function CodeBlock({ children, ...props }: ComponentProps<'pre'>) {
  const codeRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const language = codeBlockLanguage(children);

  async function copyCode() {
    const text = codeRef.current?.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {}
  }

  return (
    <div className="code-block">
      {language && <span className="code-language">{language}</span>}
      <button className="code-copy" onClick={() => void copyCode()} type="button">
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copiado' : 'Copiar'}
      </button>
      <pre {...props} ref={codeRef}>{children}</pre>
    </div>
  );
}

function codeBlockLanguage(node: ReactNode): string | undefined {
  if (isValidElement<{ className?: string }>(node)) {
    return node.props.className?.match(/\blanguage-([^\s]+)/)?.[1];
  }
  if (Array.isArray(node)) return node.map(codeBlockLanguage).find(Boolean);
  return undefined;
}
