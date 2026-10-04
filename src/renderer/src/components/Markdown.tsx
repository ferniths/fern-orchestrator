import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { cn } from '../lib/format'

marked.setOptions({ gfm: true, breaks: true })

export function Markdown({ content, className, inline }: { content: string; className?: string; inline?: boolean }) {
  const html = useMemo(() => {
    if (!content) return ''
    try {
      const raw = marked.parse(content, { async: false }) as string
      return DOMPurify.sanitize(raw)
    } catch {
      return DOMPurify.sanitize(content.replace(/</g, '&lt;'))
    }
  }, [content])

  return (
    <div
      className={cn('markdown', className)}
      style={inline ? { all: 'unset' } : undefined}


      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
