import { headersOf, visitorOf, type Visitor } from "../market/access";
import type { Runtime } from "./runtime";
import type { DemoSession } from "./script";
import { getRuntime, getSession, NoSessionError, peekSession, SessionLimitError } from "./session";

export type Visit = { v: Visitor; rt: Runtime; session: DemoSession | null };

/**
 * Who is asking and their session, for a route. `create: false` never makes a session for a public
 * visitor (reading the page must not cost one). A Response is the refusal to send as it is.
 */
export async function visit(request: Request, opts: { create: boolean }): Promise<Visit | Response> {
  const v = visitorOf(headersOf(request.headers));
  if (!v) return Response.json({ error: "this app does not answer on that address" }, { status: 403 });
  try {
    const rt = await getRuntime();
    const session = opts.create ? await getSession(v) : await peekSession(v);
    return { v, rt, session };
  } catch (error) {
    if (error instanceof SessionLimitError) return Response.json({ error: error.message }, { status: 503 });
    if (error instanceof NoSessionError) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
}
