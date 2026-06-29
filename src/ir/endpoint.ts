/**
 * Wire endpoint parsing. Endpoints are strings (see schema.ts):
 *   "P:portName"      → boundary port of the enclosing module
 *   "nodeId"          → a node's default/sole port
 *   "nodeId:portName" → a named port on a node
 */
export type Endpoint =
  | { kind: "boundary"; port: string }
  | { kind: "node"; nodeId: string; port: string | undefined };

export function parseEndpoint(raw: string): Endpoint {
  if (raw.startsWith("P:")) {
    return { kind: "boundary", port: raw.slice(2) };
  }
  const colon = raw.indexOf(":");
  if (colon === -1) {
    return { kind: "node", nodeId: raw, port: undefined };
  }
  return { kind: "node", nodeId: raw.slice(0, colon), port: raw.slice(colon + 1) };
}
