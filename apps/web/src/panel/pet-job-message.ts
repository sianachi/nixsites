const courtesy = /^please(?:\s+|[,:]\s*)/iu;
// An opening acknowledgement or connective ("Thanks, …", "Ok now …", "Also …") in front of a command.
// Words that also describe a noun ("Nice find", "Good plan") count only when punctuation follows.
const filler =
  /^(?:(?:(?:thanks|thank\s+you|ok|okay|yes|yep|yeah|sure|alright|right|great|nice|cool|perfect|good|and|also|now|then|so)\s*[,.!:;–—-]+|(?:thanks|thank\s+you|ok|okay|yes|yep|yeah|alright|and|also|now|then|so)\b)\s*)+/iu;
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
  /^(?:an?|the|this|that|these|those|my|our|it|them|issue|[a-z]+-\d+)\b|\b(?:by|into|from|named|called|to)\s+\S/iu;
// Fixed phrases that are remarks, not requests. Each is narrow on purpose: "make sure every task
// has a date" and "set aside 2 hours on Friday" are still work.
const remarkIdiom =
  /^(?:sort\s+of\b|copy\s+that\b|make\s+sure\s+(?:i|we)\b|make\s+sense\b|set\s+aside\s+(?:the|that|this)\s+\w+\s*[,.]|turn\s+out\b|add\s+to\s+that\s*,|find\s+it\s+(?:hard|difficult|odd|strange)\b|send\s+(?:my|our)\s+(?:regards|thanks|love|best)\s*[.!]?$|compare\s+notes\s+(?:later|tomorrow|soon)\b)/iu;
// A bare subject of up to three words, or none ("Design looks great"), then a linking verb is a
// statement, unless a condition ("where status is open") or a destination ("... to Shipped") follows.
// shortcut: a title given without a marker ("Create note Sprint went well") reads as a remark and stays in chat, a quoted title or "called …" is a job.
const remarkObject =
  /^(?:(?!["'“‘]|(?:an?|the|this|these|those|my|our|every|all|each|that|which|whichever|whatever|who|whose|where|when|if|while|as|since|so|they|for|with|to|in|on|by|into|from)\b)\S+\s+){0,3}(?:is|are|was|were|sounds?|seems?|looks|went)\b(?!.*\b(?:to|into|from|by|on|in|under|for)\s+\S)/iu;
const determiner = /^(?:an?|the|this|that|these|those|my|our|it|them)\b/iu;

// shortcut: local routing recognizes clear English requests, ambiguous phrasing stays in chat.
export function isPetJobMessage(text: string): boolean {
  const opened = text.trim();
  const afterOpener = opened.replace(filler, '');
  const message = afterOpener.replace(courtesy, '').replace(usingClause, '');
  if (requestedArtifact.test(message)) return true;

  const politeQuestion = questionRequest.test(message);
  const command = message
    .replace(questionRequest, '')
    .replace(personalRequest, '')
    .replace(courtesy, '');
  if (websiteRequest.test(command)) return true;

  if (remarkIdiom.test(command)) return false;
  const object = workCommand.exec(command)?.[1]?.replace(/^(?:me|us)\s+/iu, '');
  return (
    object !== undefined &&
    !(remarkObject.test(object) && !determiner.test(object)) &&
    !conversationObject.test(object) &&
    // Behind an opener, as behind "can you", only a pointed object is a request ("Ok, move on" is not).
    ((!politeQuestion && afterOpener === opened) || specificObject.test(object))
  );
}
