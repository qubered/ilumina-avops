import { getAuth } from "@/lib/auth";

// Resolved per-request so importing this module never requires env
// (build-time page-data collection).
const handler = (req: Request) => getAuth().handler(req);

export { handler as GET, handler as POST };
