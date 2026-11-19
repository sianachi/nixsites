const courtesy = /^please(?:\s+|[,:]\s*)/iu;
const usingClause = /^using[ \t]+[^,;\r\n]{1,160},\s*/iu;
const questionRequest = /^(?:can|could|would|will)\s+you\s+/iu;
const personalRequest = /^(?:i\s+(?:need|want|would\s+like)|i['’]d\s+like)\s+you\s+to\s+/iu;
const requestedArtifact =
  /^(?:i\s+(?:need|want|would\s+like)|i['’]d\s+like)\s+an?\s+(?:(?:new|editable|simple|random)\s+)*(?:flowchart|(?:class\s+)?diagram|canvas|chart|spreadsheet|table|checklist|note|board|outline|draft)\b(?:\s+(?:that|showing|with|for|of|about|from|on)\b|[.!?]?\s*$)/iu;
const websiteRequest = /^(?:browse|read\s+the\s+page\s+at)\s+https?:\/\/[^\s/?#]+/iu;
const workCommand =
  /^(?:draw|sketch|plot|make|create|build|design|draft|write|edit|update|set|rename|organize|organise|reorganize|reorganise|arrange|sort|group|add|move|copy|delete|remove|archive|restore|file|assign|tag|link|unlink|schedule|reschedule|post|send|find|browse|research|investigate|compare|plan|look\s+up|search\s+for|map\s+out|comment\s+on|turn)\s+(\S[\s\S]*)$/iu;
const conversationObject =
  /^(?:not|how|why|what|when|where|who|whether|if|is|are|was|were|can|could|should|would|means|out\s+(?:how|why|what|when|where|who|whether|if))\b/iu;
const specificObject =
  /^(?:an?|the|this|that|these|those|my|our|it|them|linear\s+issue|[a-z]+-\d+)\b|\b(?:by|into|from|named|called|to)\s+\S/iu;

// shortcut: local routing recognizes clear English requests, ambiguous phrasing stays in chat.
export function isPetJobMessage(text: string): boolean {
  const message = text.trim().replace(courtesy, '').replace(usingClause, '');
  if (requestedArtifact.test(message)) return true;

  const politeQuestion = questionRequest.test(message);
  const command = message
    .replace(questionRequest, '')
    .replace(personalRequest, '')
    .replace(courtesy, '');
  if (websiteRequest.test(command)) return true;

  const object = workCommand.exec(command)?.[1]?.replace(/^(?:me|us)\s+/iu, '');
  return (
    object !== undefined &&
    !conversationObject.test(object) &&
    (!politeQuestion || specificObject.test(object))
  );
}
