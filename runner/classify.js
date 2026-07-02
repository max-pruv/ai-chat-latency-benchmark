// Pure, unit-testable classifiers for the capture crawler.
// No browser / DOM / network here — just text → decision, so we can test them.

// Generation / typing indicators — must NOT be treated as a finished reply.
export const GEN_RE = /(Thinking|Analyzing|Typing|Searching|Looking|Writing|Processing|Almost there|En train|Réflexion|Analyse|Recherche|escribiendo|pensando)\s*[.…]*\s*$/i;

// STALL / acknowledgement — a provider sends "OK, let me check…" FIRST, then the real
// answer as a SECOND message. Don't stop the clock on the stall (only while still short).
export const ACK_RE = /(let me (check|look|see|find|pull|grab|dig|confirm)|one moment|just a (sec|second|moment|minute)|give me a (sec|second|moment|minute)|hold on|bear with|i'?ll (check|look|find|get|see|have a look)|looking into (it|that|this)|checking (on )?(that|this|it)|let me take a look|searching (for|our)|on it!?|right away|happy to help|great question|un instant|un moment|deux secondes|laisse[- ]?moi|je (regarde|vérifie|cherche|reviens|te reviens|te dis|m'?en occupe)|patiente)\b[\s.!?…]*$/i;

// NOT a real assistant answer — the widget is offline/reconnecting, or fell back to a
// "leave a message" / menu prompt. These must never be counted as a timed answer.
export const NOANSWER_RE = /(you'?re offline|reconnecting|leave a message|leave us a message|start a conversation|choose (an|a) (option|topic)|select an option|main menu)\s*[.!…]*\s*$/i;

// Unprompted handover to a HUMAN = the assistant bailed (a failure we measure).
// A named human agent shows as "Sébastien says:"; exclude bot self-labels
// ("AI says:", "Virtual Assistant says:") so a Zendesk/VA reply isn't misread as handover.
export const HANDOVER_PATTERNS = [
  /\bconnect you (with|to)\b/i, /\bi('|’)?ll connect you\b/i,
  /\btransfer(ring)? you (to|over)\b/i, /\btransf[eè]re(r|z)?\b.*(humain|conseiller|agent|ticket|demande)/i,
  /\bspeak (to|with) (a|an|our|one of our) (human|agent|team|representative|specialist|advisor)/i,
  /\b(submit|raise|create|open|log) a (support )?ticket\b/i,
  /\bour (team|agents?|support team) (will|can) (get back|follow up|reach out|be in touch|contact|assist)/i,
  /\ba (member|representative) of our team\b/i, /\bconseiller humain\b/i,
  /\b(fill (in|out)|complete) (the|this|a) form\b/i, /\benter your details\b/i,
  /\bshare (your|a few) (details|email|order number)\b.*(team|agent|connect|assist|follow)/i,
  /\b(joined|entered) the (chat|conversation)\b/i, /\ba rejoint (la )?(conversation|discussion|chat)\b/i,
  /\b(?!(?:ai|assistant|bot|chatbot|concierge|virtual)\b)\w+ (says|dit)\s*:/i,
  /\blaissez(\-| )?(nous|moi)?\s*(votre)?\s*(e-?mail|adresse)/i,
  /\b(leave|enter) (your|us) (e-?mail|email address)\b/i,
  /\ball of our agents are (unavailable|busy)\b/i,
];

export const isGen = (t) => GEN_RE.test((t || "").trim());
export const isAck = (t) => ACK_RE.test((t || "").trim());
export const isNoAnswer = (t) => NOANSWER_RE.test((t || "").trim());

export function detectHandover(text, extra = []) {
  if (!text) return null;
  for (const re of [...HANDOVER_PATTERNS, ...extra]) { const m = text.match(re); if (m) return m[0].trim().slice(0, 80); }
  return null;
}

// A conversation is a VALID data point iff it produced enough cleanly-timed AI answers.
// This is a LATENCY benchmark: a conversation with no measured latency is not a data
// point — even if the AI handed over. A handover with zero timed answers is still
// "no latency tracked" and is EXCLUDED as noise (chip-menu / offline / pure timeout /
// immediate bail). Handover behaviour is still reflected in the success rate of the
// conversations that DO qualify (≥ minTimed timed answers, then a handover).
export function convoValidity(turns, { minTimed = 3 } = {}) {
  turns = turns || [];
  const attempted = turns.filter((t) => !t.unsent);
  const aiAttempted = attempted.filter((t) => t.by === "ai");
  const timed = aiAttempted.filter((t) => t.complete_ms != null);
  const hadHandover = turns.some((t) => t.handover);
  const valid = timed.length >= minTimed;
  return {
    valid,
    timed: timed.length,
    aiAttempted: aiAttempted.length,
    hadHandover,
    reason: valid ? null : `only ${timed.length} timed AI answer(s) (need ${minTimed}) — no measurable latency`,
  };
}
