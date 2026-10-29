import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { decodeLink, describeError, encodeLink, listLinks, openLink, revokeLink, shortenLink } from "./commands.js";
import { TTLS } from "./short-protocol.js";
import { VERSION } from "./version.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(describeError(error)) }],
  isError: true,
});

async function guarded(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error);
  }
}

/**
 * The endpoint and the allowed hosts come from the operator's environment, never
 * from tool arguments: an agent that reads a stranger's document must not be able
 * to point this server at a host the operator did not choose.
 */
export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer({ name: "agentic-link", version: VERSION });
  // An empty variable counts as unset, as in the CLI.
  const ownerKey = env.AGENTIC_LINK_OWNER_KEY || undefined;
  const adminKey = env.AGENTIC_LINK_ADMIN_KEY || undefined;
  const allowedHosts = (env.AGENTIC_LINK_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);

  server.tool(
    "encode_link",
    "Turn a JSON snapshot for one app into a link fragment (#/v1/<app>/...). With a password the content is encrypted. The link holds the whole document.",
    {
      app: z.string().describe("App name: lower-case letters, digits, dashes."),
      payload: z.unknown().describe("The JSON document."),
      password: z.string().optional().describe("Seals the link. Send the password by another route than the link."),
      base: z.string().optional().describe("Page URL to put in front of the fragment, with no # in it."),
    },
    ({ app, payload, password, base }) => guarded(async () => ({ link: await encodeLink({ app, payload, password, base }) })),
  );

  server.tool(
    "decode_link",
    "Read a link made by encode_link and return its app, version, and payload. Every link is hostile input: size, version, and keys are checked.",
    {
      link: z.string().describe("A fragment or a full URL."),
      password: z.string().optional(),
      app: z.string().optional().describe("Refuse links for any other app."),
    },
    ({ link, password, app }) => guarded(() => decodeLink({ link, password, app })),
  );

  server.tool(
    "shorten_link",
    "Store a link as ciphertext on the configured short-link service and return a short URL. The key stays in the URL's fragment; do not log the URL.",
    {
      link: z.string().describe("The long link to shorten."),
      ttl: z.number().int().optional().describe(`Seconds to keep it: ${TTLS.join(", ")}. Default one week.`),
    },
    ({ link, ttl }) => guarded(() => shortenLink({ link, endpoint: env.AGENTIC_LINK_ENDPOINT, ttl, ownerKey })),
  );

  server.tool(
    "open_link",
    "Open a long link or a short URL and return the document. A short URL is fetched only from a host in AGENTIC_LINK_ALLOWED_HOSTS.",
    {
      link: z.string().describe("A fragment, a full URL, or a short URL."),
      password: z.string().optional(),
      app: z.string().optional(),
    },
    ({ link, password, app }) => guarded(() => openLink({ link, password, app, allowedHosts })),
  );

  server.tool(
    "revoke_link",
    "Revoke a short link you made. It answers 410 Gone from then on. Needs AGENTIC_LINK_OWNER_KEY (the key it was made with) or AGENTIC_LINK_ADMIN_KEY in the server's environment.",
    { link: z.string().describe("The short link id, or the short URL. Only the id is used.") },
    ({ link }) =>
      guarded(() =>
        revokeLink({ link, endpoint: env.AGENTIC_LINK_ENDPOINT, ownerKey, adminKey }),
      ),
  );

  server.tool(
    "list_links",
    "List the 100 short links made with AGENTIC_LINK_OWNER_KEY that expire last (all links with AGENTIC_LINK_ADMIN_KEY): id, expiry, and whether revoked. Never returns the key or the document.",
    {},
    () => guarded(() => listLinks({ endpoint: env.AGENTIC_LINK_ENDPOINT, ownerKey, adminKey })),
  );

  return server;
}

export async function startMcp(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
