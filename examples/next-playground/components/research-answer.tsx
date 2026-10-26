import type { ResearchAnswer } from '../../research/answer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './code-block';

export function ResearchAnswerView({ answer }: { answer: ResearchAnswer }) {
  return (
    <div className="message-content">
      {answer.status === 'insufficient' && <p className="text-muted-foreground">Datos insuficientes</p>}
      <ReactMarkdown components={{ pre: CodeBlock, a: ({ children }) => <span>{children}</span> }}
        disallowedElements={['img']} remarkPlugins={[remarkGfm]}>
        {answer.answer}
      </ReactMarkdown>
      {answer.account && (
        <dl className="my-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt>Cuenta</dt><dd>{answer.account.id}</dd>
          <dt>Estado</dt><dd>{answer.account.status}</dd>
          <dt>Plan</dt><dd>{answer.account.plan}</dd>
        </dl>
      )}
      {answer.sources.length > 0 && (
        <section aria-label="Fuentes citadas" className="mt-4 border-t border-border pt-3">
          <strong className="text-sm">Fuentes citadas</strong>
          <ol className="mt-2 space-y-3">
            {answer.sources.map((source, index) => (
              <li className="break-words text-sm" key={`${source.url}-${index}`}>
                <a href={source.url} rel="noopener noreferrer" target="_blank">{source.title}</a>
                <blockquote className="mt-1 border-l-2 border-border pl-3 text-muted-foreground">{source.quote}</blockquote>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
