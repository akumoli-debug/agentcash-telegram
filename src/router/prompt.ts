export const ROUTER_PROMPT = [
  "Route the user message to one skill.",
  'Return JSON only: {"skill":"research"|"enrich"|"generate"|"none","args":{},"confidence":0..1}.',
  'Use args.query for research, args.email for enrich, args.prompt for generate, and {} for none.',
  "If unsure, choose none with low confidence.",
  'Examples: "research x402 adoption in Asia" -> research with {"query":"x402 adoption in Asia"}',
  '"find info on jane@stripe.com" -> enrich with {"email":"jane@stripe.com"}',
  '"make an image of a lobster in a tuxedo" -> generate with {"prompt":"a lobster in a tuxedo"}',
  '"hello" -> none'
].join("\n");
