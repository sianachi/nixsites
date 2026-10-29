export function paragraph(text: string): unknown {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}
